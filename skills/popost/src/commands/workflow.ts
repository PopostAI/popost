/**
 * Production commands (`workflow_cli.py`): `plan`, `series`, `reference`, `review`, `package`, `unpack`, `settings`,
 * `template-profile`. Results print as `{"ok": true, …}`; a `ValueError`, `KeyError` or OS error prints
 * `{"ok": false, "error": …}` with exit code 2, anything else (a broken project) is left to the generic handler (1).
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { Project } from '../core/project';
import { truthy } from '../core/pyjson';
import { fail, printJson, writeAtomic, writeJson } from '../core/util';
import { msg } from '../i18n';
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
const templateProfile = (): Subcommand => onProject(
  { description: msg('bind the design rules read from a scene Skill', '绑定从场景 Skill 读出的设计规则'), options: [{ flag: '--file', required: true }] },
  async (project, args, rt) => {
    const profile = (await readUserJson(rt, args.req('file'))) as Record<string, unknown>;
    for (const field of ['skillPath', 'rules', 'pageTypes'])
      if (!truthy(profile[field])) throw new ValueError(msg(`template profile missing ${field}`, `template profile 缺少 ${field}`));
    const rules = profile.rules;
    if (!Array.isArray(rules) || !rules.every((rule) => typeof rule === 'string' && rule.trim()))
      throw new ValueError(msg('template rules must be concrete text decisions', '模板规则必须是具体的文字决定'));
    const loc = await locateSkill(rt, profile.skillPath as string);
    if (!loc.ok || !loc.resourcesPresent) throw new ValueError(msg('template resources missing', '模板资源缺失'));
    profile.sourceHash = loc.sha256;
    await writeJson(rt, project.abs(PROFILE_FILE), profile);
    project.manifest.sources = project.manifest.sources.filter((s) => s.kind !== 'template');
    project.manifest.sources.push({ kind: 'template', path: profile.skillPath, sha256: loc.sha256, profilePath: PROFILE_FILE });
    await project.saveManifest();
    return { profile: PROFILE_FILE };
  },
);

const plan = (): Subcommand => onProject(
  {
    description: msg(
      'attach the series plan (hook, per-page increments, swipe reasons, payoff, CTA)',
      '登记整组规划（钩子、逐页增量、翻页理由、兑现、CTA）',
    ),
    options: [{ flag: '--file', required: true }],
  },
  async (project, args, rt) => ({ path: await seriesPlan.save(project, await readUserJson(rt, args.req('file'))) }),
);

const PROMPT_FILE = 'reference/composition-prompt.md';

/** The sheet's ratio is what `image prepare` generates it at; `--aspect` designs the grid for a ratio the model supports. */
const sheetFor = (project: Project, plan: seriesPlan.Plan | null, aspect: string | undefined) => {
  if (aspect !== undefined && parseAspect(aspect) === null) throw new ValueError(msg('--aspect must be W:H, for example 16:9 or 9:16', '--aspect 必须是 W:H 格式，例如 16:9 或 9:16'));
  const planned = plan?.pages;
  return planSheet(project.manifest.pages, { count: Array.isArray(planned) ? planned.length : undefined, aspects: aspect === undefined ? undefined : [aspect] });
};

const series = (): Subcommand => onProject(
  {
    description: msg('write the composition prompt; nothing is generated', '写出整组构图提示词；不会生成任何图片'),
    positionals: [{ name: 'action', choices: ['prompt'] }],
    options: [{ flag: '--aspect', help: msg('design the grid for this sheet ratio (W:H) instead of the best fit', '按这个参考图比例（W:H）设计网格，而不是自动选最合适的比例') }],
  },
  async (project, args) => {
    if (project.manifest.mode === 'strict')
      throw new ValueError(msg('reproduction uses supplied references, no composition generation', '复刻使用提供的参考图，不生成构图参考'));
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

const reference = (): Subcommand => onProject(
  {
    description: msg('register local reference images', '登记本地参考图'),
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

const review = (): Subcommand => onProject(
  {
    description: msg('record real visual findings for a page, or for the whole sequence (--page series)', '记录单页或整组（--page series）的真实视觉评审结论'),
    options: [{ flag: '--page', required: true }, { flag: '--note', required: true }],
  },
  async (project, args) => {
    const note = args.req('note');
    if (!note.trim()) throw new ValueError(msg('actual visual findings are required', '必须填写实际的视觉评审结论'));
    const page = args.req('page');
    return page === 'series' ? await reviewSeries(project, note) : await reviewPage(project, page, note);
  },
);

const pack = (): Subcommand => onProject(
  { description: msg('write the portable project ZIP (default exports/project.popost.zip)', '写出可移植的工程 ZIP（默认 exports/project.popost.zip）'), options: [{ flag: '--out' }] },
  async (project, args) => ({ zip: await exportProject(project, args.string('out')) }),
);

const unpack = (): Subcommand => ({
  spec: { description: msg('restore a project from its ZIP into a new directory', '把工程 ZIP 还原到一个新目录'), options: [{ flag: '--file', required: true }, DIR] },
  run: reporting(async (args, rt) => {
    const data = await readUserBytes(rt, args.req('file'));
    return { project: (await importProject(rt, data, args.req('dir'))).root };
  }),
});

const settings = (): Subcommand => onProject(
  {
    description: msg('set platform, language and the image channel', '设置平台、语言和生图渠道'),
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

const table = (): Record<string, Subcommand> => ({
  'template-profile': templateProfile(),
  plan: plan(),
  series: series(),
  reference: reference(),
  review: review(),
  package: pack(),
  unpack: unpack(),
  settings: settings(),
});

export const main: CommandMain = (argv, rt) => runSubcommand('popost', table(), argv, rt);
