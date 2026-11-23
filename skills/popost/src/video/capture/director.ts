/**
 * Plays the steps of a capture plan that direct the viewer's eye: zoom, highlight, clear, point, pointer, type, and
 * hover and click, which move a shown pointer first. Each recorded frame is drawn by the stage (stage.ts) and taken
 * through the camera.
 *
 * The zoom is the camera of the screenshot, not a change to the page: Chrome draws the camera's rectangle of the
 * window anew at the larger scale (crisp text, not enlarged pixels). Transforming the document element instead would
 * make it the containing block of every fixed element, so a fixed header or a chat bubble would scroll away with the
 * page or stretch to its height, and the page's scripts would read zoomed positions. With the camera, the page lays out
 * and scrolls as it always does: fixed and sticky elements stay where they are in the window and are enlarged with
 * it, a scroll step while zoomed keeps the zoom, and clicks land where the page's elements are.
 *
 * State that the page could lose lives here, not in the page: when the page becomes a new document (a click that
 * navigates), the stage is installed again, the pointer is put back where it was, the highlight follows its selector
 * onto the new page if it is there, and the zoom goes back to the whole page (with a note).
 */
import type { CDPSession, ElementHandle, Page, Request } from 'playwright-core';
import { ease as easeAt } from '../presets/easing';
import type { Ease } from '../types';
import { installStage, type OverlayFact, type StageFrame, type StageSample } from './stage';
import {
  CaptureError, cameraBetween, DEFAULTS, isWhole, lineWidth, MAX_ZOOM, pointerAt, pointerSize, pointerStart, pressAt,
  textSizes, toWindow, WHOLE, zoomForText, zoomPlan, type Box, type Camera, type DirectStep, type HighlightStyle,
  type Point, type View, type ZoomPlan,
} from './steps';

export interface DirectorOptions {
  /** The window in CSS pixels. */
  view: View;
  /** Picture pixels per CSS pixel: the scale times the zoom. */
  pixels: number;
  /** The --zoom the page is laid out with, for the advice on small text. */
  zoom: number;
  /** Height of the picture in pixels. */
  outputHeight: number;
  /** CSS added again to a new document: what --hide removes, no smooth scrolling. */
  css: string;
  /** Rewind the CSS animations of a new document, as the first one was. */
  replay: boolean;
  /** Stops the page's clock again after it ran in real time. */
  pauseSoon: () => Promise<void>;
  /** Where to write what the plan asked for and the page could not give. */
  notes: string[];
  /** The top of the caption band in window pixels: a zoom ends with its element above it, a highlight under it is noted. */
  band?: number;
}

export type PlayedStep = DirectStep | { hover: string } | { click: string };

export interface Director {
  /** Draws the stage for this frame and takes the picture through the camera. */
  shot(): Promise<Uint8Array>;
  /** Marks the start of a step: its first frame is read for text sizes and covering elements. */
  begin(index: number): void;
  /** The frames of a directing step, hover or click; frame() advances the page's clock by one frame and takes the shot. */
  play(index: number, step: PlayedStep, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array>;
  /** Text sizes over the recording; adds the notes about small text and about what covered the window. */
  finish(): { text: { smallestPx: number; medianPx: number } | null };
}

/** A frame in this many is read for text sizes and covering elements, besides the first frame of each step. */
const SAMPLE_EVERY = 15;
/** A screenshot takes milliseconds; one that has not come in this long will not come. */
const STALL_MS = 30_000;

type Highlight = { id: number; selector: string; style: HighlightStyle; color: string; pad: number; progress: number; opacity: number };

/** Where a box (layout pixels) is seen in the picture, in words: "top", "lower middle", "upper right". */
export const placeOf = (b: readonly [number, number, number, number], c: Camera, view: View): string => {
  const a = toWindow(c, { x: b[0], y: b[1] });
  const z = toWindow(c, { x: b[0] + b[2], y: b[1] + b[3] });
  const x0 = Math.max(0, a.x); const x1 = Math.min(view.width, z.x);
  const y0 = Math.max(0, a.y); const y1 = Math.min(view.height, z.y);
  const cy = (y0 + y1) / 2 / view.height;
  const row = cy < 1 / 3 ? 'upper' : cy < 2 / 3 ? 'middle' : 'lower';
  if (x1 - x0 >= 0.8 * view.width) return row === 'upper' ? 'top' : row === 'lower' ? 'bottom' : 'middle';
  const cx = (x0 + x1) / 2 / view.width;
  const col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'middle' : 'right';
  return row === 'middle' && col === 'middle' ? 'middle' : row + ' ' + col;
};

const KIND_WORDS: Record<OverlayFact['kind'], string> = {
  header: '', cookie: ', probably a cookie banner,', language: ', probably a language switcher,', chat: ', probably a chat button,', dialog: ', a dialog,', bar: ', a bar,', other: '',
};

/** How often an element was seen in the frames read: "in every frame", "in 40% of the frames". */
export const shareOf = (seen: number, samples: number): string =>
  seen >= samples ? ' in every frame' : ' in ' + Math.max(1, Math.round((100 * seen) / samples)) + '% of the frames';

/** The note about one element that covered part of the window (share: how often, or nothing for a still). */
export const overlayNote = (o: Omit<OverlayFact, 'key'>, place: string, share: string): string => {
  const words = o.text ? ' ("' + o.text.slice(0, 40) + '")' : '';
  if (o.kind === 'header')
    return 'a ' + o.position + ' element covers the top of the window' + share + ": '" + o.selector + "'" + words + "; it is probably the site's header, which is usually wanted; to remove it anyway: --hide '" + o.selector + "'";
  return 'a ' + o.position + ' element' + KIND_WORDS[o.kind] + ' covers the ' + place + ' of the window' + share + ": '" + o.selector + "'" + words + "; hide it with --hide '" + o.selector + "'";
};

/** A height in the window as a share of it, "75%": how the notes about the caption band say where things are. */
const share = (y: number, view: View): string => Math.round((100 * y) / view.height) + '%';

/** The note when the median text is under 2% of the picture's height, with the --zoom that would make it readable. */
export const smallTextNote = (text: { medianPx: number } | null, outputHeight: number, zoom: number): string[] =>
  text && text.medianPx < 0.02 * outputHeight
    ? ['text is small: median ' + text.medianPx + ' px of ' + outputHeight + '; use --zoom ' + zoomForText(text.medianPx, outputHeight, zoom) + ' or zoom steps.']
    : [];

/** Requests a click starts: a navigation of the page, and the page's own loading (documents, fetch, XHR). */
const watchLoads = (page: Page): { navigation: () => boolean; loaded: () => boolean; started: () => number; open: () => number; stop: () => void } => {
  let navigation = false;
  let loaded = false;
  let started = 0;
  const open = new Set<Request>();
  const onRequest = (r: Request): void => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigation = true;
    if (/^(document|xhr|fetch)$/.test(r.resourceType())) { started++; open.add(r); }
  };
  const onDone = (r: Request): void => { open.delete(r); };
  const onLoad = (): void => { loaded = true; };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  page.on('load', onLoad);
  return {
    navigation: () => navigation, loaded: () => loaded, started: () => started, open: () => open.size,
    stop: () => { page.off('request', onRequest); page.off('requestfinished', onDone); page.off('requestfailed', onDone); page.off('load', onLoad); },
  };
};

export const openDirector = async (page: Page, o: DirectorOptions): Promise<Director> => {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await page.evaluate(installStage, o.css);
  const { view } = o;
  const size = pointerSize(view);
  const line = lineWidth(view);
  let camera: Camera = WHOLE;
  let pointer: Point | undefined;
  let dip = 0;
  let ring: { x: number; y: number; radius: number; opacity: number } | undefined;
  let highlight: Highlight | undefined;
  let nextId = 1;
  let step = 0;
  let frames = 0;
  let sampleNext = true;
  let documents = 0;
  let samples = 0;
  const textCounts = new Map<number, number>();
  const covering = new Map<string, { fact: OverlayFact; place: string; seen: number }>();
  const at = (index: number): string => 'steps[' + index + ']: ';

  const keep = async (handle: ElementHandle, id: number): Promise<void> => {
    await page.evaluate(([el, n]) => window.__popostStage?.keep(n, el as Element), [handle, id] as const);
  };

  /** The page became a new document: the stage again, and what was on it, as far as the new page allows. */
  const newDocument = async (): Promise<void> => {
    documents++;
    await page.evaluate(installStage, o.css);
    if (o.replay) await page.evaluate(() => { for (const a of document.getAnimations()) { if (a.timeline instanceof DocumentTimeline) { a.pause(); a.currentTime = 0; } } });
    if (!isWhole(camera)) {
      camera = WHOLE;
      o.notes.push(at(step) + 'the page changed to ' + page.url() + '; the zoom went back to the whole page. Zoom again on the new page if you need it.');
    }
    if (highlight) {
      const handle = await page.locator(highlight.selector).first().elementHandle({ timeout: 2000 }).catch(() => null);
      if (handle) await keep(handle, highlight.id);
      else {
        o.notes.push(at(step) + 'the page changed to ' + page.url() + ', where nothing matches "' + highlight.selector + '"; its highlight was dropped.');
        highlight = undefined;
      }
    }
  };

  const tally = (s: StageSample): void => {
    samples++;
    for (const [px, chars] of s.text) {
      const out = Math.round(px * camera.s * o.pixels * 4) / 4;
      textCounts.set(out, (textCounts.get(out) ?? 0) + chars);
    }
    for (const f of s.overlays) {
      const key = documents + ':' + f.key;
      const seen = covering.get(key);
      covering.set(key, { fact: f, place: seen?.place ?? placeOf(f.box, camera, view), seen: (seen?.seen ?? 0) + 1 });
    }
  };

  const shot = async (): Promise<Uint8Array> => {
    const spec: StageFrame = {
      camera,
      sample: sampleNext || frames % SAMPLE_EVERY === 0,
      ...(highlight ? { highlight: { ...highlight, line } } : {}),
      ...(pointer ? { pointer: { ...pointer, dip, size } } : {}),
      ...(ring ? { ring: { ...ring, line: Math.max(1.5, line * 0.75) } } : {}),
    };
    sampleNext = false;
    const draw = (): Promise<{ sample: StageSample | null } | null> =>
      page.evaluate((f) => (window.__popostStage ? { sample: window.__popostStage.render(f) } : null), spec);
    let drawn = await draw();
    if (!drawn) {
      await newDocument();
      drawn = await draw();
    }
    if (drawn?.sample) tally(drawn.sample);
    const { cssVisualViewport: vv } = await cdp.send('Page.getLayoutMetrics');
    const taken = cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: vv.pageX + camera.x, y: vv.pageY + camera.y, width: view.width / camera.s, height: view.height / camera.s, scale: camera.s * o.pixels },
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    // A browser that stopped drawing never answers: fail instead of waiting forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The browser stopped drawing the page (no screenshot in ' + STALL_MS / 1000 + ' s) at frame ' + frames + ', steps[' + step + '].')), STALL_MS); });
    const shotOf = await Promise.race([taken, stalled]).finally(() => clearTimeout(timer));
    frames++;
    return Buffer.from(shotOf.data, 'base64');
  };

  /** The element a step names, or a message that says how to name one. */
  const locate = async (index: number, selector: string): Promise<ElementHandle> => {
    const handle = await page.locator(selector).first().elementHandle({ timeout: 3000 }).catch(() => null);
    if (!handle) throw new CaptureError(at(index) + 'nothing on ' + page.url() + ' matches "' + selector + '". Take a selector from popost video capture <url> --outline (sections, targets), or write a CSS selector of your own.');
    return handle;
  };
  const boxOf = async (index: number, handle: ElementHandle, selector: string): Promise<Box> => {
    const b = await handle.boundingBox();
    if (!b || b.width < 1 || b.height < 1) throw new CaptureError(at(index) + '"' + selector + '" matches an element that is not shown (no size); name one that can be seen.');
    return b;
  };
  const inWindow = (p: Point): boolean => p.x >= 0 && p.y >= 0 && p.x < view.width && p.y < view.height;
  const inPicture = (b: readonly number[]): boolean => {
    const a = toWindow(camera, { x: b[0] ?? 0, y: b[1] ?? 0 });
    const z = toWindow(camera, { x: (b[0] ?? 0) + (b[2] ?? 0), y: (b[1] ?? 0) + (b[3] ?? 0) });
    return z.x > 0 && z.y > 0 && a.x < view.width && a.y < view.height;
  };
  /** The middle of an element, in the window; a click needs it in the window, so the page is scrolled there if it is not. */
  const middleOf = async (index: number, selector: string, scroll: boolean): Promise<Point> => {
    const handle = await locate(index, selector);
    let b = await boxOf(index, handle, selector);
    let p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    if (scroll && !inWindow(p)) {
      await handle.scrollIntoViewIfNeeded({ timeout: 3000 });
      o.notes.push(at(index) + '"' + selector + '" was outside the window, so the page jumped to it; scroll to it with a scroll step first.');
      b = await boxOf(index, handle, selector);
      p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } else if (!inWindow(p)) o.notes.push(at(index) + '"' + selector + '" is outside the window, so the pointer leaves the picture; scroll to it first.');
    return p;
  };

  async function* move(to: Point, count: number, kind: Ease, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    const from = pointer ?? pointerStart(camera, view);
    for (let i = 1; i <= count; i++) {
      pointer = pointerAt(from, to, i / count, kind);
      // The page's own mouse follows, so that what reacts to hovering does so on the way.
      if (inWindow(pointer)) await page.mouse.move(pointer.x, pointer.y);
      yield await frame();
    }
    pointer = to;
  }

  /** The click, and when it loads something, the wait in real time until the page is quiet (nothing recorded). */
  const settleAfter = async (act: () => Promise<void>): Promise<void> => {
    const watch = watchLoads(page);
    try {
      await act();
      // Requests a click starts are reported a moment later.
      await page.waitForTimeout(150);
      if (!watch.navigation() && !watch.started()) return;
      await page.clock.resume();
      const until = Date.now() + 20_000;
      while (watch.navigation() && !watch.loaded() && Date.now() < until) await page.waitForTimeout(100);
      const quietBy = Date.now() + 10_000;
      for (let quiet = Date.now(); Date.now() < quietBy; await page.waitForTimeout(100)) {
        if (watch.open()) quiet = Date.now();
        else if (Date.now() - quiet >= 500) break;
      }
      await o.pauseSoon();
    } finally {
      watch.stop();
    }
  };

  async function* zoom(index: number, z: Extract<DirectStep, { zoom: unknown }>['zoom'], frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    const count = z.frames ?? DEFAULTS.zoomFrames;
    const fill = z.fill ?? DEFAULTS.fill;
    const now = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }));
    let plan: ZoomPlan = { camera: WHOLE, scrollY: now.scrollY, wanted: 1 };
    if (z.to !== 'page') {
      const named = Array.isArray(z.to) ? 'the box ' + JSON.stringify(z.to) : '"' + z.to + '"';
      const box = Array.isArray(z.to) ? { x: z.to[0], y: z.to[1], width: z.to[2], height: z.to[3] }
        : await (async () => { const sel = z.to as string; const b = await boxOf(index, await locate(index, sel), sel); return { ...b, x: b.x + now.scrollX, y: b.y + now.scrollY }; })();
      plan = zoomPlan(box, now, view, fill, o.band);
      if (plan.under !== undefined) o.notes.push(at(index) + named + ' still reaches ' + plan.under + ' px under the top of the caption band (' + share(o.band ?? 0, view) + ' of the height) after the zoom: it is at the bottom of the page or taller than the room above the band; zoom to a smaller element, or show this part of the page in a shot whose captions are elsewhere.');
      if (plan.wanted > MAX_ZOOM)
        o.notes.push(at(index) + 'filling ' + fill + ' of the window with ' + named + ' needs a zoom of ' + plan.wanted.toFixed(1) + '; the zoom stops at ' + MAX_ZOOM + ', where it fills ' + ((fill * MAX_ZOOM) / plan.wanted).toFixed(2) + '. Zoom to a larger element around it.');
      else if (plan.wanted < 1)
        o.notes.push(at(index) + named + ' is larger than ' + fill + ' of the window, so the view only moves to it and does not enlarge. Zoom to a smaller element.');
    }
    const from = camera;
    for (let i = 1; i <= count; i++) {
      const t = easeAt(z.ease ?? 'in-out', i / count);
      camera = cameraBetween(from, plan.camera, t, view);
      if (plan.scrollY !== now.scrollY) await page.evaluate(([x, y]) => window.scrollTo(x, y), [now.scrollX, now.scrollY + (plan.scrollY - now.scrollY) * t] as const);
      yield await frame();
    }
    camera = plan.camera;
  }

  async function* mark(index: number, h: Extract<DirectStep, { highlight: unknown }>['highlight'], frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    const id = nextId++;
    await keep(await locate(index, h.to), id);
    const base: Highlight = { id, selector: h.to, style: h.style ?? 'box', color: h.color ?? DEFAULTS.color, pad: h.pad ?? DEFAULTS.pad, progress: 0, opacity: 1 };
    const count = h.frames ?? DEFAULTS.highlightFrames;
    for (let i = 1; i <= count; i++) {
      highlight = { ...base, progress: easeAt('in-out', i / count) };
      yield await frame();
    }
    const b = await page.evaluate((n) => window.__popostStage?.box(n) ?? null, id);
    if (b && !inPicture(b)) o.notes.push(at(index) + '"' + h.to + '" is not in the picture, so its highlight is not seen; scroll or zoom to it first.');
    else if (b && o.band !== undefined) {
      const bottom = toWindow(camera, { x: b[0], y: b[1] + b[3] }).y + base.pad;
      if (bottom > o.band + 2) o.notes.push(at(index) + 'the highlight of "' + h.to + '" lies under the caption band: its box reaches ' + share(bottom, view) + ' of the height and the band starts at ' + share(o.band, view) + ', so the captions will cover it; scroll or zoom so that it sits higher.');
    }
  }

  async function* clear(index: number, count: number, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    const base = highlight;
    if (!base) o.notes.push(at(index) + 'there is no highlight to clear; its frames hold the page.');
    for (let i = 1; i <= count; i++) {
      if (base) highlight = { ...base, opacity: 1 - i / count };
      yield await frame();
    }
    highlight = undefined;
  }

  async function* type(index: number, t: Extract<DirectStep, { type: unknown }>['type'], frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    const handle = await locate(index, t.into);
    try {
      await handle.fill('', { timeout: 3000 });
      await handle.focus();
    } catch {
      throw new CaptureError(at(index) + '"' + t.into + '" is not a field that takes text (an input, a textarea or an editable element).');
    }
    const chars = Array.from(t.text);
    const count = t.frames ?? DEFAULTS.typeFrames;
    let typed = 0;
    for (let i = 1; i <= count; i++) {
      const upTo = Math.round((chars.length * i) / count);
      const piece = chars.slice(typed, upTo).join('');
      typed = upTo;
      // A new line is the Enter key, which may send a form: then the page loads, in real time, before the frame.
      if (piece) await (piece.includes('\n') ? settleAfter(() => page.keyboard.type(piece)) : page.keyboard.type(piece));
      yield await frame();
    }
  }

  async function* hover(index: number, selector: string, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    if (!pointer) {
      await (await locate(index, selector)).hover({ timeout: 5000 });
      yield await frame();
      return;
    }
    const to = await middleOf(index, selector, false);
    if (Math.hypot(to.x - pointer.x, to.y - pointer.y) > 1) yield* move(to, DEFAULTS.moveFrames, 'in-out', frame);
    else {
      await page.mouse.move(to.x, to.y);
      yield await frame();
    }
  }

  async function* click(index: number, selector: string, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    if (!pointer) {
      const handle = await locate(index, selector);
      await settleAfter(() => handle.click({ timeout: 5000 }));
      yield await frame();
      return;
    }
    const to = await middleOf(index, selector, true);
    if (Math.hypot(to.x - pointer.x, to.y - pointer.y) > 1) yield* move(to, DEFAULTS.moveFrames, 'in-out', frame);
    for (let f = 0; f < DEFAULTS.pressFrames; f++) {
      const p = pressAt(f);
      dip = p.dip;
      ring = { x: to.x, y: to.y, radius: p.ring * size, opacity: p.opacity };
      yield await frame();
      if (f === 1) await settleAfter(() => page.mouse.click(to.x, to.y));
    }
    dip = 0;
    ring = undefined;
  }

  async function* play(index: number, s: PlayedStep, frame: () => Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
    if ('zoom' in s) yield* zoom(index, s.zoom, frame);
    else if ('highlight' in s) yield* mark(index, s.highlight, frame);
    else if ('clear' in s) yield* clear(index, s.clear, frame);
    else if ('point' in s) yield* move(await middleOf(index, s.point.to, false), s.point.frames ?? DEFAULTS.pointFrames, s.point.ease ?? 'in-out', frame);
    else if ('pointer' in s) pointer = undefined;
    else if ('type' in s) yield* type(index, s.type, frame);
    else if ('hover' in s) yield* hover(index, s.hover, frame);
    else yield* click(index, s.click, frame);
  }

  const finish = (): { text: { smallestPx: number; medianPx: number } | null } => {
    const text = textSizes(textCounts);
    o.notes.push(...smallTextNote(text, o.outputHeight, o.zoom));
    for (const c of covering.values()) o.notes.push(overlayNote(c.fact, c.place, shareOf(c.seen, samples)));
    return { text };
  };

  return {
    shot,
    begin: (index) => { step = index; sampleNext = true; },
    play,
    finish,
  };
};
