/**
 * `render`, `export`, `serve` and `present` of `studio.py`: page PNGs, the PNG ZIP, the local editor service and the hand-off
 * of the project to an editor. Flags, JSON output and exit codes are the Python Skill's.
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { Project } from '../core/project';
import { errorText, fail, printJson } from '../core/util';
import { present } from '../editor/handoff';
import { serveProject } from '../editor/server';
import { selectPages } from '../render/page-select';
import { exportAllReport, renderPages } from '../render/png';
import type { CommandMain, Runtime } from '../runtime';
import { linkInstalledFonts } from '../fonts/project-fonts';
import { buildProject } from '../workflow/build';
import { checkPages } from '../workflow/page-check';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';

type Spec = Omit<CommandSpec, 'prog'>;

const DIR = { flag: '--dir', required: true } as const;
const FORCE = { flag: '--force', kind: 'flag', help: 'rerender changed renderer output; review it again' } as const;

/** Python's `ValueError`, whose name is part of the error text agents see. */
class ValueError extends Error {
  override name = 'ValueError';
}

/** `--final`: refuse to export while the delivery checks are not all met. */
const requireReadyToDeliver = async (project: Project): Promise<void> => {
  if (!(await buildProject(project)).readyToDeliver)
    throw new ValueError('final delivery checks pending; inspect build-report.json');
};

/**
 * Render one page (`png`), all of them (`exported`: the ZIP) or a list (`pngs`), all in one browser session. `rendered` and
 * `unchanged` say which pages were screenshotted now and which came from their receipt. `--out` is printed as the user wrote it.
 */
const exportPages = async (project: Project, args: ParsedArgs, rt: Runtime): Promise<Record<string, unknown>> => {
  const page = args.req('page');
  const out = args.string('out');
  const target = out ? rt.path.resolve(rt.cwd, out) : undefined;
  const force = args.flag('force');
  const pids = selectPages(project, page);
  if (page === 'all') {
    const { zip, rendered, unchanged } = await exportAllReport(project, target, force);
    return { ok: true, exported: out ?? zip, rendered, unchanged };
  }
  if (pids.length > 1 && out) throw new ValueError('--out goes with one page or all, not with a list of pages');
  const pid = pids[0]!;
  const { paths, rendered, unchanged } = await renderPages(project, pids, target ? { [pid]: target } : {}, force);
  return pids.length === 1 ? { ok: true, png: out ?? paths[pid], rendered, unchanged } : { ok: true, pngs: paths, rendered, unchanged };
};

/**
 * What `render` does before it renders: put back the font links a rewritten page lost, then check the pages without a
 * browser. Both go into the output (`fontLinksRestored`, `problems`), so the agent never inspects the files itself.
 */
const prepareRender = async (project: Project, args: ParsedArgs): Promise<Record<string, unknown>> => {
  const pids = selectPages(project, args.req('page'));
  const { linked, failed } = await linkInstalledFonts(project, pids);
  const problems = await checkPages(project, pids);
  return {
    ...(linked.length ? { fontLinksRestored: linked } : {}),
    ...(failed ? { fontLinksFailed: failed } : {}),
    ...(problems.length ? { problems } : {}),
  };
};

/**
 * A command that renders: the project loads first (a bad project is a crash, exit 1), then any failure is `{ok:false}` / 2.
 * With `prepare`, the pages are checked and their font links restored first (`render`; `export` leaves the pages alone).
 */
const rendering = (spec: Spec, prepare = false): Subcommand => ({
  spec: { ...spec, options: [DIR, ...(spec.options ?? [])] },
  run: async (args, rt) => {
    const project = await Project.load(rt, args.req('dir'));
    let before: Record<string, unknown> = {};
    try {
      if (prepare) before = await prepareRender(project, args);
      if (args.flag('final')) await requireReadyToDeliver(project);
      printJson(rt, { ...(await exportPages(project, args, rt)), ...before });
      return 0;
    } catch (error) {
      return fail(rt, errorText(error), 2, before);
    }
  },
});

const render = rendering(
  {
    description:
      'render the pages to PNG in one browser session: exports/<page>.png for one page, exports/all.zip for all; --page takes all, one id or a list (p1,p3). Only changed pages are rendered ("rendered"; the others are "unchanged"). First restores font links a rewritten page lost and reports page problems ("problems", see popost page check)',
    options: [{ flag: '--page', default: 'all', help: 'all, a page id or a comma-separated list such as p1,p3' }, FORCE],
  },
  true,
);

const exportCommand = rendering({
  description: 'export one page as PNG or all pages as a ZIP',
  options: [
    { flag: '--page', required: true, help: '页 id、逗号分隔的列表（p1,p3）或 all' },
    { flag: '--out' },
    { flag: '--final', kind: 'flag', help: 'require current visual and series review' },
    FORCE,
  ],
});

const CLOUD = { flag: '--cloud', default: 'auto', choices: ['auto', 'off'], help: 'auto: open the cloud workbench with a key, or open the local editor with Save to Cloud; off: local only' } as const;
const SERVE_CLOUD = { ...CLOUD, choices: ['auto', 'login', 'off'], help: 'auto: sync with a key or browser login; login: browser login only; off: no cloud save' } as const;

const serve: Subcommand = {
  spec: {
    description: 'run the local editor service on loopback',
    options: [DIR, { flag: '--port', kind: 'int', default: 8765 }, SERVE_CLOUD],
  },
  run: async (args, rt) =>
    serveProject(rt, await Project.load(rt, args.req('dir')), args.number('port') ?? 8765, {
      enabled: args.req('cloud') !== 'off',
      loginOnly: args.req('cloud') === 'login',
    }),
};

const presentCommand: Subcommand = {
  spec: {
    description: "open the project in an editor: the host's own, Popost's cloud workbench, or the local editor",
    options: [
      DIR,
      { flag: '--host', default: 'auto', help: 'codex, claude-code, workbuddy, doubao, generic, web or auto' },
      { flag: '--port', kind: 'int', default: 0, help: '0 finds a free loopback port' },
      CLOUD,
    ],
  },
  run: async (args, rt) => {
    const project = await Project.load(rt, args.req('dir'));
    try {
      const result = await present(rt, project, args.req('host'), args.number('port') ?? 0, args.req('cloud') !== 'off');
      printJson(rt, result, true);
      return result.ok === false ? 2 : 0;
    } catch (error) {
      return fail(rt, error instanceof Error ? error.message : String(error));
    }
  },
};

const COMMANDS: Record<string, Subcommand> = { render, export: exportCommand, serve, present: presentCommand };

export const main: CommandMain = (argv, rt) => runSubcommand('popost', COMMANDS, argv, rt);
