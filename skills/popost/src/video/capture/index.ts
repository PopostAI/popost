/**
 * Records a web page as footage, frame by frame: a material for videos that show a site, a product page or an
 * interface. The page's clock is taken over, so its script timers, requestAnimationFrame, CSS animations and
 * transitions advance by exactly one frame's time per frame, however long a screenshot takes.
 *
 * A plan is a list of steps. Frames are the unit, as everywhere in the engine:
 *   { hold: 30 }                                         stay for 30 frames
 *   { scroll: { to: 1200, frames: 45, ease: 'in-out' } } scroll to 1200 px from the top
 *   { scroll: { to: 'bottom', frames: 60 } }             or to the end of the page
 *   { scroll: { to: '#pricing', frames: 45 } }           or until an element sits a little below the top
 *   { hover: '.card' }  { click: 'text=Sign in' }        move the pointer to an element, or click it (one frame)
 *   { wait: 800 }                                        let the page load for 800 ms of real time; records nothing
 * and the steps that direct the eye (steps.ts, played by director.ts), drawn into the recording:
 *   { zoom: { to: '#plans', frames: 20, fill: 0.7 } }   move and enlarge the view to an element ('page': back)
 *   { highlight: { to: '#plans', frames: 12 } }          draw a box around it (or 'underline', 'spot'); { clear: 10 }
 *   { point: { to: 'a.buy', frames: 18 } }              show a pointer and move it there; hover and click follow it
 *   { type: { into: 'input', text: 'shoes', frames: 30 } }   type into a field, the caret shown
 *
 * When recording begins, the page's CSS animations are rewound to their start (replay), so entrances play in the
 * footage. What is not controlled: the network and what the page's scripts did before recording started, so two
 * recordings of a live site are alike, not identical. Video elements of the page are not stepped. Animations that
 * follow the scroll position (scroll-driven timelines) are left alone: they move with the scroll the plan sets.
 *
 * A page that answers with an HTTP error is not recorded. outlinePage lists a page's headings with their positions,
 * for writing the scroll steps of a plan. The browser is the runtime's, launched for the public web; the screenshots
 * go to ffmpeg through the runtime as they are taken.
 */
import type { Browser, Page } from 'playwright-core';
import type { Runtime } from '../../runtime';
import { runFfmpeg } from '../media/ffmpeg';
import { ease as easeAt } from '../presets/easing';
import { colourFilter } from '../render/encode';
import type { Ease } from '../types';
import { openDirector, overlayNote, placeOf, smallTextNote, type Director } from './director';
import { installStage, type OverlayFact, type TargetFact } from './stage';
import { CaptureError, cssView, stepFrames, stepProblems, textSizes, WHOLE, type DirectStep, type View } from './steps';

export { CaptureError };

export type CaptureStep =
  | { hold: number }
  | { scroll: { to: number | string; frames: number; ease?: Ease } }
  | { hover: string }
  | { click: string }
  | { wait: number }
  | DirectStep;

export interface CaptureOptions {
  /** How long the rest of the page may take after its document arrived; default 30 s. */
  loadMs?: number;
  url: string;
  /** The video file to write, as the user typed it (against rt.cwd). */
  out: string;
  /** Size of the browser window in CSS pixels, and of the video (times scale). */
  width: number;
  height: number;
  fps: number;
  steps: CaptureStep[];
  /** Pixels per CSS pixel: 2 records a 1280x720 window as 2560x1440. Default 1. */
  scale?: number;
  /** The page laid out this many times larger: 1.5 lays a 960x720 recording out in a 640x480 window, so its text is
   *  readable in the video. Plan positions are in the pixels of that smaller window. Default 1. */
  zoom?: number;
  colorScheme?: 'light' | 'dark';
  /** CSS selectors to hide before recording (cookie banners, chat bubbles). */
  hide?: string[];
  /** Real time to wait after the page has loaded, before recording. Default 1500 ms. */
  settleMs?: number;
  /** Rewind the page's CSS animations to their start when recording begins, so entrances play in the footage
   *  instead of during loading. Default true. */
  replay?: boolean;
  crf?: number;
  /** The top of the video's caption band as a fraction of the picture's height (0..1): a zoom ends with its element
   *  above it when it can, and a highlight under it is noted (director.ts). */
  captionBand?: number;
}

export interface CaptureResult {
  frames: number; width: number; height: number; fps: number; ms: number; pageHeight: number;
  /** What the plan asked for and the page could not give: a scroll past the end of the page, a scroll that did not move;
   *  text too small to read; elements that covered part of the window and were not hidden. */
  notes: string[];
  /** Font sizes of the text seen over the recording, in pixels of the video: the smallest, and the median by character. */
  text: { smallestPx: number; medianPx: number } | null;
}

const MAX_FRAMES = 30 * 60 * 5;

const problems = (o: CaptureOptions): string[] => {
  const out: string[] = [];
  if (!/^(https?|file):/.test(o.url)) out.push('url must start with http://, https:// or file://, got "' + o.url + '".');
  if (!(o.width >= 64 && o.height >= 64 && o.width <= 4096 && o.height <= 4096)) out.push('width and height must be between 64 and 4096, got ' + o.width + 'x' + o.height + '.');
  if (!(o.fps >= 1 && o.fps <= 60)) out.push('fps must be between 1 and 60, got ' + o.fps + '.');
  if (o.zoom !== undefined && !(o.zoom >= 1 && o.zoom <= 4)) out.push('zoom must be between 1 and 4, got ' + o.zoom + '.');
  if (o.captionBand !== undefined && !(o.captionBand > 0 && o.captionBand < 1)) out.push('the caption band\'s top is a fraction of the picture\'s height between 0 and 1 (the y of slots.captions.box), got ' + o.captionBand + '.');
  if (!o.steps.length) out.push('the plan has no steps; add for example { "hold": 30 }.');
  let total = 0;
  o.steps.forEach((s, i) => {
    const wrong = stepProblems(s, i);
    if (wrong.length) return void out.push(...wrong);
    const frames = 'hold' in s ? s.hold : 'scroll' in s ? s.scroll.frames : 1;
    if (!Number.isInteger(frames) || frames < 1) out.push('steps[' + i + ']: the number of frames must be a whole number of at least 1.');
    const planned = 'hold' in s ? s.hold : 'scroll' in s ? s.scroll.frames : 'wait' in s ? 0 : stepFrames(s);
    total += Number.isFinite(planned) ? planned : 0;
  });
  if (total > MAX_FRAMES) out.push('the plan records ' + total + ' frames; the limit is ' + MAX_FRAMES + '.');
  return out;
};

/** Advances the page by one frame's time: script timers and rAF through the installed clock, CSS animations by hand. */
const tick = async (page: Page, ms: number): Promise<void> => {
  await page.clock.runFor(ms);
  await page.evaluate((dt) => {
    for (const a of document.getAnimations()) {
      // An animation on a scroll timeline has no time to set (setting it throws): the scroll position drives it.
      if (!(a.timeline instanceof DocumentTimeline)) continue;
      if (a.playState !== 'paused') a.pause();
      a.currentTime = Number(a.currentTime ?? 0) + dt;
    }
  }, ms);
};

export interface LoadOptions { /** How long the rest of the page may take after its document arrived; default 30 s. */ loadMs?: number; url: string; width: number; height: number; scale?: number; zoom?: number; colorScheme?: 'light' | 'dark'; hide?: string[]; settleMs?: number }

/** A browser for the public web, for fn, closed afterwards and at once when the host aborts the command. */
const withWebBrowser = async <T>(rt: Runtime, fn: (browser: Browser) => Promise<T>): Promise<T> => {
  rt.signal?.throwIfAborted();
  const browser = await rt.launchBrowser('web');
  const abort = (): void => void browser.close().catch(() => undefined);
  rt.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fn(browser);
  } finally {
    rt.signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => undefined);
  }
};

/** What loadPage has to say about a page that never finished loading; read by whoever reports notes. */
const loadNotes = new WeakMap<Page, string>();
const loadNote = (page: Page): string[] => { const n = loadNotes.get(page); return n ? [n] : []; };

/** How long the document may take to arrive, and how long the rest of the page (pictures, scripts) may take after it. */
const DOCUMENT_MS = 60_000;
const LOAD_MS = 30_000;

/** Opens the page with its clock taken over, waits until it is loaded, and hides what the caller asked to hide. */
const loadPage = async (browser: Browser, o: LoadOptions): Promise<Page> => {
  const context = await browser.newContext({ viewport: cssView(o.width, o.height, o.zoom), deviceScaleFactor: (o.scale ?? 1) * (o.zoom ?? 1), colorScheme: o.colorScheme ?? 'light' });
  const page = await context.newPage();
  await page.clock.install();
  // The document first; then the rest of the page for a while. One resource that never answers (a tracker, a picture
  // behind a slow proxy) must not lose the whole recording: the page is recorded as it stands, with a note.
  const response = await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: DOCUMENT_MS }).catch((e: unknown) => {
    throw new CaptureError('The page did not answer within ' + DOCUMENT_MS / 1000 + ' s, so it was not recorded: ' + o.url + ' (' + (e instanceof Error ? e.message.split('\n')[0] : String(e)) + '). Try again once; if it fails again, check the address with curl -I, or show the page from a picture or text you already have.');
  });
  const loadMs = o.loadMs ?? LOAD_MS;
  const loaded = await page.waitForLoadState('load', { timeout: loadMs }).then(() => true, () => false);
  if (!loaded) loadNotes.set(page, 'the page had not finished loading after ' + (loadMs / 1000) + ' s (something it asks for never answered); it was recorded as it stood. Look at a frame: if pictures are missing, record again.');
  const status = response?.status() ?? 0;
  if (status >= 400) throw new CaptureError('The page answered HTTP ' + status + ', so it was not recorded: ' + o.url + '. Open the address in a browser to see what it shows; a 429 or 503 often passes after a wait.');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(o.settleMs ?? 1500);
  if (o.hide?.length) await page.addStyleTag({ content: o.hide.join(',') + '{display:none !important}' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
  return page;
};

/** Where a scroll step ends (y), and the furthest the page can scroll (max). */
const scrollTarget = async (page: Page, to: number | string, viewportHeight: number): Promise<{ y: number; max: number }> =>
  page.evaluate(([target, vh]) => {
    const max = Math.max(0, document.documentElement.scrollHeight - (vh as number));
    if (typeof target === 'number') return { y: Math.min(max, Math.max(0, target)), max };
    if (target === 'bottom') return { y: max, max };
    if (target === 'top') return { y: 0, max };
    const el = document.querySelector(target as string);
    if (!el) throw new Error('scroll: no element matches "' + target + '".');
    // A little air above the element: 12% of the window.
    return { y: Math.min(max, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 0.12 * (vh as number))), max };
  }, [to, viewportHeight] as const);

/** What a scroll step could not do, in words for whoever wrote the plan. */
const scrollNote = (index: number, to: number | string, from: number, target: { y: number; max: number }): string | undefined => {
  if (typeof to === 'number' && to > target.max + 1)
    return 'steps[' + index + ']: the plan scrolls to ' + to + ' px, but the page can only scroll to ' + Math.round(target.max) + ' px; it stopped there. Use "bottom", or a position from the outline of the page.';
  if (Math.abs(target.y - from) < 1) return 'steps[' + index + ']: the scroll does not move (the page is already at ' + Math.round(from) + ' px); its frames show a still page.';
  return undefined;
};

const even = (n: number): number => Math.max(2, 2 * Math.floor(n / 2));

/** Stops the page's clock a second ahead of where the page's own clock is now (it was installed at the real time). */
const pauseSoon = async (page: Page): Promise<void> => {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
};

/** The screenshots of the plan, one per recorded frame, as the steps take them; counts what it gave and what the plan could not do. */
async function* recorded(page: Page, o: CaptureOptions, tally: { frames: number; notes: string[] }, director: Director, view: View): AsyncGenerator<Uint8Array> {
  const frameMs = 1000 / o.fps;
  const shot = async (): Promise<Uint8Array> => {
    tally.frames++;
    return director.shot();
  };
  const frame = async (): Promise<Uint8Array> => { await tick(page, frameMs); return shot(); };
  for (const [index, step] of o.steps.entries()) {
    director.begin(index);
    if ('wait' in step) {
      // Real time: the clock is released so that loading scripts can run, then taken back.
      await page.clock.resume();
      await page.waitForTimeout(step.wait);
      await pauseSoon(page);
    } else if ('hold' in step) {
      for (let i = 0; i < step.hold; i++) { await tick(page, frameMs); yield await shot(); }
    } else if ('scroll' in step) {
      const from = await page.evaluate(() => window.scrollY);
      const target = await scrollTarget(page, step.scroll.to, view.height);
      const note = scrollNote(index, step.scroll.to, from, target);
      if (note) tally.notes.push(note);
      const to = target.y;
      for (let i = 1; i <= step.scroll.frames; i++) {
        const y = from + (to - from) * easeAt(step.scroll.ease ?? 'in-out', i / step.scroll.frames);
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await tick(page, frameMs);
        yield await shot();
      }
    } else yield* director.play(index, step, frame);
  }
}

export const capturePage = async (rt: Runtime, o: CaptureOptions): Promise<CaptureResult> => {
  const wrong = problems(o);
  if (wrong.length) throw new CaptureError('The capture plan has problems:\n  ' + wrong.join('\n  '));
  const scale = o.scale ?? 1;
  const view = cssView(o.width, o.height, o.zoom);
  const started = Date.now();
  const out = rt.path.resolve(rt.cwd, o.out);
  await rt.fs.mkdir(rt.path.dirname(out));
  return withWebBrowser(rt, async (browser) => {
    const page = await loadPage(browser, o);
    await pauseSoon(page);
    if (o.replay !== false) await page.evaluate(() => { for (const a of document.getAnimations()) { if (a.timeline instanceof DocumentTimeline) { a.pause(); a.currentTime = 0; } } });
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    // The encoder reads PNG screenshots from its input; frames whose size is odd are cropped to even numbers.
    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', 'png', '-i', 'pipe:0',
      '-vf', 'crop=' + even(o.width * scale) + ':' + even(o.height * scale) + ':0:0,' + colourFilter('png'), '-c:v', 'libx264', '-crf', String(o.crf ?? 16), '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', String(o.fps), '-movflags', '+faststart', out];
    const tally = { frames: 0, notes: loadNote(page) };
    const director = await openDirector(page, {
      view, pixels: scale * (o.zoom ?? 1), zoom: o.zoom ?? 1, outputHeight: even(o.height * scale), replay: o.replay !== false,
      css: (o.hide?.length ? o.hide.join(',') + '{display:none !important}' : '') + 'html{scroll-behavior:auto !important}',
      pauseSoon: () => pauseSoon(page), notes: tally.notes,
      ...(o.captionBand === undefined ? {} : { band: o.captionBand * view.height }),
    });
    // At Chrome's priority: the encoder drains the page (runFfmpeg).
    const r = await runFfmpeg(rt, args, recorded(page, o, tally, director, view), undefined, { lowPriority: false });
    if (r.code !== 0) throw new Error('Encoding the capture failed (ffmpeg exited with ' + r.code + '): ' + r.stderr.trim().split('\n').slice(-2).join(' | '));
    const { text } = director.finish();
    return { frames: tally.frames, width: even(o.width * scale), height: even(o.height * scale), fps: o.fps, ms: Date.now() - started, pageHeight, notes: tally.notes, text };
  });
};

export interface OutlineSection {
  /** Distance of the heading from the top of the page, in CSS pixels: what a scroll step takes as "to". */
  y: number;
  tag: string;
  text: string;
  /** A selector of the heading for a plan's steps: "#id" when it has one, else one that matches it alone. */
  selector: string;
  /** [x, y, width, height] in page pixels. */
  box: [number, number, number, number];
}
/** A fixed or sticky element over part of the window: a selector --hide takes, its box in the window, its first words. */
export interface OutlineOverlay extends Omit<OverlayFact, 'key'> { where: string }
export interface PageOutline {
  title: string; pageHeight: number; width: number; height: number; sections: OutlineSection[];
  /** The most prominent elements a plan can point at (buttons, fields, cards, code, pictures, large numbers, links), top to bottom. */
  targets: TargetFact[];
  overlays: OutlineOverlay[];
  /** Font sizes of the text in the first window, in pixels of the video. */
  text: { smallestPx: number; medianPx: number } | null;
  /** Every box is [x, y, width, height] in page pixels; a still at the same --size and --zoom has this many pixels per page pixel. */
  stillScale: number;
}

/** At most this many headings and this many targets: an outline is read whole by a model. */
const OUTLINE_LIMIT = 100;

/**
 * The headings of a page that can be seen, top to bottom, with where they are (for scroll steps); the elements a plan
 * may zoom to, highlight or click; what covers the window; how large its text is in the video.
 */
export const outlinePage = async (rt: Runtime, o: LoadOptions): Promise<PageOutline> =>
  withWebBrowser(rt, async (browser) => {
    const page = await loadPage(browser, o);
    const view = cssView(o.width, o.height, o.zoom);
    await page.evaluate(installStage, '');
    const found = await page.evaluate(([v, limit]) => {
      const stage = window.__popostStage;
      if (!stage) throw new Error('The outline could not be read: the page removed what popost added to it.');
      return { title: document.title, pageHeight: document.documentElement.scrollHeight, ...stage.outline(v, limit) };
    }, [view, OUTLINE_LIMIT] as const);
    const pixels = (o.scale ?? 1) * (o.zoom ?? 1);
    const text = textSizes(new Map(found.text.map(([px, n]) => [Math.round(px * pixels * 4) / 4, n])));
    const overlays = found.overlays.map(({ key: _key, ...rest }) => ({ ...rest, where: placeOf(rest.box, WHOLE, view) }));
    return { title: found.title, pageHeight: found.pageHeight, width: view.width, height: view.height, sections: found.sections, targets: found.targets, overlays, text, stillScale: pixels };
  });

/** Where a still's window sits (a selector, or px from the top; default the top), or the whole page in one picture. */
export interface StillOptions extends LoadOptions { out: string; at?: string | number; fullPage?: boolean }
export interface StillResult {
  width: number; height: number; pageHeight: number;
  /** Where the top of the picture is on the page, in page pixels (0 for the whole page). */
  y: number;
  /** Pixels of the picture per page pixel (the scale times the zoom): a box from --outline at the same --size and --zoom,
   *  moved up by y and multiplied by this, is the element's place in the picture. */
  stillScale: number;
  text: { smallestPx: number; medianPx: number } | null;
  overlays: OutlineOverlay[];
  notes: string[];
}

/** A picture taller than this many pixels is refused: Chrome draws no larger. */
const MAX_STILL = 16_384;

/**
 * One picture of a page instead of a video: for a scene that shows the page and moves its own camera over it. The
 * same window, zoom, scale, colour scheme and hidden elements as a recording; it reports the text sizes and what
 * covers the window the same way.
 */
export const stillPage = async (rt: Runtime, o: StillOptions): Promise<StillResult> => {
  const wrong = problems({ ...o, fps: 30, steps: [{ hold: 1 }] });
  if (wrong.length) throw new CaptureError('The still cannot be taken:\n  ' + wrong.join('\n  '));
  const scale = o.scale ?? 1;
  const zoom = o.zoom ?? 1;
  const view = cssView(o.width, o.height, zoom);
  const out = rt.path.resolve(rt.cwd, o.out);
  await rt.fs.mkdir(rt.path.dirname(out));
  return withWebBrowser(rt, async (browser) => {
    const page = await loadPage(browser, o);
    await pauseSoon(page);
    await page.evaluate(installStage, '');
    const notes: string[] = loadNote(page);
    let y = 0;
    if (o.at !== undefined && !o.fullPage) {
      if (typeof o.at === 'string' && !/^(top|bottom)$/.test(o.at) && !(await page.locator(o.at).count().catch(() => 0)))
        throw new CaptureError('--at: nothing on ' + o.url + ' matches "' + o.at + '". Take a selector or a y from popost video capture <url> --outline.');
      const target = await scrollTarget(page, o.at, view.height);
      if (typeof o.at === 'number' && o.at > target.max + 1) notes.push('--at ' + o.at + ' is past the end of the page; the window sits at the bottom, ' + Math.round(target.max) + ' px.');
      await page.evaluate((v) => window.scrollTo(0, v), target.y);
      y = await page.evaluate(() => window.scrollY);
    }
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const pixels = scale * zoom;
    if (o.fullPage && pageHeight * pixels > MAX_STILL)
      throw new CaptureError('The page is ' + pageHeight + ' px tall, ' + Math.round(pageHeight * pixels) + ' px in the picture: more than one picture can hold (' + MAX_STILL + '). Take stills of its parts with --at instead.');
    const read = await page.evaluate(([full, h]) => {
      const stage = window.__popostStage;
      if (!stage) throw new Error('The still could not be read: the page removed what popost added to it.');
      return stage.read(full ? { x: 0, y: -window.scrollY, w: window.innerWidth, h } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    }, [o.fullPage === true, pageHeight] as const);
    const cdp = await page.context().newCDPSession(page);
    const { cssVisualViewport: vv } = await cdp.send('Page.getLayoutMetrics');
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: o.fullPage ? { x: 0, y: 0, width: o.width / zoom, height: pageHeight, scale: pixels } : { x: vv.pageX, y: vv.pageY, width: o.width / zoom, height: o.height / zoom, scale: pixels },
      captureBeyondViewport: o.fullPage === true,
    });
    const png = Buffer.from(shot.data, 'base64');
    await rt.fs.writeFile(out, png);
    const text = textSizes(new Map(read.text.map(([px, n]) => [Math.round(px * pixels * 4) / 4, n])));
    const overlays = read.overlays.map(({ key: _key, ...rest }) => ({ ...rest, where: placeOf(rest.box, WHOLE, view) }));
    notes.push(...smallTextNote(text, Math.round(o.height * scale), zoom), ...overlays.map((v) => overlayNote(v, v.where, '')));
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), pageHeight, y: o.fullPage ? 0 : Math.round(y), stillScale: pixels, text, overlays, notes };
  });
};
