/**
 * The language of the messages people and agents read: English by default, Chinese when the user's locale is Chinese.
 *
 * `run()` resolves it once per CLI invocation from the runtime's environment and runs the command inside that scope, so
 * every message the command builds, including those of a long-running `serve`, follows it. The scope belongs to the
 * invocation (an `AsyncLocalStorage`), not to the module: a host that runs several invocations at once in one process,
 * each with its own environment, gets each one in its own language, and code that builds a message outside `run()`
 * (a test calling a function directly) always gets English.
 *
 * Only wording changes. Codes, JSON keys, ids, error class names and exit codes are the same in both languages.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'en' | 'zh';

/** Read in this order; the first one that is set decides. `POPOST_LANG` (`en` or `zh`) overrides the locale. */
export const LANG_ENV = ['POPOST_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

/** `zh…` (`zh`, `zh_CN.UTF-8`, `zh-Hant`) means Chinese; anything else, or nothing, means English. */
export const resolveLang = (env: Readonly<Record<string, string | undefined>>): Lang => {
  for (const name of LANG_ENV) {
    const value = (env[name] ?? '').trim();
    if (value) return value.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return 'en';
};

const scope = new AsyncLocalStorage<Lang>();

/** Runs `body` with `lang` as the message language of everything it calls, including what it starts asynchronously. */
export const withLang = <T>(lang: Lang, body: () => T): T => scope.run(lang, body);

/** The message language of the current invocation; English outside `run()`. */
export const currentLang = (): Lang => scope.getStore() ?? 'en';

/** The text for the current language. Both versions carry the same facts: numbers, ids, file names, commands. */
export const msg = (en: string, zh: string): string => (currentLang() === 'zh' ? zh : en);
