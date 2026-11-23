/**
 * `popost <command> …`: the command table of the Python `studio.py`, same names, flags, JSON output and exit codes.
 * Each group lives in its own module under `commands/` and exports a `CommandMain`.
 */
import type { CommandMain, Runtime } from './runtime';
import { errorText, printJson } from './core/util';
import { msg, resolveLang, withLang } from './i18n';
import { VERSION } from './version';

type Loader = () => Promise<CommandMain>;

/** Command name → the module that handles it, and whether that module receives the command name in argv. */
const GROUPS: Record<string, { load: Loader; keepName: boolean }> = {};
const register = (names: readonly string[], load: Loader, keepName: boolean) => {
  for (const name of names) GROUPS[name] = { load, keepName };
};

register(
  ['init', 'page', 'design', 'concept', 'import-concept', 'build', 'doctor', 'attach-template', 'attach-bundle'],
  async () => (await import('./commands/core')).main,
  true,
);
register(
  ['plan', 'series', 'reference', 'review', 'package', 'unpack', 'settings', 'template-profile'],
  async () => (await import('./commands/workflow')).main,
  true,
);
register(['auth'], async () => (await import('./commands/auth')).main, false);
register(['install'], async () => (await import('./commands/install')).main, false);
register(['setup'], async () => (await import('./commands/setup')).main, false);
register(['render', 'export', 'serve', 'present'], async () => (await import('./commands/render')).main, true);
register(['sheet'], async () => (await import('./commands/sheet')).main, true);
register(['font'], async () => (await import('./commands/font')).main, false);
register(['image'], async () => (await import('./commands/image')).main, false);
register(['provider'], async () => (await import('./commands/provider')).main, false);
register(['inspiration'], async () => (await import('./commands/inspiration')).main, false);
register(['pricing'], async () => (await import('./commands/pricing')).main, false);
register(['account'], async () => (await import('./commands/account')).main, false);
register(['link'], async () => (await import('./commands/link')).main, false);
register(['template'], async () => (await import('./commands/template')).main, false);
register(['cloud'], async () => (await import('./commands/cloud')).main, false);
register(['deck'], async () => (await import('./commands/deck')).main, false);
register(['video'], async () => (await import('./commands/video')).main, false);
register(['ticket', 'validate', 'import'], async () => (await import('./commands/post-bundle')).main, true);

const usage = () =>
  msg(
    [
      `popost ${VERSION}: create, reproduce and edit social media image posts as editable HTML projects.`,
      '',
      'usage: popost <command> [options]   (popost <command> --help for its options)',
      '',
      'install:   install (the Skill into your coding agents), auth (the popost.ai API key: set, status, clear)',
      'project:   setup, init, page, settings, plan, series, reference, design, template-profile, attach-template',
      'images:    image (prepare, quote, run, complete, status, info), provider, concept, import-concept',
      'fonts:     font',
      'review:    render, sheet, review, build, doctor, export, package, unpack',
      'editor:    present, serve, deck, cloud (push the project to your popost.ai account)',
      'sources:   ticket, validate, import, attach-bundle, link, inspiration, template',
      'account:   account (credit balance and plan), pricing (current link tariff; no charge)',
      'video:     video (videos as editable projects; popost video --help lists its commands)',
      '',
    ].join('\n'),
    [
      `popost ${VERSION}：把社媒图文帖做成可编辑的 HTML 工程，支持新建、复刻和编辑。`,
      '',
      'usage: popost <command> [options]   （popost <command> --help 查看该命令的选项）',
      '',
      '安装:      install（把 Skill 装进编程 Agent）、auth（popost.ai API Key：set、status、clear）',
      '工程:      setup、init、page、settings、plan、series、reference、design、template-profile、attach-template',
      '图片:      image（prepare、quote、run、complete、status、info）、provider、concept、import-concept',
      '字体:      font',
      '检查:      render、sheet、review、build、doctor、export、package、unpack',
      '编辑器:    present、serve、deck、cloud（把工程推送到 popost.ai 账户）',
      '素材来源:  ticket、validate、import、attach-bundle、link、inspiration、template',
      '账户:      account（积分余额和套餐）、pricing（当前链接解析价格；不扣费）',
      '视频:      video（把视频做成可编辑的工程；popost video --help 列出它的命令）',
      '',
    ].join('\n'),
  );

/**
 * Run one CLI invocation; returns the exit code. Never throws: an unexpected error is reported as JSON, exit 1. Messages
 * are in the language of `rt.env` (`i18n.ts`) for this invocation only.
 */
export const run = (argv: readonly string[], rt: Runtime): Promise<number> =>
  withLang(resolveLang(rt.env), () => runCommand(argv, rt));

const runCommand = async (argv: readonly string[], rt: Runtime): Promise<number> => {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    rt.stdout(usage());
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-V' || name === 'version') {
    rt.stdout(`${VERSION}\n`);
    return 0;
  }
  const group = GROUPS[name];
  if (!group) {
    rt.stderr(`${msg(`popost: error: unknown command '${name}'`, `popost: error: 未知命令 '${name}'`)}\n${usage()}`);
    return 2;
  }
  try {
    const main = await group.load();
    return await main(group.keepName ? argv : rest, rt);
  } catch (error) {
    printJson(rt, { ok: false, error: errorText(error) });
    return 1;
  }
};
