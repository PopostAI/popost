/**
 * `render`, `export`, `serve` and `present` of `studio.py`: page PNGs, the PNG ZIP, the local editor service and the hand-off
 * of the project to an editor. Flags, JSON output and exit codes are the Python Skill's.
 */
import type { CommandSpec, ParsedArgs } from '../args';
import { Project } from '../core/project';
import { errorText, fail, printJson } from '../core/util';
import { msg } from '../i18n';
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
const force = () => ({ flag: '--force', kind: 'flag', help: msg('rerender changed renderer output; review it again', '重新渲染渲染器输出有变化的页面；之后要重新评审') }) as const;

/** Python's `ValueError`: hosts tell input errors apart by this name. */
class ValueError extends Error {
  override name = 'ValueError';
}

/** `--final`: refuse to export while the delivery checks are not all met. */
const requireReadyToDeliver = async (project: Project): Promise<void> => {
  if (!(await buildProject(project)).readyToDeliver)
    throw new ValueError(msg('final delivery checks pending; inspect build-report.json', '最终交付检查尚未全部通过；请查看 build-report.json'));
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
  if (pids.length > 1 && out) throw new ValueError(msg('--out goes with one page or all, not with a list of pages', '--out 只能配合单页或 all 使用，不能配合页面列表'));
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

const render = () =>
  rendering(
    {
      description: msg(
        'render the pages to PNG in one browser session: exports/<page>.png for one page, exports/all.zip for all; --page takes all, one id or a list (p1,p3). Only changed pages are rendered ("rendered"; the others are "unchanged"). First restores font links a rewritten page lost and reports page problems ("problems", see popost page check)',
        '在一个浏览器会话里把页面渲染成 PNG：单页输出 exports/<page>.png，全部输出 exports/all.zip；--page 取 all、一个 id 或列表（p1,p3）。只渲染有变化的页面（"rendered"；其余为 "unchanged"）。渲染前先补回被改写页面丢失的字体链接，并报告页面问题（"problems"，见 popost page check）',
      ),
      options: [{ flag: '--page', default: 'all', help: msg('all, a page id or a comma-separated list such as p1,p3', 'all、一个页 id，或逗号分隔的列表如 p1,p3') }, force()],
    },
    true,
  );

const exportCommand = () =>
  rendering({
    description: msg('export one page as PNG or all pages as a ZIP', '把单页导出为 PNG，或把全部页面导出为 ZIP'),
    options: [
      { flag: '--page', required: true, help: msg('a page id, a comma-separated list (p1,p3) or all', '页 id、逗号分隔的列表（p1,p3）或 all') },
      { flag: '--out' },
      { flag: '--final', kind: 'flag', help: msg('require current visual and series review', '要求当前版本已通过单页和整组评审') },
      force(),
    ],
  });

const cloudOption = () =>
  ({
    flag: '--cloud',
    default: 'auto',
    choices: ['auto', 'off'],
    help: msg(
      'auto: open the cloud workbench with a key, or open the local editor with Save to Cloud; off: local only',
      'auto：有 Key 时打开云端工作台，否则打开带“保存到云端”的本地编辑器；off：只用本地',
    ),
  }) as const;
const serveCloudOption = () =>
  ({
    ...cloudOption(),
    choices: ['auto', 'login', 'off'],
    help: msg(
      'auto: sync with a key or browser login; login: browser login only; off: no cloud save',
      'auto：用 Key 或浏览器登录同步；login：只用浏览器登录；off：不保存到云端',
    ),
  }) as const;

const serve = (): Subcommand => ({
  spec: {
    description: msg('run the local editor service on loopback', '在本机回环地址上运行本地编辑器服务'),
    options: [DIR, { flag: '--port', kind: 'int', default: 8765 }, serveCloudOption()],
  },
  run: async (args, rt) =>
    serveProject(rt, await Project.load(rt, args.req('dir')), args.number('port') ?? 8765, {
      enabled: args.req('cloud') !== 'off',
      loginOnly: args.req('cloud') === 'login',
    }),
});

const presentCommand = (): Subcommand => ({
  spec: {
    description: msg(
      "open the project in an editor: the host's own, Popost's cloud workbench, or the local editor",
      '在编辑器里打开工程：宿主自带的编辑器、Popost 云端工作台，或本地编辑器',
    ),
    options: [
      DIR,
      { flag: '--host', default: 'auto', help: msg('codex, claude-code, workbuddy, doubao, generic, web or auto', 'codex、claude-code、workbuddy、doubao、generic、web 或 auto') },
      { flag: '--port', kind: 'int', default: 0, help: msg('0 finds a free loopback port', '0 表示自动找一个空闲的本机端口') },
      cloudOption(),
    ],
  },
  run: async (args, rt) => {
    const project = await Project.load(rt, args.req('dir'));
    try {
      const result = await present(rt, project, args.req('host'), args.number('port') ?? 0, args.req('cloud') !== 'off');
      printJson(rt, result, true);
      return result.ok === false ? 2 : 0;
    } catch (error) {
      return fail(rt, errorText(error));
    }
  },
});

const commands = (): Record<string, Subcommand> => ({ render: render(), export: exportCommand(), serve: serve(), present: presentCommand() });

export const main: CommandMain = (argv, rt) => runSubcommand('popost', commands(), argv, rt);
