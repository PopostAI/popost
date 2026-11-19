/**
 * Project commands of `studio.py` that do not render or call out: `init`, `page`, `design`, `concept`,
 * `import-concept`, `build`, `doctor`, `attach-template`, `attach-bundle`. Flags, JSON output and exit codes are the
 * Python Skill's; the argument parser answers `-h` and usage errors (exit 2).
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { initDesignNote, MODES, Project, type Mode } from '../core/project';
import { errorText, fail, printJson, sha256 } from '../core/util';
import { msg } from '../i18n';
import type { CommandMain, Runtime } from '../runtime';
import { buildProject, doctor } from '../workflow/build';
import { readUserBytes } from '../workflow/io';
import { validateBundle } from '../workflow/post-bundle';
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

const init = (): Subcommand => ({
  spec: {
    description: msg('create a project with one starter page', '新建工程，带一个起始页'),
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
    await project.appendDesignNote(initDesignNote());
    printJson(rt, { ok: true, manifest: project.manifestPath, mode, pages: project.manifest.pages.map((p) => p.id) });
    return 0;
  },
});

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

const page = () =>
  onProject(
    {
      description: msg(
        'add a page, list the pages, or check them: `page check` finds broken page HTML without a browser (unclosed <style>, a tag that lost its "<", missing font links, files that do not exist, duplicate data-layer-id) and gives a fix hint for each',
        '添加页面、列出页面或检查页面：`page check` 不用浏览器就能找出坏掉的页面 HTML（未闭合的 <style>、丢了 "<" 的标签、缺失的字体链接、不存在的文件、重复的 data-layer-id），并给出每处的修复提示',
      ),
      positionals: [{ name: 'action', choices: ['add', 'ls', 'check'] }],
      options: [
        { flag: '--id' },
        { flag: '--name' },
        { flag: '--width', kind: 'int', default: 1080 },
        { flag: '--height', kind: 'int', default: 1350 },
        { flag: '--page', default: 'all', help: msg('check: all, a page id or a comma-separated list such as p1,p3', 'check：all、一个页 id，或逗号分隔的列表如 p1,p3') },
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

const design = () =>
  onProject({ description: msg('append a design note', '追加一条设计笔记'), options: [{ flag: '--note', required: true }] }, async (project, args, rt) => {
    const note = args.req('note');
    await project.appendDesignNote(note);
    printJson(rt, { ok: true, appended: note });
    return 0;
  });

const concept = () =>
  onProject(
    {
      description: msg('record the enhanced prompt of the composition reference; nothing is generated', '记录整组构图参考的增强提示词；不生图'),
      options: [{ flag: '--prompt', required: true }],
    },
    async (project, args, rt) => {
      if (project.manifest.mode === 'strict') return fail(rt, msg('strict mode has no concept step', 'strict 模式无 concept 分支'));
      if (project.manifest.concept.fixture) return fail(rt, msg('reuse the one existing composition reference', '请复用已有的那张整组构图参考'));
      const prompt = args.req('prompt');
      await project.setConcept('awaits_asset', prompt);
      await project.appendDesignNote(
        msg(
          `concept enhanced prompt (written to design.md; waits for a real reference, nothing generated): ${prompt}`,
          `concept enhanced prompt（写入 design.md，等待真实参考，不生图）: ${prompt}`,
        ),
      );
      printJson(rt, { ok: true, status: 'awaits_asset', prompt });
      return 0;
    },
  );

const importConcept = () =>
  onProject(
    {
      description: msg('import the composition reference image and its review', '导入整组构图参考图及其评审'),
      options: [{ flag: '--file', required: true }, { flag: '--review', required: true }],
    },
    async (project, args, rt) => {
      const entry = await project.importReference(args.req('file'), 'style', null, project.manifest.mode === 'original');
      await project.appendDesignNote(`import-concept review: ${args.req('review')}`);
      printJson(rt, { ok: true, status: 'reviewed', reference: entry });
      return 0;
    },
  );

const build = () =>
  onProject(
    { description: msg('structural readiness checks; writes build-report.json', '结构就绪检查；写出 build-report.json'), options: [{ flag: '--concept-off', kind: 'flag' }] },
    async (project, args, rt) => {
      const report = await buildProject(project, args.flag('concept-off'));
      printJson(rt, { ok: true, build: report }, true);
      return report.structureReady ? 0 : 2;
    },
  );

const doctorCommand = () =>
  onProject({ description: msg('project and environment report', '工程与环境报告') }, async (project, _args, rt) => {
    printJson(rt, { ok: true, doctor: await doctor(project) }, true);
    return 0;
  });

const attachTemplate = () =>
  onProject(
    {
      description: msg('bind a scene Skill (template) to the project', '把场景 Skill（模板）绑定到工程'),
      options: [{ flag: '--path', required: true }, { flag: '--authorized', kind: 'flag' }],
    },
    async (project, args, rt) => {
      const path = args.req('path');
      const loc = await locateSkill(rt, path);
      if (!loc.ok) return fail(rt, loc.error);
      const version = loc.version === null || loc.version === undefined ? '?' : String(loc.version);
      await project.addSource('template', `${loc.skillId} v${version} sha=${loc.sha256.slice(0, 12)} refs=${loc.missingRefs.length}`);
      const source = project.manifest.sources.at(-1)!;
      Object.assign(source, { path, sha256: loc.sha256, version: loc.version, authorized: args.flag('authorized') });
      await project.appendDesignNote(`template: ${loc.skillId} v${version} (${loc.references.length} refs)`);
      await project.saveManifest();
      printJson(rt, { ok: true, attached: loc.skillId });
      return 0;
    },
  );

/** What `validate` would refuse in this file: a bundle that cannot be read now only fails later, at build time. */
const bundleProblems = (bytes: Uint8Array): string[] => {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return [msg('not a UTF-8 JSON file', '不是 UTF-8 编码的 JSON 文件')];
  }
  return validateBundle(data)[1];
};

const attachBundle = () =>
  onProject(
    { description: msg('record a post bundle file as a source', '把帖子 bundle 文件记为素材来源'), options: [{ flag: '--bundle', required: true }] },
    async (project, args, rt) => {
      const bundle = args.req('bundle');
      const bytes = await readUserBytes(rt, bundle);
      const errors = bundleProblems(bytes);
      if (errors.length)
        return fail(
          rt,
          msg(
            `${bundle} is not a valid post bundle, nothing was attached: fix it (popost validate --file ${bundle} lists the problems), then attach it again`,
            `${bundle} 不是合法的帖子 bundle，未绑定：先修正（popost validate --file ${bundle} 会列出问题），再重新绑定`,
          ),
          2,
          { errors },
        );
      const digest = sha256(bytes);
      await project.addSource('bundle-url', `bundle ${bundle} sha=${digest.slice(0, 12)}`);
      Object.assign(project.manifest.sources.at(-1)!, { bundlePath: bundle, sha256: digest });
      await project.saveManifest();
      printJson(rt, { ok: true, attached: bundle });
      return 0;
    },
  );

const commands = (): Record<string, Subcommand> => ({
  init: init(),
  page: page(),
  design: design(),
  concept: concept(),
  'import-concept': importConcept(),
  build: build(),
  doctor: doctorCommand(),
  'attach-template': attachTemplate(),
  'attach-bundle': attachBundle(),
});

export const main: CommandMain = (argv, rt) => runSubcommand('popost', commands(), argv, rt);
