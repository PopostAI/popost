/** Deterministic, DOM-free helpers for measured replication scenes. All times are frames, not wall time. */
import type { Ease } from '../types';
import { ease, lerp } from '../presets/easing';
import { MOTION_DEFAULTS, motionState } from '../presets/motion';
import { charsShown } from '../presets/spoken';
import { sourceFrame } from '../timeline/footage';

export type Point = readonly [number, number];
export type Box = readonly [number, number, number, number];
/** Canvas/SVG affine transform: x' = ax + cy + e, y' = bx + dy + f. */
export type Viewport = readonly [number, number, number, number, number, number];

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new Error(name + ' must be finite.');
  return value;
};
const integer = (value: number, name: string, min = 0): number => {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(name + ' must be an integer >= ' + min + '.');
  return value;
};
const point = (value: Point, name: string): Point => [finite(value[0], name), finite(value[1], name)];

export interface TypingSpec {
  text: string;
  start: number;
  /** Final source frame; includes pauses. Give exactly one of end or frames. */
  end?: number;
  /** Active typing frames; pauses add to this duration. */
  frames?: number;
  pauses?: readonly { after: number; frames: number }[];
  /** Measured cursor positions, including the empty prefix: grapheme count + 1 points. Supports wrapping/kerning. */
  cursorStops?: readonly Point[];
  /** Measured advances, one per grapheme. For kerning, use differences of measured prefix widths. */
  advances?: readonly number[];
  origin?: Point;
  lineHeight?: number;
  /** Half of the cursor blink cycle. The first half is visible. */
  blinkFrames?: number;
  hideWhenDone?: boolean;
}

/** Compile once with the intended font/layout; serialize this plan for identical browser playback. */
export interface TypingPlan {
  graphemes: string[];
  reveals: number[];
  cursors: Point[];
  start: number;
  end: number;
  blinkFrames: number;
  hideWhenDone: boolean;
}

export const compileTyping = (spec: TypingSpec): TypingPlan => {
  const start = integer(spec.start, 'start');
  const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(spec.text)].map((s) => s.segment);
  const count = graphemes.length;
  const pauses = (spec.pauses ?? []).map((p) => {
    integer(p.after, 'pause.after'); integer(p.frames, 'pause.frames');
    if (p.after >= count) throw new Error('A pause must precede a remaining grapheme.');
    return { ...p };
  });
  const held = pauses.reduce((n, p) => n + p.frames, 0);
  if ((spec.end === undefined) === (spec.frames === undefined)) throw new Error('Give exactly one of end or frames.');
  const frames = spec.end === undefined ? integer(spec.frames as number, 'frames') : integer(spec.end, 'end') - start - held;
  integer(frames, 'active typing frames', count ? 1 : 0);
  const end = integer(start + frames + held, 'end');
  let cursors: Point[];
  if (spec.cursorStops) {
    if (spec.advances) throw new Error('Give cursorStops or advances, not both.');
    if (spec.cursorStops.length !== count + 1) throw new Error('cursorStops needs one point per prefix, including empty.');
    cursors = spec.cursorStops.map((p) => point(p, 'cursorStops'));
  } else {
    if (!spec.advances || spec.advances.length !== count) throw new Error('Give one measured advance per grapheme, or cursorStops.');
    const origin = point(spec.origin ?? [0, 0], 'origin');
    const lineHeight = finite(spec.lineHeight ?? 1, 'lineHeight');
    if (lineHeight <= 0) throw new Error('lineHeight must be positive.');
    cursors = [origin];
    let [x, y] = origin;
    graphemes.forEach((glyph, i) => {
      const advance = finite(spec.advances?.[i] as number, 'advance');
      if (advance < 0) throw new Error('advance must be nonnegative.');
      if (/\r|\n/.test(glyph)) { x = origin[0]; y += lineHeight; } else x += advance;
      cursors.push([x, y]);
    });
  }
  const reveals = graphemes.map((_, i) => start + Math.ceil((i + 1) * frames / count) + pauses.filter((p) => p.after <= i).reduce((n, p) => n + p.frames, 0));
  return { graphemes, reveals, cursors, start, end, blinkFrames: integer(spec.blinkFrames ?? 15, 'blinkFrames', 1), hideWhenDone: spec.hideWhenDone ?? false };
};

export interface TypingState {
  text: string;
  count: number;
  done: boolean;
  cursor: { x: number; y: number; visible: boolean };
}

export const typingAt = (plan: TypingPlan, frame: number): TypingState => {
  const n = Math.floor(finite(frame, 'frame'));
  let lo = 0, hi = plan.reveals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((plan.reveals[mid] ?? Infinity) <= n) lo = mid + 1; else hi = mid;
  }
  const defaults = MOTION_DEFAULTS.type;
  const state = motionState({ ...defaults, preset: 'type', ease: defaults.ease.enter }, 'enter', plan.graphemes.length ? lo / plan.graphemes.length : 1);
  const count = charsShown({}, state, plan.graphemes.length, n);
  const cursor = plan.cursors[count] ?? [0, 0];
  const done = n >= plan.end;
  return { text: plan.graphemes.slice(0, count).join(''), count, done, cursor: { x: cursor[0], y: cursor[1], visible: n >= plan.start && !(done && plan.hideWhenDone) && Math.floor((n - plan.start) / plan.blinkFrames) % 2 === 0 } };
};

export interface OdometerSpec {
  from: number;
  to: number;
  start: number;
  /** Travel time of each column, not a whole-number count-up. */
  frames: number;
  places?: number;
  /** Delay per column, from least significant to most significant. */
  stagger?: number;
  /** Extra complete turns per column. Zero retains only the required digit travel. */
  turns?: number;
  ease?: Ease;
}
export interface DigitColumn { place: number; current: number; next: number; offset: number; direction: 1 | -1 }

/** Each digit has its own travel and fractional vertical offset. Clip each column to a fixed-size cell. */
export const odometerAt = (spec: OdometerSpec, frame: number): { columns: DigitColumn[]; done: boolean } => {
  integer(spec.from, 'from'); integer(spec.to, 'to'); integer(spec.start, 'start'); integer(spec.frames, 'frames', 1);
  const required = Math.max(String(spec.from).length, String(spec.to).length);
  const places = integer(spec.places ?? required, 'places', required);
  const stagger = integer(spec.stagger ?? 0, 'stagger');
  const turns = integer(spec.turns ?? 0, 'turns');
  if (places > 16 || !Number.isSafeInteger(turns * 10 + 9)) throw new Error('Odometer precision exceeds safe integer range.');
  finite(frame, 'frame');
  const direction = spec.to >= spec.from ? 1 : -1;
  const columns = Array.from({ length: places }, (_, index): DigitColumn => {
    const exponent = places - index - 1, place = 10 ** exponent;
    const from = Math.floor(spec.from / place) % 10, to = Math.floor(spec.to / place) % 10;
    const progress = ease(spec.ease ?? 'linear', (frame - spec.start - exponent * stagger) / spec.frames);
    if (progress >= 1) return { place, current: to, next: to, offset: 0, direction };
    const distance = ((to - from) * direction + 10) % 10 + turns * 10;
    const phase = distance * progress, step = Math.floor(phase);
    const current = ((from + direction * (step % 10)) % 10 + 10) % 10;
    return { place, current, next: distance ? (current + direction + 10) % 10 : current, offset: phase - step, direction };
  });
  return { columns, done: frame >= spec.start + spec.frames + (places - 1) * stagger };
};

export interface SceneClockSpec {
  fps: number;
  /** Source frame at local time zero, supplied by the final filled timeline rather than guessed reference seconds. */
  sourceStart: number;
  sourceFps?: number;
  sourceFrames?: number;
  speed?: number;
}

/** The scene renderer already clamps early transition exposure to local time zero. Negative input also holds zero. */
export const sceneClock = (localSeconds: number, spec: SceneClockSpec): { localFrame: number; sourceFrame: number } => {
  finite(localSeconds, 'localSeconds');
  const fps = finite(spec.fps, 'fps'), sourceFps = finite(spec.sourceFps ?? fps, 'sourceFps'), speed = finite(spec.speed ?? 1, 'speed');
  if (fps <= 0 || sourceFps <= 0 || speed < 0) throw new Error('Frame rates must be positive and speed nonnegative.');
  const start = integer(spec.sourceStart, 'sourceStart');
  const frames = integer(spec.sourceFrames ?? Number.MAX_SAFE_INTEGER, 'sourceFrames', 1);
  if (start >= frames) throw new Error('sourceStart must lie inside the source.');
  const localFrame = Math.max(0, Math.round(localSeconds * fps));
  return { localFrame, sourceFrame: sourceFrame({ start: 0, in: start, speed }, { fps: sourceFps, frames }, fps, localFrame) };
};

export interface MotionKey { frame: number; value: readonly number[]; ease?: Ease; hold?: boolean }

/** Interpolate positions, targets, focus or any other numeric state in one clock. Hold is a step at the next key. */
export const keyframeAt = (keys: readonly MotionKey[], frame: number): number[] => {
  finite(frame, 'frame');
  const first = keys[0];
  if (!first || !first.value.length) throw new Error('At least one nonempty key is required.');
  keys.forEach((k, i) => {
    integer(k.frame, 'key.frame');
    if (i > 0 && k.frame <= (keys[i - 1]?.frame ?? -1)) throw new Error('Key frames must be strictly increasing.');
    if (k.value.length !== first.value.length) throw new Error('Keys must have the same dimensions.');
    k.value.forEach((n) => finite(n, 'key.value'));
  });
  if (frame <= first.frame) return [...first.value];
  for (let i = 1; i < keys.length; i++) {
    const right = keys[i] as MotionKey, left = keys[i - 1] as MotionKey;
    if (frame < right.frame) {
      const p = left.hold ? 0 : ease(left.ease ?? 'linear', (frame - left.frame) / (right.frame - left.frame));
      return left.value.map((v, axis) => lerp(v, right.value[axis] as number, p));
    }
  }
  return [...(keys[keys.length - 1] as MotionKey).value];
};

const validViewport = (view: Viewport): void => { view.forEach((n) => finite(n, 'viewport')); };
export const viewportPoint = (p: Point, view: Viewport): Point => {
  validViewport(view); point(p, 'point');
  return [view[0] * p[0] + view[2] * p[1] + view[4], view[1] * p[0] + view[3] * p[1] + view[5]];
};
const validBox = (box: Box): void => {
  box.forEach((n) => finite(n, 'box'));
  if (box[2] < 0 || box[3] < 0) throw new Error('Box dimensions must be nonnegative.');
};
/** Axis-aligned extent of all four transformed corners; use viewportPoint for a rotated outline. */
export const viewportBox = (box: Box, view: Viewport): Box => {
  validBox(box);
  const [x, y, w, h] = box;
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map((p) => viewportPoint(p as [number, number], view));
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
};
/** Endpoints follow the same source-space transform as their text/box, including rotation and scale. */
export const viewportUnderline = (box: Box, view: Viewport, gap = 0): readonly [Point, Point] => {
  validBox(box); finite(gap, 'gap');
  return [viewportPoint([box[0], box[1] + box[3] + gap], view), viewportPoint([box[0] + box[2], box[1] + box[3] + gap], view)];
};

export interface LayoutBox { id: string; box: Box }
/** Actual measured label/number bounds belong here; this reports conflicts instead of silently shrinking text. */
export const layoutConflicts = (items: readonly LayoutBox[], gap = 0): { a: string; b: string }[] => {
  finite(gap, 'gap');
  if (gap < 0) throw new Error('gap must be nonnegative.');
  const ids = new Set<string>();
  for (const item of items) {
    validBox(item.box);
    if (!item.id || ids.has(item.id)) throw new Error('Layout ids must be nonempty and unique.');
    ids.add(item.id);
  }
  const conflicts: { a: string; b: string }[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i] as LayoutBox, b = items[j] as LayoutBox;
    if (!a.box[2] || !a.box[3] || !b.box[2] || !b.box[3]) continue;
    if (a.box[0] < b.box[0] + b.box[2] + gap && b.box[0] < a.box[0] + a.box[2] + gap && a.box[1] < b.box[1] + b.box[3] + gap && b.box[1] < a.box[1] + a.box[3] + gap) conflicts.push({ a: a.id, b: b.id });
  }
  return conflicts;
};
