/**
 * Production commands (`workflow_cli.py`): `plan`, `series`, `reference`, `review`, `package`, `unpack`, `settings`,
 * `template-profile`. Results print as `{"ok": true, …}`; a `ValueError`, `KeyError` or OS error prints
 * `{"ok": false, "error": …}` with exit code 2, anything else (a broken project) is left to the generic handler (1).
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { Project } from '../core/project';
import { truthy } from '../core/pyjson';
import { fail, printJson, writeAtomic, writeJson } from '../core/util';
import type { CommandMain, Runtime } from '../runtime';
import { failureText, isExpectedFailure, ValueError } from '../workflow/errors';
import { readUserBytes, readUserJson } from '../workflow/io';
import { exportProject, importProject } from '../workflow/project-bundle';
import { parseAspect, planSheet } from '../workflow/composition-grid';
import { reviewPage, reviewSeries } from '../workflow/review';
import { applySettings, CHANNELS, PLATFORMS } from '../workflow/settings';
import * as seriesPlan from '../workflow/series-plan';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';
import { locateSkill } from '../workflow/template-plugins';

type Result = Record<string, unknown>;
type Spec = Omit<CommandSpec, 'prog'>;
type Run = (project: Project, args: ParsedArgs, rt: Runtime) => Promise<Result>;

const DIR = { flag: '--dir', required: true } as const;

/** Run `body`, print `{ok: true, …result}`; expected failures become `{ok: false, error}` with exit code 2. */
const reporting = (body: (args: ParsedArgs, rt: Runtime) => Promise<Result>): Subcommand['run'] => async (args, rt) => {
  try {
    printJson(rt, { ok: true, ...(await body(args, rt)) }, true);
    return 0;
  } catch (error) {
    if (!isExpectedFailure(error)) throw error;
    return fail(rt, failureText(error));
  }
};

const onProject = (spec: Spec, run: Run): Subcommand => ({
  spec: { ...spec, options: [DIR, ...(spec.options ?? [])] },
  run: reporting(async (args, rt) => run(await Project.load(rt, args.req('dir')), args, rt)),
});

const PROFILE_FILE = 'template-profile.json';

/** A scene profile the agent wrote after reading the template: concrete rules, bound to the template's hash. */
const templateProfile: Subcommand = onProject(
  { description: 'bind the design rules read from a scene Skill', options: [{ flag: '--file', required: true }] },
  async (project, args, rt) => {
    const profile = (await readUserJson(rt, args.req('file'))) as Record<string, unknown>;
    for (const field of ['skillPath', 'rules', 'pageTypes'])
      if (!truthy(profile[field])) throw new ValueError(`template profile missing ${field}`);
    const rules = profile.rules;
    if (!Array.isArray(rules) || !rules.every((rule) => typeof rule === 'string' && rule.trim()))
      throw new ValueError('template rules must be concrete text decisions');
    const loc = await locateSkill(rt, profile.skillPath as string);
    if (!loc.ok || !loc.resourcesPresent) throw new ValueError('template resources missing');
    profile.sourceHash = loc.sha256;
    await writeJson(rt, project.abs(PROFILE_FILE), profile);
    project.manifest.sources = project.manifest.sources.filter((s) => s.kind !== 'template');
    project.manifest.sources.push({ kind: 'template', path: profile.skillPath, sha256: loc.sha256, profilePath: PROFILE_FILE });
    await project.saveManifest();
    return { profile: PROFILE_FILE };
  },
);

const plan: Subcommand = onProject(
  { description: 'attach the series plan (hook, per-page increments, swipe reasons, payoff, CTA)', options: [{ flag: '--file', required: true }] },
  async (project, args, rt) => ({ path: await seriesPlan.save(project, await readUserJson(rt, args.req('file'))) }),
);

const PROMPT_FILE = 'reference/composition-prompt.md';

/** The sheet's ratio is what `image prepare` generates it at; `--aspect` designs the grid for a ratio the model supports. */
const sheetFor = (project: Project, plan: seriesPlan.Plan | null, aspect: string | undefined) => {
  if (aspect !== undefined && parseAspect(aspect) === null) throw new ValueError('--aspect must be W:H, for example 16:9 or 9:16');
  const planned = plan?.pages;
  return planSheet(project.manifest.pages, { count: Array.isArray(planned) ? planned.length : undefined, aspects: aspect === undefined ? undefined : [aspect] });
};

const series: Subcommand = onProject(
  {
    description: 'write the composition prompt; nothing is generated',
    positionals: [{ name: 'action', choices: ['prompt'] }],
    options: [{ flag: '--aspect', help: 'design the grid for this sheet ratio (W:H) instead of the best fit' }],
  },
  async (project, args) => {
    if (project.manifest.mode === 'strict') throw new ValueError('reproduction uses supplied references, no composition generation');
    const current = await seriesPlan.load(project);
    const sheet = sheetFor(project, current, args.string('aspect'));
    const prompt = seriesPlan.compositionPrompt(current, sheet);
    await writeAtomic(project.rt, project.abs(PROMPT_FILE), prompt);
    const grid = { columns: sheet.columns, rows: sheet.rows };
    Object.assign(project.manifest.concept, { status: 'awaits_asset', prompt: PROMPT_FILE, imageCount: 1, grid, aspect: sheet.aspect });
    await project.saveManifest();
    const pages = (current as seriesPlan.Plan).pages as unknown[];
    return { promptFile: project.abs(PROMPT_FILE), count: 1, panels: pages.length, generated: false, grid, aspect: sheet.aspect, pageAspect: sheet.pageAspect };
  },
);

const reference: Subcommand = onProject(
  {
    description: 'register local reference images',
    options: [
      { flag: '--file', kind: 'list', required: true },
      { flag: '--role', default: 'layout', choices: ['layout', 'style', 'identity', 'content'] },
      { flag: '--page' },
    ],
  },
  async (project, args) => {
    const references = [];
    for (const file of args.list('file')) references.push(await project.importReference(file, args.req('role'), args.string('page') ?? null));
    return { references };
  },
);

const review: Subcommand = onProject(
  {
    description: 'record real visual findings for a page, or for the whole sequence (--page series)',
    options: [{ flag: '--page', required: true }, { flag: '--note', required: true }],
  },
  async (project, args) => {
    const note = args.req('note');
    if (!note.trim()) throw new ValueError('actual visual findings are required');
    const page = args.req('page');
    return page === 'series' ? await reviewSeries(project, note) : await reviewPage(project, page, note);
  },
);

const pack: Subcommand = onProject(
  { description: 'write the portable project ZIP (default exports/project.popost.zip)', options: [{ flag: '--out' }] },
  async (project, args) => ({ zip: await exportProject(project, args.string('out')) }),
);

const unpack: Subcommand = {
  spec: { description: 'restore a project from its ZIP into a new directory', options: [{ flag: '--file', required: true }, DIR] },
  run: reporting(async (args, rt) => {
    const data = await readUserBytes(rt, args.req('file'));
    return { project: (await importProject(rt, data, args.req('dir'))).root };
  }),
};

const settings: Subcommand = onProject(
  {
    description: 'set platform, language and the image channel',
    options: [
      { flag: '--channel', choices: CHANNELS },
      { flag: '--model' },
      { flag: '--platform', choices: PLATFORMS },
      { flag: '--language' },
    ],
  },
  async (project, args) => ({
    provider: await applySettings(project, { platform: args.string('platform'), language: args.string('language'), channel: args.string('channel'), model: args.string('model') }),
  }),
);

const TABLE: Record<string, Subcommand> = {
  'template-profile': templateProfile,
  plan,
  series,
  reference,
  review,
  package: pack,
  unpack,
  settings,
};

export const main: CommandMain = (argv, rt) => runSubcommand('popost', TABLE, argv, rt);
