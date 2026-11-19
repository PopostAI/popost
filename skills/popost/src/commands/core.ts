/**
 * Project commands of `studio.py` that do not render or call out: `init`, `page`, `design`, `concept`,
 * `import-concept`, `build`, `doctor`, `attach-template`, `attach-bundle`. Flags, JSON output and exit codes are the
 * Python Skill's; the argument parser answers `-h` and usage errors (exit 2).
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { INIT_DESIGN_NOTE, MODES, Project, type Mode } from '../core/project';
import { pyStr } from '../core/pyjson';
import { errorText, fail, printJson, sha256 } from '../core/util';
import type { CommandMain, Runtime } from '../runtime';
import { buildProject, doctor } from '../workflow/build';
import { readUserBytes } from '../workflow/io';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';
import { checkPages } from '../workflow/page-check';
import { locateSkill } from '../workflow/template-plugins';
import { selectPages } from '../render/page-select';

type Spec = Omit<CommandSpec, 'prog'>;
type ProjectRun = (project: Project, args: ParsedArgs, rt: Runtime) => Promise<number>;

const DIR = { flag: '--dir', required: true } as const;

/** A command that works on an existing project given by `--dir`. */
const onProject = (spec: Spec, run: ProjectRun): Subcommand => ({
  spec: { ...spec, options: [DIR, ...(spec.options ?? [])] },
  run: async (args, rt) => run(await Project.load(rt, args.req('dir')), args, rt),
});

const init: Subcommand = {
  spec: {
    description: 'create a project with one starter page',
    options: [
      DIR,
      { flag: '--brief', required: true },
      { flag: '--mode', default: 'original', choices: MODES },
      { flag: '--width', kind: 'int', default: 1080 },
      { flag: '--height', kind: 'int', default: 1350 },
    ],
  },
  run: async (args, rt) => {
    const mode = args.req('mode') as Mode;
    const project = await Project.create(rt, args.req('dir'), args.req('brief'), mode, args.number('width'), args.number('height'));
    await project.appendDesignNote(INIT_DESIGN_NOTE);
    printJson(rt, { ok: true, manifest: project.manifestPath, mode, pages: project.manifest.pages.map((p) => p.id) });
    return 0;
  },
};

/** `page check`: `{ok, clean, checked, problems}`; found problems are the answer (exit 0), a bad `--page` is exit 2. */
const checkCommand: ProjectRun = async (project, args, rt) => {
  try {
    const checked = selectPages(project, args.req('page'));
    const problems = await checkPages(project, checked);
    printJson(rt, { ok: true, clean: problems.length === 0, checked, problems }, true);
    return 0;
  } catch (error) {
    return fail(rt, errorText(error));
  }
};

const page = onProject(
  {
    description:
      'add a page, list the pages, or check them: `page check` finds broken page HTML without a browser (unclosed <style>, a tag that lost its "<", missing font links, files that do not exist, duplicate data-layer-id) and gives a fix hint for each',
    positionals: [{ name: 'action', choices: ['add', 'ls', 'check'] }],
    options: [
      { flag: '--id' },
      { flag: '--name' },
      { flag: '--width', kind: 'int', default: 1080 },
      { flag: '--height', kind: 'int', default: 1350 },
      { flag: '--page', default: 'all', help: 'check: all, a page id or a comma-separated list such as p1,p3' },
    ],
  },
  async (project, args, rt) => {
    if (args.req('action') === 'ls') {
      printJson(rt, { ok: true, pages: project.manifest.pages }, true);
      return 0;
    }
    if (args.req('action') === 'check') return checkCommand(project, args, rt);
    const id = args.string('id') || `p${project.manifest.pages.length + 1}`;
    const name = args.string('name') || args.string('id') || 'Page';
    printJson(rt, { ok: true, added: await project.addPage(id, name, args.number('width'), args.number('height')) });
    return 0;
  },
);

const design = onProject({ description: 'append a design note', options: [{ flag: '--note', required: true }] }, async (project, args, rt) => {
  const note = args.req('note');
  await project.appendDesignNote(note);
  printJson(rt, { ok: true, appended: note });
  return 0;
});

const concept = onProject(
  { description: 'record the enhanced prompt of the composition reference; nothing is generated', options: [{ flag: '--prompt', required: true }] },
  async (project, args, rt) => {
    if (project.manifest.mode === 'strict') return fail(rt, 'strict 模式无 concept 分支');
    if (project.manifest.concept.fixture) return fail(rt, 'reuse the one existing composition reference');
    const prompt = args.req('prompt');
    await project.setConcept('awaits_asset', prompt);
    await project.appendDesignNote(`concept enhanced prompt（写入 design.md，等待真实参考，不生图）: ${prompt}`);
    printJson(rt, { ok: true, status: 'awaits_asset', prompt });
    return 0;
  },
);

const importConcept = onProject(
  { description: 'import the composition reference image and its review', options: [{ flag: '--file', required: true }, { flag: '--review', required: true }] },
  async (project, args, rt) => {
    const entry = await project.importReference(args.req('file'), 'style', null, project.manifest.mode === 'original');
    await project.appendDesignNote(`import-concept review: ${args.req('review')}`);
    printJson(rt, { ok: true, status: 'reviewed', reference: entry });
    return 0;
  },
);

const build = onProject(
  { description: 'structural readiness checks; writes build-report.json', options: [{ flag: '--concept-off', kind: 'flag' }] },
  async (project, args, rt) => {
    const report = await buildProject(project, args.flag('concept-off'));
    printJson(rt, { ok: true, build: report }, true);
    return report.structureReady ? 0 : 2;
  },
);

const doctorCommand = onProject({ description: 'project and environment report' }, async (project, _args, rt) => {
  printJson(rt, { ok: true, doctor: await doctor(project) }, true);
  return 0;
});

const attachTemplate = onProject(
  { description: 'bind a scene Skill (template) to the project', options: [{ flag: '--path', required: true }, { flag: '--authorized', kind: 'flag' }] },
  async (project, args, rt) => {
    const path = args.req('path');
    const loc = await locateSkill(rt, path);
    if (!loc.ok) return fail(rt, loc.error);
    const version = pyStr(loc.version);
    await project.addSource('template', `${loc.skillId} v${version} sha=${loc.sha256.slice(0, 12)} refs=${loc.missingRefs.length}`);
    const source = project.manifest.sources.at(-1)!;
    Object.assign(source, { path, sha256: loc.sha256, version: loc.version, authorized: args.flag('authorized') });
    await project.appendDesignNote(`template: ${loc.skillId} v${version} (${loc.references.length} refs)`);
    await project.saveManifest();
    printJson(rt, { ok: true, attached: loc.skillId });
    return 0;
  },
);

const attachBundle = onProject(
  { description: 'record a post bundle file as a source', options: [{ flag: '--bundle', required: true }] },
  async (project, args, rt) => {
    const bundle = args.req('bundle');
    const digest = sha256(await readUserBytes(rt, bundle));
    await project.addSource('bundle-url', `bundle ${bundle} sha=${digest.slice(0, 12)}`);
    Object.assign(project.manifest.sources.at(-1)!, { bundlePath: bundle, sha256: digest });
    await project.saveManifest();
    printJson(rt, { ok: true, attached: bundle });
    return 0;
  },
);

const COMMANDS: Record<string, Subcommand> = {
  init,
  page,
  design,
  concept,
  'import-concept': importConcept,
  build,
  doctor: doctorCommand,
  'attach-template': attachTemplate,
  'attach-bundle': attachBundle,
};

export const main: CommandMain = (argv, rt) => runSubcommand('popost', COMMANDS, argv, rt);
