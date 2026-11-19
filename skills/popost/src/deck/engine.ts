/**
 * The converter's browser side. The editor's `compileProject` / `splitProject` need a real DOM and CSSOM, so they run in
 * Chromium: the committed bundle (`compile-bundle.ts`, built by `bundles/build-deck.mjs`) is the only thing the page holds.
 *
 * Project HTML never runs. It reaches the page as text and only `DOMParser` reads it (parsed documents have no browsing
 * context, so scripts, handlers and subresources in them are inert); the page is never navigated to a project file. Page
 * JavaScript has to be on for the bundle, so the boundary is the network and the disk: the context is the offline sandbox of
 * `render/offline.ts` (every request answered from `rt.fs` under `http://popost.local/` or aborted, no host names resolve),
 * the bundle's page carries a CSP of `default-src 'none'`, and stylesheets reach the bundle through a host function that
 * reads the project's own files.
 */
import type { Page, Route } from 'playwright-core';
import { ValueError } from '../core/errors';
import { openOfflineContext, PROJECT_ORIGIN, readProjectFile, callInPage, withBrowser } from '../render/offline';
import type { Runtime } from '../runtime';
import { DECK_BUNDLE } from './compile-bundle';
import type { DeckEngine, DeckPage, DeckPreviousPage, DeckSession, DeckSize, DeckSplit } from './types';

const PAGE_PATH = '/__popost-deck__.html';
const SCRIPT_PATH = '/__popost-deck__.js';
const READ_STYLESHEET = '__popostReadStylesheet';

/**
 * Nothing but the bundle may run, and nothing may be fetched. `style-src 'unsafe-inline'` is needed for correctness, not
 * convenience: DOMParser documents inherit the page's policy, and a policy that blocks inline styles makes the editor code
 * (which edits `element.style`) see the parsed `style="…"` attributes as empty and rewrite them without what they said.
 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'";

const ENGINE_FILES: Readonly<Record<string, { contentType: string; body: string }>> = {
  [PAGE_PATH]: {
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><title>popost deck</title><script src="${SCRIPT_PATH}"></script>`,
  },
  [SCRIPT_PATH]: { contentType: 'text/javascript; charset=utf-8', body: DECK_BUNDLE },
};

const isEngineFile = (url: URL): boolean => url.origin === PROJECT_ORIGIN && Object.hasOwn(ENGINE_FILES, url.pathname);

const serveEngineFile = (route: Route): Promise<void> => {
  const file = ENGINE_FILES[new URL(route.request().url()).pathname]!;
  return route.fulfill({
    status: 200,
    contentType: file.contentType,
    headers: { 'cache-control': 'no-store', 'content-security-policy': CSP },
    body: file.body,
  });
};

/** The text of a stylesheet of the project, asked for by URL; anything else is an error the converter reports. */
const readStylesheet = async (rt: Runtime, root: string, href: string): Promise<string> => {
  const url = new URL(href);
  const file = url.origin === PROJECT_ORIGIN ? await readProjectFile(rt, root, url.pathname) : null;
  if (!file) throw new Error(`stylesheet not found in the project: ${url.pathname} (installed fonts are linked as ../css/<role>.css, listed in fonts-manifest.json)`);
  return new TextDecoder().decode(file.data);
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** One call of the bundle; a failure inside it (a page the editor cannot compile, a missing stylesheet) is a `ValueError`. */
const call = async <T>(page: Page, method: 'compile' | 'split' | 'baseline', args: readonly unknown[]): Promise<T> => {
  const outcome = await callInPage<Outcome<T>>(page, `async (args) => window.__popostDeck.${method}(...args)`, args);
  if (!outcome.ok) throw new ValueError(outcome.error);
  return outcome.value;
};

const pageEngine = (page: Page): DeckEngine => ({
  compile: (pages: readonly DeckPage[]) => call<string>(page, 'compile', [pages, PROJECT_ORIGIN]),
  split: (content: string, previousPages: readonly DeckPreviousPage[], defaultSize: DeckSize) =>
    call<DeckSplit>(page, 'split', [content, previousPages, defaultSize]),
  baseline: (pages: readonly DeckPage[]) =>
    call<Record<string, readonly string[] | null>>(page, 'baseline', [pages, PROJECT_ORIGIN]),
});

/**
 * A session over Chromium (`rt.launchBrowser`) for the project at `root`. The browser is closed when `fn` ends and at once
 * when the host aborts the command (`rt.signal`).
 */
export const chromeSession =
  (rt: Runtime, root: string): DeckSession =>
  (fn) =>
    withBrowser(rt, async (browser) => {
      const { context } = await openOfflineContext(rt, browser, root, { scale: 1, scripts: true });
      try {
        // Registered after the sandbox's own handler, so it answers first: the bundle's page is not a project file.
        await context.route(isEngineFile, serveEngineFile);
        const page = await context.newPage();
        await page.exposeFunction(READ_STYLESHEET, (href: string) => readStylesheet(rt, root, href));
        await page.goto(`${PROJECT_ORIGIN}${PAGE_PATH}`, { waitUntil: 'load', timeout: 30_000 });
        return await fn(pageEngine(page));
      } finally {
        await context.close();
      }
    });
