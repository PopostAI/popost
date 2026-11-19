/**
 * `popost deck export|import`: the project as one editor document and back (the popost.ai workbench stores a deck as that
 * document). The conversion is the editor's own compile, run in Chromium; see `deck/`. Results print as `{"ok": true, …}`; a
 * bad document, a page the editor cannot compile or a missing file prints `{"ok": false, "error": …}` with exit code 2, a
 * directory that is not a project is left to the generic handler (1).
 */
import { fail, printJson } from '../core/util';
import { exportDeck } from '../deck/export-deck';
import { importDeck } from '../deck/import-deck';
import { BrowserUnavailableError } from '../render/browser';
import { msg } from '../i18n';
import type { CommandMain, Runtime } from '../runtime';
import { failureText, isExpectedFailure } from '../workflow/errors';
import { readUserText } from '../workflow/io';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';
import type { ParsedArgs } from '../args';

const DIR = { flag: '--dir', required: true } as const;

type Body = (args: ParsedArgs, rt: Runtime) => Promise<void>;

/** Run `body`; expected failures (and a missing browser, which the user can fix) become `{ok: false, error}`, exit 2. */
const reporting =
  (body: Body): Subcommand['run'] =>
  async (args, rt) => {
    try {
      await body(args, rt);
      return 0;
    } catch (error) {
      if (error instanceof BrowserUnavailableError) return fail(rt, error.message);
      if (!isExpectedFailure(error)) throw error;
      return fail(rt, failureText(error));
    }
  };

const exportCommand = (): Subcommand => ({
  spec: {
    description: msg(
      'write the project as one editor document (top-level .slide[data-popost-page] pages)',
      '把工程写成一个编辑器文档（顶层的 .slide[data-popost-page] 页面）',
    ),
    options: [DIR, { flag: '--out', help: msg('default <dir>/exports/deck.html', '默认 <dir>/exports/deck.html') }],
  },
  run: reporting(async (args, rt) => {
    const out = args.string('out');
    const result = await exportDeck(rt, args.req('dir'), { out });
    // like `render`: a path the user typed is printed as typed, a default one in full
    printJson(rt, { ok: true, file: out ?? result.file, pages: result.pages });
  }),
});

const importCommand = (): Subcommand => ({
  spec: {
    description: msg(
      'bring an edited editor document back into the project (changed pages lose their review and render)',
      '把编辑过的编辑器文档导回工程（有改动的页面会失去评审和渲染结果）',
    ),
    options: [{ flag: '--file', required: true, help: msg('the editor document', '编辑器文档') }, DIR],
  },
  run: reporting(async (args, rt) => {
    const html = await readUserText(rt, args.req('file'));
    printJson(rt, { ok: true, ...(await importDeck(rt, args.req('dir'), html)) });
  }),
});

export const main: CommandMain = (argv, rt) => runSubcommand('popost deck', { export: exportCommand(), import: importCommand() }, argv, rt);
