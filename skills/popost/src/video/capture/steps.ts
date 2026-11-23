/**
 * The directing steps of a capture plan and the pure geometry behind them: where the camera ends after a zoom, the
 * pointer's path, the sizes of what is drawn. Nothing here touches the page; director.ts plays the steps.
 *
 * Coordinates: "page" is CSS pixels from the top left of the document; "layout" is CSS pixels of the browser window
 * (what getBoundingClientRect and the mouse use: page minus the scroll position); "window" is CSS pixels of the
 * recorded picture. Without a zoom, layout and window are the same. A camera { s, x, y } shows the layout rectangle
 * (x, y, width / s, height / s) as the whole picture, so a layout point p is seen at s * (p - (x, y)).
 */
import { clamp01, ease as easeAt, lerp } from '../presets/easing';
import type { Ease } from '../types';

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type View = { width: number; height: number };

/** A plan that cannot be recorded, or a page that answered with an error: the message says what to change. */
export class CaptureError extends Error {
  override name = 'CaptureError';
}

export type HighlightStyle = 'box' | 'underline' | 'spot';

/** The steps that direct the viewer's eye; the plan's other steps are in index.ts. */
export type DirectStep =
  | { zoom: { to: string | [number, number, number, number]; frames?: number; fill?: number; ease?: Ease } }
  | { highlight: { to: string; frames?: number; color?: string; pad?: number; style?: HighlightStyle } }
  | { clear: number }
  | { point: { to: string; frames?: number; ease?: Ease } }
  | { pointer: 'hide' }
  | { type: { into: string; text: string; frames?: number } };

export const DEFAULTS = {
  zoomFrames: 20, fill: 0.7, highlightFrames: 12, color: '#e5342b', pad: 6, pointFrames: 18, typeFrames: 30,
  /** A hover or a click moves a shown pointer to its element in this many frames first. */
  moveFrames: 12,
  /** A click with a pointer shown: the press (the pointer dips, a ring grows and fades), the click after its second frame. */
  pressFrames: 8,
} as const;

/** The largest zoom: past it a page's pixels are mostly blur and the viewer loses where on the page they are. */
export const MAX_ZOOM = 3;

export type Camera = { s: number; x: number; y: number };
export const WHOLE: Camera = { s: 1, x: 0, y: 0 };
export const isWhole = (c: Camera): boolean => Math.abs(c.s - 1) < 1e-6 && Math.abs(c.x) < 0.01 && Math.abs(c.y) < 0.01;

const EASES: readonly string[] = ['linear', 'in', 'out', 'in-out'];
const STYLES: readonly string[] = ['box', 'underline', 'spot'];
const KEYS = ['hold', 'scroll', 'hover', 'click', 'wait', 'zoom', 'highlight', 'clear', 'point', 'pointer', 'type'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const text = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** What is wrong with one step of a plan, in words for whoever wrote it; the frame counts of hold and scroll are checked by the caller. */
export const stepProblems = (step: unknown, i: number): string[] => {
  const at = 'steps[' + i + ']: ';
  if (!isRecord(step)) return [at + 'a step is an object such as { "hold": 30 }.'];
  const keys = Object.keys(step);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !KEYS.includes(key)) return [at + 'a step has one of the keys ' + KEYS.join(', ') + '; got ' + (keys.join(', ') || 'none') + '.'];
  const v = step[key];
  const out: string[] = [];
  const frames = (f: unknown): void => { if (f !== undefined && !whole(f)) out.push(at + key + '.frames must be a whole number of at least 1.'); };
  const easeOk = (e: unknown): void => { if (e !== undefined && !EASES.includes(e as string)) out.push(at + key + '.ease is one of ' + EASES.join(', ') + '.'); };
  if (key === 'hover' || key === 'click') { if (!text(v)) out.push(at + key + ' takes a selector of the element, for example "button.buy".'); }
  else if (key === 'clear') { if (!whole(v)) out.push(at + 'clear takes the number of frames of the fade, for example { "clear": 10 }.'); }
  else if (key === 'pointer') { if (v !== 'hide') out.push(at + 'pointer takes "hide"; a point step shows the pointer.'); }
  else if (key === 'zoom') {
    if (!isRecord(v)) return [at + 'zoom takes { "to": "<selector>" | "page" | [x, y, width, height], "frames": 20 }.'];
    const to = v.to;
    const box = Array.isArray(to) && to.length === 4 && to.every((n) => typeof n === 'number' && Number.isFinite(n)) && (to[2] as number) > 0 && (to[3] as number) > 0;
    if (!text(to) && !box) out.push(at + 'zoom.to is a selector, "page", or [x, y, width, height] in page pixels with a width and height above 0.');
    if (v.fill !== undefined && !(typeof v.fill === 'number' && v.fill > 0 && v.fill <= 1)) out.push(at + 'zoom.fill is the share of the window the element fills, above 0 and at most 1 (default 0.7).');
    frames(v.frames); easeOk(v.ease);
  } else if (key === 'highlight') {
    if (!isRecord(v) || !text(v.to)) return [at + 'highlight takes { "to": "<selector>", "frames": 12 }.'];
    if (v.style !== undefined && !STYLES.includes(v.style as string)) out.push(at + 'highlight.style is one of ' + STYLES.join(', ') + '.');
    if (v.pad !== undefined && !(typeof v.pad === 'number' && v.pad >= 0 && v.pad <= 200)) out.push(at + 'highlight.pad is the space around the element in window pixels, 0 to 200.');
    if (v.color !== undefined && !text(v.color)) out.push(at + 'highlight.color is a CSS colour such as "#e5342b".');
    frames(v.frames);
  } else if (key === 'point') {
    if (!isRecord(v) || !text(v.to)) return [at + 'point takes { "to": "<selector>", "frames": 18 }.'];
    frames(v.frames); easeOk(v.ease);
  } else if (key === 'type') {
    if (!isRecord(v) || !text(v.into) || typeof v.text !== 'string' || v.text === '') return [at + 'type takes { "into": "<selector of the input>", "text": "what to type", "frames": 30 }.'];
    frames(v.frames);
  }
  return out;
};

/** The most frames a step records, for the plan's limit; hover and click count their pointer's move and press. */
export const stepFrames = (step: DirectStep | { hover: string } | { click: string }): number => {
  if ('zoom' in step) return step.zoom.frames ?? DEFAULTS.zoomFrames;
  if ('highlight' in step) return step.highlight.frames ?? DEFAULTS.highlightFrames;
  if ('clear' in step) return step.clear;
  if ('point' in step) return step.point.frames ?? DEFAULTS.pointFrames;
  if ('type' in step) return step.type.frames ?? DEFAULTS.typeFrames;
  if ('hover' in step) return DEFAULTS.moveFrames;
  if ('click' in step) return DEFAULTS.moveFrames + DEFAULTS.pressFrames;
  return 0;
};

/** The CSS window for a picture of width x height drawn zoom times larger: a 960x720 picture at zoom 1.5 lays the page out in 640x480. */
export const cssView = (width: number, height: number, zoom = 1): View => ({ width: Math.ceil(width / zoom - 1e-9), height: Math.ceil(height / zoom - 1e-9) });

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface ZoomPlan {
  camera: Camera;
  /** Where the page is scrolled at the end of the zoom. */
  scrollY: number;
  /** The scale that filling would need, before it was held between 1 and MAX_ZOOM. */
  wanted: number;
  /** With a caption band: how many window pixels of the box still lie under the band's top (absent when none do). */
  under?: number;
}

/**
 * The end of a zoom to a box given in page pixels: the scale that makes it fill `fill` of the window's width or height,
 * whichever limits (held between 1 and MAX_ZOOM), and the camera that puts its centre in the middle of the window. The
 * page scrolls only when the camera cannot reach the box from where the page is, and then as little as it must; the
 * camera never shows beyond the window, so a box at an edge of the page sits off the middle.
 * band: the top of the caption band in window pixels. The box then fills `fill` of the room above the band and is
 * centred in that room, so that the captions do not cover it; `under` says by how much it still reaches under the band
 * when the camera cannot do that (the box at the bottom of a page that scrolls no further, or taller than the room).
 */
export const zoomPlan = (box: Box, at: { scrollX: number; scrollY: number; maxScroll: number }, view: View, fill: number, band?: number): ZoomPlan => {
  const room = band !== undefined && band > 0 && band < view.height ? band : view.height;
  const wanted = Math.min((fill * view.width) / box.width, (fill * room) / box.height);
  const s = clamp(wanted, 1, MAX_ZOOM);
  const w = view.width / s;
  const h = view.height / s;
  const top = box.y + box.height / 2 - room / (2 * s);
  let scrollY = at.scrollY;
  if (top < scrollY) scrollY = Math.max(0, top);
  else if (top > scrollY + view.height - h) scrollY = Math.min(at.maxScroll, top - (view.height - h));
  const x = clamp(box.x + box.width / 2 - at.scrollX - w / 2, 0, view.width - w);
  const y = clamp(top - scrollY, 0, view.height - h);
  const under = s * (box.y + box.height - scrollY - y) - room;
  return { camera: { s, x, y }, scrollY, wanted, ...(room < view.height && under > 0.5 ? { under: Math.round(under) } : {}) };
};

/** A camera part of the way from a to b: the shown rectangle moves and resizes linearly, so the zoom has no wobble. */
export const cameraBetween = (a: Camera, b: Camera, t: number, view: View): Camera => {
  const w = lerp(view.width / a.s, view.width / b.s, t);
  return { s: view.width / w, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
};

/** Where a layout point is seen in the picture, in window pixels. */
export const toWindow = (c: Camera, p: Point): Point => ({ x: c.s * (p.x - c.x), y: c.s * (p.y - c.y) });
/** The layout point seen at a window point. */
export const toLayout = (c: Camera, p: Point): Point => ({ x: c.x + p.x / c.s, y: c.y + p.y / c.s });

/** The length of the pointer's arrow, in window pixels: 3.4% of the window's shorter side, as large in any size. */
export const pointerSize = (view: View): number => clamp(Math.round(0.034 * Math.min(view.width, view.height)), 14, 48);
/** The width of a highlight's line, in window pixels. */
export const lineWidth = (view: View): number => Math.max(2, Math.round(0.009 * Math.min(view.width, view.height)) / 2);

/** Where a pointer that has never been shown starts: just outside the lower right of the picture. */
export const pointerStart = (c: Camera, view: View): Point => toLayout(c, { x: view.width + pointerSize(view) * 0.6, y: view.height + pointerSize(view) * 0.6 });

/**
 * The pointer's position at progress t of a move from a to b: a slightly curved path (the control point a seventh of
 * the distance to the side, bowing upwards, as a hand moves a mouse), eased.
 */
export const pointerAt = (a: Point, b: Point, t: number, kind: Ease = 'in-out'): Point => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let nx = len ? -dy / len : 0;
  let ny = len ? dx / len : 0;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const cx = (a.x + b.x) / 2 + nx * len / 7;
  const cy = (a.y + b.y) / 2 + ny * len / 7;
  const u = easeAt(kind, t);
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * cx + u * u * b.x, y: v * v * a.y + 2 * v * u * cy + u * u * b.y };
};

/** The press of a click at frame f of DEFAULTS.pressFrames: how far the pointer dips (0..1) and the ring (radius as a share of the pointer's size, opacity). */
export const pressAt = (f: number): { dip: number; ring: number; opacity: number } => {
  const n = DEFAULTS.pressFrames - 1;
  const dip = f < 2 ? (f + 1) / 2 : clamp01(1 - (f - 1) / 3);
  return { dip, ring: lerp(0.3, 1.1, easeAt('out', f / n)), opacity: 0.85 * (1 - f / n) };
};

/** The font size, in output pixels, that half of the visible characters are at or above, and the smallest. */
export const textSizes = (counts: ReadonlyMap<number, number>): { smallestPx: number; medianPx: number } | null => {
  const sizes = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const total = sizes.reduce((n, [, c]) => n + c, 0);
  const first = sizes[0];
  if (!first || !total) return null;
  let seen = 0;
  for (const [px, n] of sizes) {
    seen += n;
    if (seen >= total / 2) return { smallestPx: Math.round(first[0] * 10) / 10, medianPx: Math.round(px * 10) / 10 };
  }
  return null;
};

/** A --zoom that brings the median text to about 2.5% of the picture's height, in quarter steps, at most MAX_ZOOM. */
export const zoomForText = (medianPx: number, outputHeight: number, current = 1): number =>
  Math.min(MAX_ZOOM, Math.ceil(((0.025 * outputHeight) / medianPx) * current * 4) / 4);
