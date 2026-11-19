/**
 * The offline page sandbox. Pages are model-written HTML, so rendering them must never reach the network or read files
 * outside the project: the project tree is served to the browser from `rt.fs` under a fixed origin through request
 * interception, and every other request is aborted (and recorded). Scripts are off as well, so nothing in a page can open a
 * socket the interception does not see (`scripts` is for the deck converter, whose page holds only its own bundle).
 * Both the real disk and a host's virtual disk render the same way.
 */
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import type { Runtime } from '../runtime';
import { isFile, isInside } from '../core/util';
import { mimeType } from './mime';

/** Nothing resolves this name: pages see it only because every request to it is answered from the project. */
export const PROJECT_ORIGIN = 'http://popost.local';

export interface OfflineSession {
  readonly context: BrowserContext;
  /** URLs the page asked for and the sandbox refused, in request order. */
  readonly blocked: string[];
}

export interface OfflineOptions {
  /** Device pixel ratio: 1 for deliverable PNGs. */
  readonly scale: number;
  /**
   * Run page JavaScript. Off for every page that shows project HTML. `popost deck` turns it on for a page that contains only
   * its own bundle; the network boundary below is the same either way.
   */
  readonly scripts?: boolean;
}

/** The bytes of the project file a URL path names, or `null` when it is missing or outside `root`. */
export const readProjectFile = async (
  rt: Runtime,
  root: string,
  urlPath: string,
): Promise<{ data: Uint8Array; path: string } | null> => {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath).replace(/^[/\\]+/, '');
  } catch {
    return null;
  }
  if (!relative || relative.includes('\0')) return null;
  const path = rt.path.resolve(root, relative);
  if (!isInside(rt, root, path) || !(await isFile(rt, path))) return null;
  if (rt.fs.realpath) {
    try {
      const [realRoot, realFile] = await Promise.all([rt.fs.realpath(root), rt.fs.realpath(path)]);
      if (!isInside(rt, realRoot, realFile)) return null;
      return { data: await rt.fs.readFile(realFile), path };
    } catch {
      return null;
    }
  }
  return { data: await rt.fs.readFile(path), path };
};

const respond = async (rt: Runtime, root: string, blocked: string[], route: Route): Promise<void> => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.protocol === 'data:' || url.protocol === 'about:') return route.continue();
  const read = request.method() === 'GET' || request.method() === 'HEAD';
  if (url.origin !== PROJECT_ORIGIN || !read) {
    blocked.push(request.url());
    return route.abort('blockedbyclient');
  }
  const file = await readProjectFile(rt, root, url.pathname);
  if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  return route.fulfill({
    status: 200,
    contentType: mimeType(file.path),
    headers: { 'cache-control': 'no-store' },
    body: Buffer.from(file.data),
  });
};

/** A browser context that can only see `root`: see the module comment. */
export const openOfflineContext = async (
  rt: Runtime,
  browser: Browser,
  root: string,
  options: OfflineOptions,
): Promise<OfflineSession> => {
  const context = await browser.newContext({
    deviceScaleFactor: options.scale,
    javaScriptEnabled: options.scripts === true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const blocked: string[] = [];
  await context.route('**/*', (route) =>
    respond(rt, root, blocked, route).catch(() => {
      // a file the host could not read counts as unreachable, never as a hung request
      blocked.push(route.request().url());
      return route.abort('failed').catch(() => undefined);
    }),
  );
  return { context, blocked };
};

/**
 * A browser for `fn`, closed afterwards, and at once when the host aborts the command (`rt.signal`): a render that is
 * stuck must not keep a Chrome alive after its turn has ended.
 */
export const withBrowser = async <T>(rt: Runtime, fn: (browser: Browser) => Promise<T>): Promise<T> => {
  rt.signal?.throwIfAborted();
  const browser = await rt.launchBrowser();
  const abort = () => void browser.close().catch(() => undefined);
  rt.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fn(browser);
  } finally {
    rt.signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => undefined);
  }
};

/** The URL a project-relative path (forward slashes) has inside the sandbox. */
export const projectUrl = (relPath: string): string =>
  `${PROJECT_ORIGIN}/${relPath.split('/').map(encodeURIComponent).join('/')}`;

// In-page code is shipped as text: bundlers may rewrite functions that are passed to the browser by reference. Playwright's
// JavaScript client evaluates a string as an expression (it does not call a function written as a string), so the code is
// wrapped into a call. Page scripts are off in this context; evaluation through the browser's own channel still works.
const SETTLE_SCRIPT = `async () => {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map((i) => (i.decode ? i.decode().catch(() => null) : null)));
}`;

/** Run `functionSource` (a function expression as text) in the page with one JSON argument, and return its result. */
export const callInPage = async <T>(page: Page, functionSource: string, arg?: unknown): Promise<T> =>
  (await page.evaluate(`(${functionSource})(${arg === undefined ? '' : JSON.stringify(arg)})`)) as T;

/** Wait until the page's fonts are ready and its images are decoded. */
export const settlePage = async (page: Page): Promise<void> => {
  await callInPage(page, SETTLE_SCRIPT);
};

/** Open a project page at its canvas size and wait until its fonts and images are ready. */
export const loadPage = async (page: Page, relPath: string, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  await page.goto(projectUrl(relPath), { waitUntil: 'load', timeout: 30_000 });
  await settlePage(page);
};

/** True when some `<img>` has no decodable bitmap: a missing file, a blocked external URL or a corrupt image. */
export const hasBrokenImage = (page: Page): Promise<boolean> =>
  callInPage(page, '() => Array.from(document.images).some((i) => !i.naturalWidth)');
