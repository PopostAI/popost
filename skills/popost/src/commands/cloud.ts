/**
 * `popost cloud push`: sync the project to the user's popost.ai account (the work appears in the web workbench, its
 * pictures in "My Assets"). It needs a popost key and runs synchronously; prints
 * `{"ok": true, deckId, webUrl, version, changed, pages, assets: {uploaded, reused}}`. A refusal prints
 * `{"ok": false, "error", "code"}` with exit code 2; for `DECK_CONFLICT` (the web copy was edited since the last sync)
 * `currentVersion` is added, and `--force` overwrites it.
 */
import { fail, printJson } from '../core/util';
import { CloudError } from '../cloud/errors';
import { pushProject } from '../cloud/push';
import { PopostClient } from '../providers/api';
import { PopostApiError } from '../providers/errors';
import { BrowserUnavailableError } from '../render/browser';
import type { CommandMain } from '../runtime';
import { failureText, isExpectedFailure } from '../workflow/errors';
import { runSubcommand, type Subcommand } from '../workflow/subcommands';

const push: Subcommand = {
  spec: {
    description: 'sync the project to your popost.ai account (needs a popost key); prints the web address',
    options: [
      { flag: '--dir', required: true },
      { flag: '--force', kind: 'flag', help: 'overwrite the web copy even if it was edited on the web since the last sync' },
      { flag: '--lang', choices: ['en', 'zh'], help: 'language of the web address (default: the account language)' },
    ],
  },
  run: async (args, rt) => {
    const lang = args.string('lang');
    try {
      const result = await pushProject(rt, {
        dir: args.req('dir'),
        client: new PopostClient(rt),
        force: args.flag('force'),
        locale: lang === 'en' || lang === 'zh' ? lang : undefined,
      });
      const { deckId, webUrl, version, changed, pages, assets } = result;
      printJson(rt, { ok: true, deckId, webUrl, version, changed, pages, assets });
      return 0;
    } catch (error) {
      if (error instanceof PopostApiError) {
        const current = error.details.currentVersion;
        return fail(rt, error.message, 2, { code: error.code ?? 'ERROR', ...(typeof current === 'number' ? { currentVersion: current } : {}) });
      }
      if (error instanceof CloudError) return fail(rt, error.message, 2, { code: error.code });
      if (error instanceof BrowserUnavailableError) return fail(rt, error.message);
      if (!isExpectedFailure(error)) throw error;
      return fail(rt, failureText(error));
    }
  },
};

export const main: CommandMain = (argv, rt) => runSubcommand('popost cloud', { push }, argv, rt);
