/**
 * The curve of one moving thing: inside a region and a span of frames, the thing that differs from the ground is
 * followed frame by frame (its box: centre, width, height; and how much of the region it inks), and its main move is
 * described in numbers a scene can be written from: where it starts and ends, how long it takes, how far it goes, its
 * peak speed, how far it overshoots, how often it turns back before it rests and when it rests, how much it is
 * squashed and stretched on the way, and the closest named easing (easing.ts) with the error of the fit.
 *
 * Ported from the `measure curve` command of HyperFrames (https://github.com/heygen-com/hyperframes,
 * packages/cli/src/measure/curve.ts, Copyright HeyGen, licensed under the Apache License 2.0): the tracking of a box
 * against a flat ground taken from the region's border, the split of a property into moves separated by holds, the
 * pulse (a stretch that returns to where it began) and the fit of normalised progress are theirs. Changed here: it
 * runs on this engine's decoded frames and Runtime instead of OpenCV-free ffmpeg calls of their CLI; a ground that is
 * not flat is taken per pixel as the median over the span; the move along the path (not one axis at a time) is
 * fitted; turns, settle time, peak speed and squash / stretch are added; the eases carry the Skill's names.
 */
import type { MeasuredMove } from '../types';
import { fitEase } from './easing';

export interface Frames { width: number; height: number; fps: number; frames: readonly Uint8Array[] }
/** A region in pixels of the decoded frames. */
export interface Roi { x: number; y: number; w: number; h: number }

/** One frame of the thing: its box's centre and size in pixels of the decoded frame (undefined when it is not there) and its ink. */
export interface Row { x?: number; y?: number; w: number; h: number; ink: number }

export type Prop = 'path' | 'x' | 'y' | 'w' | 'h' | 'ink';

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** A pixel differs from the ground by this much (the largest of its three channel differences) or it is ground. */
export const INK_THRESHOLD = 24;

/**
 * The ground of the region: flat (the median colour of the region's border on the first frame) when the border is
 * nearly one colour, else each pixel's median over the frames (what stays while the thing moves across it).
 */
const groundOf = (f: Frames, roi: Roi): { flat?: [number, number, number]; perPixel?: Uint8Array } => {
  const first = f.frames[0] as Uint8Array;
  const border: number[][] = [[], [], []];
  for (let y = roi.y; y < roi.y + roi.h; y++) for (let x = roi.x; x < roi.x + roi.w; x++) {
    if (x - roi.x >= 2 && y - roi.y >= 2 && x < roi.x + roi.w - 2 && y < roi.y + roi.h - 2) continue;
    for (let c = 0; c < 3; c++) (border[c] as number[]).push(first[(y * f.width + x) * 3 + c] ?? 0);
  }
  const flat = border.map(median) as [number, number, number];
  const off = (border[0] as number[]).filter((_v, i) => Math.max(...[0, 1, 2].map((c) => Math.abs(((border[c] as number[])[i] ?? 0) - flat[c as 0 | 1 | 2]))) > INK_THRESHOLD / 2).length;
  if (off <= 0.1 * (border[0] as number[]).length) return { flat };
  const perPixel = new Uint8Array(roi.w * roi.h * 3);
  const pick = f.frames.filter((_f, i) => i % Math.max(1, Math.floor(f.frames.length / 15)) === 0);
  for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) for (let c = 0; c < 3; c++)
    perPixel[(y * roi.w + x) * 3 + c] = median(pick.map((fr) => fr[((roi.y + y) * f.width + roi.x + x) * 3 + c] ?? 0));
  return { perPixel };
};

/** The thing's box and ink on every frame. */
export const trackRows = (f: Frames, roi: Roi, threshold = INK_THRESHOLD): Row[] => {
  const g = groundOf(f, roi);
  return f.frames.map((fr): Row => {
    const xs: number[] = [], ys: number[] = [];
    let ink = 0;
    for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) {
      const j = ((roi.y + y) * f.width + roi.x + x) * 3, k = (y * roi.w + x) * 3;
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs((fr[j + c] ?? 0) - (g.flat ? g.flat[c as 0 | 1 | 2] : g.perPixel?.[k + c] ?? 0))));
      ink += d;
      if (d > threshold) { xs.push(x); ys.push(y); }
    }
    const share = round(ink / (roi.w * roi.h), 2);
    if (xs.length < 4) return { w: 0, h: 0, ink: share };
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (v: number[], p: number): number => v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
    const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
    return { x: roi.x + (x0 + x1 + 1) / 2, y: roi.y + (y0 + y1 + 1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1, ink: share };
  });
};

interface Stretch { a: number; b: number; pulse: boolean; peak: number }

/**
 * The stretches of change of one series, separated by holds of 0.15 s or more (a shorter still is the turn at an
 * overshoot's peak). A stretch that ends where it began is a pulse. quant: a step this small is no change.
 */
export const stretchesOf = (v: readonly number[], fps: number, minChange: number, quant: number): Stretch[] => {
  const out: Stretch[] = [];
  const hold = Math.max(3, Math.round(0.15 * fps));
  for (let i = 0; i < v.length - 1;) {
    if (Math.abs((v[i + 1] as number) - (v[i] as number)) <= quant) { i++; continue; }
    let b = i + 1, still = 0;
    for (let j = i + 1; j < v.length - 1 && still < hold; j++) {
      if (Math.abs((v[j + 1] as number) - (v[j] as number)) <= quant) still++;
      else { still = 0; b = j + 1; }
    }
    const span = (v[b] as number) - (v[i] as number);
    const peak = v.slice(i, b + 1).reduce((m, x) => (Math.abs(x - (v[i] as number)) > Math.abs(m - (v[i] as number)) ? x : m), v[i] as number);
    // A creep of a pixel before the move really starts is compression noise, not the move. It is judged on how far
    // the value has come, not step by step: the slow first steps of an ease-in belong to the move.
    let a = i;
    while (a < b - 2 && Math.abs((v[a + 1] as number) - (v[i] as number)) < Math.max(2 * quant, 0.005 * Math.abs(span))) a++;
    if (Math.abs(span) >= minChange) out.push({ a, b, pulse: false, peak });
    else if (Math.abs(peak - (v[i] as number)) >= minChange) out.push({ a: i, b, pulse: true, peak });
    i = b;
  }
  return out;
};

/** One move in numbers (types.ts, MeasuredMove). */
export type MoveCurve = MeasuredMove;

/** A stretch that returns to where it began: its peak and length, no ease. */
export interface Pulse { prop: Prop; pulse: true; start: number; duration: number; frames: number; peak: number }

/** rows: the frames the thing was seen on; box: the median share of the region its box covers. */
export interface Curves { fps: number; roi: [number, number, number, number]; rows: number; box: number; moves: MoveCurve[]; pulses: Pulse[] }

const turnsOf = (p: readonly number[]): number => {
  let turns = 0, dir = 0;
  for (let i = 1; i < p.length; i++) {
    const d = (p[i] as number) - (p[i - 1] as number);
    if (Math.abs(d) < 0.01) continue;
    const s = Math.sign(d);
    if (dir !== 0 && s !== dir) turns++;
    dir = s;
  }
  return turns;
};

const squashOf = (rows: readonly Row[], a: number, b: number): MoveCurve['squash'] => {
  const rest = rows[b];
  if (!rest || !rest.w || !rest.h) return undefined;
  const base = rest.h / rest.w;
  const ratios = rows.slice(a, b + 1).flatMap((r) => (r.w >= 3 && r.h >= 3 ? [r.h / r.w / base] : []));
  if (ratios.length < 3) return undefined;
  const stretch = round(Math.max(...ratios), 2), squash = round(Math.min(...ratios), 2);
  return stretch >= 1.08 || squash <= 0.92 ? { stretch, squash } : undefined;
};

interface Scale { width: number; height: number; fps: number; startFrame: number }

const describeMove = (prop: Prop, v: readonly number[], s: Stretch, rows: readonly Row[], sc: Scale, ends: (i: number) => number[], pxDistance?: number): MoveCurve => {
  const v0 = v[s.a] as number, span = (v[s.b] as number) - v0;
  const p = v.slice(s.a, s.b + 1).map((x) => (x - v0) / span);
  const settleAt = (() => { let k = p.length - 1; while (k > 0 && Math.abs((p[k - 1] as number) - 1) <= 0.02) k--; return k; })();
  const speeds = v.slice(s.a, s.b + 1).map((x, i, arr) => (i ? Math.abs(x - (arr[i - 1] as number)) * sc.fps : 0));
  const turns = turnsOf(p);
  const squash = prop === 'path' || prop === 'x' || prop === 'y' ? squashOf(rows, s.a, s.b) : undefined;
  return {
    prop, start: round((sc.startFrame + s.a) / sc.fps), end: round((sc.startFrame + s.b) / sc.fps), duration: round((s.b - s.a) / sc.fps), frames: s.b - s.a,
    from: ends(s.a), to: ends(s.b),
    ...(pxDistance !== undefined ? { distance: round(pxDistance / sc.width), peakSpeed: round(Math.max(...speeds) / sc.width, 2) } : {}),
    overshoot: round(Math.max(0, Math.max(...p) - 1) * 100, 1), anticipation: round(Math.max(0, -Math.min(...p)) * 100, 1),
    turns, bounces: Math.ceil(turns / 2), settle: round(settleAt / sc.fps),
    ...(squash ? { squash } : {}),
    fit: fitEase(p), curve: Array.from({ length: 21 }, (_v, i) => round(p[Math.round((i / 20) * (p.length - 1))] as number)),
  };
};

/**
 * Every move of the thing in the region, the largest first. The position is fitted along the straight line from
 * where the thing starts to where it rests (so a diagonal move is one move, and a bounce shows as turns on it); width,
 * height and ink are fitted when the position does not move.
 */
export const curvesOf = (f: Frames, roi: Roi, o: { startFrame?: number; threshold?: number } = {}): Curves => {
  const rows = trackRows(f, roi, o.threshold);
  const sc: Scale = { width: f.width, height: f.height, fps: f.fps, startFrame: o.startFrame ?? 0 };
  const seen = rows.flatMap((r, i) => (r.x !== undefined && r.y !== undefined ? [i] : []));
  const at = (i: number): Row => rows[seen[i] as number] as Row;
  const moves: MoveCurve[] = [], pulses: Pulse[] = [];
  const minPx = 0.02 * Math.max(roi.w, roi.h);
  const frac = (r: Row): number[] => [round((r.x ?? 0) / f.width), round((r.y ?? 0) / f.height)];
  const shift: Scale = { ...sc, startFrame: sc.startFrame + (seen[0] ?? 0) };
  if (seen.length >= 4) {
    const first = at(0), last = at(seen.length - 1);
    const dx = (last.x ?? 0) - (first.x ?? 0), dy = (last.y ?? 0) - (first.y ?? 0), len = Math.hypot(dx, dy);
    // Along the line from the first place to the last; a thing that returns (a bounce in place) is followed on the axis it moves most on.
    const xs = seen.map((_s, i) => at(i).x ?? 0), ys = seen.map((_s, i) => at(i).y ?? 0);
    const rangeX = Math.max(...xs) - Math.min(...xs), rangeY = Math.max(...ys) - Math.min(...ys);
    const along = len >= minPx ? seen.map((_s, i) => (((at(i).x ?? 0) - (first.x ?? 0)) * dx + ((at(i).y ?? 0) - (first.y ?? 0)) * dy) / len) : rangeY >= rangeX ? ys : xs;
    const prop: Prop = len >= minPx ? 'path' : rangeY >= rangeX ? 'y' : 'x';
    for (const s of stretchesOf(along, f.fps, minPx, 0.5)) {
      if (s.pulse) pulses.push({ prop, pulse: true, start: round((shift.startFrame + s.a) / f.fps), duration: round((s.b - s.a) / f.fps), frames: s.b - s.a, peak: round(Math.abs(s.peak - (along[s.a] as number)) / f.width) });
      else moves.push(describeMove(prop, along, s, seen.map((i) => rows[i] as Row), shift, (i) => frac(at(i)), Math.abs((along[s.b] as number) - (along[s.a] as number))));
    }
    for (const size of ['w', 'h'] as const) {
      const v = seen.map((_s, i) => at(i)[size]);
      for (const s of stretchesOf(v, f.fps, minPx, 1)) if (!s.pulse) moves.push(describeMove(size, v, s, [], shift, (i) => [round((v[i] as number) / (size === 'w' ? f.width : f.height))]));
    }
  }
  if (!moves.length) {
    const ink = rows.map((r) => r.ink);
    for (const s of stretchesOf(ink, f.fps, 2, 0.5)) if (!s.pulse) moves.push(describeMove('ink', ink, s, [], sc, (i) => [ink[i] as number]));
  }
  // The largest first: a position move before a size move, then by how much of the span it takes.
  const rank = (m: MoveCurve): number => (m.prop === 'path' || m.prop === 'x' || m.prop === 'y' ? 2 : m.prop === 'ink' ? 0 : 1);
  moves.sort((a, b) => rank(b) - rank(a) || (b.distance ?? 0) - (a.distance ?? 0) || b.frames - a.frames || a.start - b.start);
  return { fps: round(f.fps, 2), roi: [round(roi.x / f.width), round(roi.y / f.height), round(roi.w / f.width), round(roi.h / f.height)], rows: seen.length, box: round(median(seen.map((i) => ((rows[i] as Row).w * (rows[i] as Row).h) / (roi.w * roi.h))), 3), moves, pulses };
};

const pctText = (v: number): string => (Math.round(v * 10) / 10) + '%';

/** One sentence a person can read, for a move. */
export const moveSentence = (m: MoveCurve): string => {
  const what = m.prop === 'path' || m.prop === 'x' || m.prop === 'y' ? 'moves ' + (m.distance !== undefined ? (m.distance * 100).toFixed(0) + '% of the canvas width' : '') + ' from [' + m.from.join(', ') + '] to [' + m.to.join(', ') + ']'
    : m.prop === 'ink' ? 'appears (its ink goes from ' + m.from[0] + ' to ' + m.to[0] + ')' : (m.prop === 'w' ? 'its width' : 'its height') + ' goes from ' + m.from[0] + ' to ' + m.to[0] + ' of the canvas';
  return 'From ' + m.start + ' s it ' + what + ' in ' + m.duration + ' s (' + m.frames + ' frames)'
    + (m.peakSpeed !== undefined ? ', peak speed ' + m.peakSpeed + ' canvas widths a second' : '')
    + (m.overshoot >= 1 ? ', overshoots by ' + pctText(m.overshoot) : ', no overshoot')
    + (m.anticipation >= 1 ? ', pulls back ' + pctText(m.anticipation) + ' first' : '')
    + (m.turns ? ', turns back ' + m.turns + ' time' + (m.turns === 1 ? '' : 's') + ' (' + m.bounces + ' bounce' + (m.bounces === 1 ? '' : 's') + ') and rests after ' + m.settle + ' s' : '')
    + (m.squash ? ', stretched to ' + m.squash.stretch + ' and squashed to ' + m.squash.squash + ' of its resting height over width' : '')
    + '; closest ease ' + m.fit.ease + ' (error ' + m.fit.error + (m.fit.next[0] ? '; next ' + m.fit.next.map((n) => n.ease + ' ' + n.error).join(', ') : '') + ').';
};

/** What to paste: the Skill's motion helper and GSAP. */
export const movePaste = (m: MoveCurve): { helper: string; gsap: string } => ({
  helper: "popostMotion.ease('" + m.fit.ease + "')(popostMotion.clamp01((seconds - START) / " + m.duration + '))',
  gsap: "{ duration: " + m.duration + ", ease: '" + m.fit.gsap + "' }" + (m.fit.gsapExact ? '' : "  // nearest GSAP ease; the exact curve is the helper's '" + m.fit.ease + "'"),
});
