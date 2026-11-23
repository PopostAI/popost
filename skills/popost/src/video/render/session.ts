/**
 * One headless page showing a project: the compiled page and the project's files are served by interception on a
 * made-up origin, so relative asset URLs resolve against the project directory and no network is used. The browser is
 * the runtime's, launched for drawing frames (the same pixels on every run, no host name resolves).
 */
import type { Route } from 'playwright-core';
import type { Runtime } from '../../runtime';
import type { Problem, Project, Resolved } from '../types';
import type { LayoutFact, SceneFact, SceneFailure } from '../page/contract';
import { buildPage } from '../compile/index';
import { formatProblems } from '../project/check';
import { error } from '../project/check-common';

export type { SceneFact } from '../page/contract';

export const ORIGIN = 'http://video.popost.invalid';
const PAGE_PATH = '/__popost_video__.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

/**
 * What a scene's page may do, sent with every HTML file of the project: its own inline styles and scripts and the
 * project's files, and no connection of any kind (no fetch, no socket, no form). The same header is sent by the
 * preview (preview/files.ts).
 */
export const SCENE_POLICY = "default-src 'self' data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

const inside = (rt: Runtime, root: string, file: string): boolean => {
  const rel = rt.path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !rt.path.isAbsolute(rel);
};

/** The path a URL names, or undefined when it is not a valid encoding. */
const decodedPath = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return undefined;
  }
};

/**
 * Serves the page and the files of the project directory, and nothing else: a path that leaves the directory, by ".."
 * or by a symbolic link (a linked .cache, say), is refused. A file system without realpath has no links to follow.
 */
const serve = (rt: Runtime, projectDir: string, html: string) => {
  const root = rt.path.resolve(rt.cwd, projectDir);
  const realpath = rt.fs.realpath?.bind(rt.fs);
  const realRoot = realpath ? realpath(root) : Promise.resolve(root);
  realRoot.catch(() => undefined); // read again (and answered 404) by the request that needs it
  return async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort('blockedbyclient');
    if (url.pathname === PAGE_PATH) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    const rel = decodedPath(url.pathname);
    if (rel === undefined) return route.fulfill({ status: 404, body: 'not found' });
    const file = rt.path.resolve(root, rel);
    if (!inside(rt, root, file)) return route.fulfill({ status: 403, body: 'outside the project' });
    try {
      const real = realpath ? await realpath(file) : file;
      if (!inside(rt, await realRoot, real)) return await route.fulfill({ status: 403, body: 'outside the project' });
      const body = Buffer.from(await rt.fs.readFile(real));
      const type = CONTENT_TYPES[rt.path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return await route.fulfill({ status: 200, contentType: type, body, ...(type.startsWith('text/html') ? { headers: { 'content-security-policy': SCENE_POLICY } } : {}) });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  };
};

export type ImageFormat = 'png' | 'jpeg';

export interface Session {
  resolved: Resolved;
  project: Project;
  /** Viewport (and so picture) size in pixels: the scaled canvas, rounded down to even numbers for H.264. */
  width: number;
  height: number;
  /**
   * Applies frame n and takes a screenshot. Calls are queued, so concurrent calls never mix frames. When the page says
   * the picture is the one of the previous call (changed() of the runtime), that call's screenshot is returned again.
   */
  frame(n: number, format?: ImageFormat, quality?: number): Promise<Buffer>;
  /** Screenshots taken and screenshots returned again, so far. */
  counts(): { taken: number; reused: number };
  /** The page's layout(): every text item's lines and ink (runtime/contract.ts). */
  layout(): Promise<LayoutFact[]>;
  /**
   * What every scene base looks like right now: its size, the marked places whose text is not drawn whole and its
   * texts (page/fit.ts). at.frame: applies that frame first, without a screenshot (the next frame() still compares
   * with the last screenshot); at.segment: only the scene of that segment.
   */
  scenes(at?: { frame?: number; segment?: number }): Promise<SceneFact[]>;
  /** Errors the page and its scenes have thrown so far (a script error, a file that did not load). */
  errors(): string[];
  close(): Promise<void>;
}

const even = (v: number): number => Math.max(2, 2 * Math.floor(v / 2));

/** The project has errors, so nothing was opened. problems: all of them, warnings too, for whoever reports them. */
export class ProjectError extends Error {
  override name = 'ProjectError';
  readonly problems: Problem[];
  constructor(message: string, problems: Problem[]) {
    super(message);
    this.problems = problems;
  }
}

/**
 * Scenes of the project did not load (their page, or a picture in them). problems: one per failure, at the segment
 * whose scene it is, naming the path as written and where it led.
 */
export class SceneLoadError extends ProjectError {
  override name = 'SceneLoadError';
}

const PICTURE_FIX = 'Pictures a scene shows must be PNG, JPEG, WebP, GIF, AVIF or SVG files inside the project.';

/** A failure of the page as a Problem: what the path was, how it was resolved (against the scene file), what is there. */
const failureProblem = async (rt: Runtime, root: string, projectDir: string, r: Resolved, f: SceneFailure): Promise<Problem> => {
  const id = r.segments[f.segment]?.id ?? String(f.segment);
  const segment = 'segments[' + f.segment + ']';
  if (!f.picture) return error(segment + '.base.scene', 'The scene "' + f.scene + '" of segment "' + id + '" could not be loaded as an HTML page.', 'Write a whole HTML page (<!doctype html><html><head>…</head><body>…</body></html>) into ' + rt.path.join(projectDir, f.scene) + '.');
  const { src, slot } = f.picture;
  const at = segment + '.base.' + (slot ? 'slots.' + slot : 'scene');
  const head = slot
    ? 'The picture "' + src + '" that segment "' + id + '" gives the place "' + slot + '" of the scene "' + f.scene + '" (in its "slots") could not be loaded'
    : 'The picture "' + src + '" of the scene "' + f.scene + '" (segment "' + id + '") could not be loaded';
  const dir = rt.path.dirname(f.scene);
  const fromScene = (projectPath: string): string => rt.path.relative(dir, projectPath);
  const url = new URL(f.picture.url || src, ORIGIN + '/' + f.scene);
  const rel = url.origin === ORIGIN ? decodedPath(url.pathname) : undefined;
  if (rel === undefined) return error(at, head + ': it is not a file of the project.', 'Copy the picture into the project, for example into assets/, and write its path relative to the scene file: "' + fromScene('assets/' + (src.split(/[\\/?#]/).filter(Boolean).pop() ?? 'picture.png')) + '". ' + PICTURE_FIX);
  const folder = dir === '.' ? 'the project directory' : 'the folder ' + dir + '/';
  const named = head + '. A path in a scene is relative to the scene file (' + folder + '), so it leads to "' + rel + '" in the project';
  const file = rt.path.resolve(root, rel);
  const outside = !inside(rt, root, file);
  if (!outside && (await rt.fs.stat(file))?.isFile) return error(at, named + ', which exists but is not a picture the browser can show.', 'Convert it to PNG, JPEG or WebP. ' + PICTURE_FIX);
  const message = named + (outside ? ', which is outside the project directory.' : ', and there is no such file.');
  const where = slot ? 'the segment\'s "slots"' : f.scene;
  // The usual slip: a path written from the project directory. Then the file is there, and the fix is the path.
  const meant = rt.path.resolve(root, src);
  if (!rt.path.isAbsolute(src) && inside(rt, root, meant) && (await rt.fs.stat(meant))?.isFile)
    return error(at, message, 'Write "' + fromScene(rt.path.relative(root, meant)) + '" in ' + where + ': the picture is at "' + rt.path.relative(root, meant) + '" in the project, and a path in a scene starts from ' + folder + '.');
  return error(at, message, 'Put the picture at ' + rt.path.join(projectDir, outside ? 'assets/' + rt.path.basename(rel) : rel) + ', or correct the path in ' + where + ' so that it leads from ' + folder + ' to the picture (for a picture in assets/: "' + fromScene('assets/' + rt.path.basename(rel)) + '").');
};

export interface SessionOptions {
  scale?: number;
  /** false: take a screenshot of every frame, also when the page says the picture did not change. */
  reuse?: boolean;
}

/** projectDir: as the user typed it, against rt.cwd. The caller closes the session. */
export const openSession = async (rt: Runtime, projectDir: string, opts: SessionOptions = {}): Promise<Session> => {
  const scale = opts.scale ?? 1;
  const built = await buildPage(rt, projectDir, { scale });
  if (!built.html || !built.resolved || !built.project)
    throw new ProjectError('The project in ' + projectDir + ' has errors, so it cannot be rendered:\n' + formatProblems(built.problems.filter((p) => p.level === 'error')), built.problems);
  const r = built.resolved;
  const width = even(Math.round(r.canvas.width * scale));
  const height = even(Math.round(r.canvas.height * scale));
  rt.signal?.throwIfAborted();
  const browser = await rt.launchBrowser('frames');
  // A host that aborts the command (rt.signal) must not leave a Chrome behind: closing it ends every call in flight.
  const abort = (): void => void browser.close().catch(() => undefined);
  rt.signal?.addEventListener('abort', abort, { once: true });
  const close = async (): Promise<void> => {
    rt.signal?.removeEventListener('abort', abort);
    await browser.close();
  };
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', (q) => { if (q.url().startsWith(ORIGIN)) errors.push('could not load ' + new URL(q.url()).pathname); });
    page.on('response', (s) => { if (s.status() >= 400 && s.url().startsWith(ORIGIN)) errors.push('could not load ' + new URL(s.url()).pathname + ' (' + s.status() + ')'); });
    await page.route('**/*', serve(rt, projectDir, built.html));
    await page.goto(ORIGIN + PAGE_PATH, { waitUntil: 'load' });
    const started = await page.evaluate(() => window.__popostVideo !== undefined);
    if (!started) throw new Error('The video page did not start: ' + (errors.join(' | ') || 'no error was reported') + '.');
    // A scene that did not load is the project's problem, said at its segment; anything else is thrown as it is.
    const failures = await page.evaluate(async () => {
      try {
        await window.__popostVideo?.prepare();
        return [];
      } catch (e) {
        const listed = (e as { failures?: SceneFailure[] }).failures;
        if (Array.isArray(listed) && listed.length > 0) return listed;
        throw e;
      }
    });
    if (failures.length) {
      const root = rt.path.resolve(rt.cwd, projectDir);
      const problems = await Promise.all(failures.map((f) => failureProblem(rt, root, projectDir, r, f)));
      throw new SceneLoadError('A scene of the project in ' + projectDir + ' could not be loaded:\n' + formatProblems(problems), problems);
    }
    const cdp = await context.newCDPSession(page);
    const reuse = opts.reuse !== false;
    let kept: { key: string; data: Buffer } | undefined;
    const counts = { taken: 0, reused: 0 };
    const capture = async (n: number, format: ImageFormat, quality: number): Promise<Buffer> => {
      // applyFrame, then settle: the screenshot waits until every video picture of frame n is decoded.
      const changed = await page.evaluate(async (f) => {
        const v = window.__popostVideo;
        v?.applyFrame(f);
        await v?.settle();
        return v?.changed() ?? true;
      }, n);
      const key = format + ':' + quality;
      if (reuse && !changed && kept?.key === key) {
        counts.reused++;
        return kept.data;
      }
      const shot = await cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      kept = { key, data: Buffer.from(shot.data, 'base64') };
      counts.taken++;
      return kept.data;
    };
    let queue: Promise<unknown> = Promise.resolve();
    const frame = (n: number, format: ImageFormat = 'png', quality = 92): Promise<Buffer> => {
      const next = queue.then(() => capture(n, format, quality));
      queue = next.catch(() => undefined);
      return next;
    };
    // Queued with the frames, so it never runs between a frame's applyFrame and its screenshot.
    const layout = (): Promise<LayoutFact[]> => {
      const next = queue.then(() => page.evaluate(() => window.__popostVideo?.layout() ?? []));
      queue = next.catch(() => undefined);
      return next;
    };
    const scenes = (at: { frame?: number; segment?: number } = {}): Promise<SceneFact[]> => {
      const next = queue.then(() => page.evaluate(async ({ frame, segment }) => {
        const v = window.__popostVideo;
        if (frame !== undefined) {
          v?.applyFrame(frame);
          await v?.settle();
        }
        return v?.scenes(segment) ?? [];
      }, at));
      queue = next.catch(() => undefined);
      return next;
    };
    return { resolved: r, project: built.project, width, height, frame, layout, scenes, errors: () => [...errors], counts: () => ({ ...counts }), close };
  } catch (e) {
    await close().catch(() => undefined);
    throw e;
  }
};
