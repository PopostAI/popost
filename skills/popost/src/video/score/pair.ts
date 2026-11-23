/**
 * Pairing helpers: boundaries by time, shots by overlap, motion events by time and place. All greedy and one to one,
 * best first, ties broken by index, so the result is deterministic. Times are seconds (the videos may differ in
 * frame rate).
 */
import type { Box, Measure, MotionEvent, ShotMeasure } from '../types';

export interface Pair { r: number; o: number; d: number }

/** Greedy one-to-one matching of candidate pairs, smallest d first. */
export const matchGreedy = (cands: Pair[]): Pair[] => {
  const used = { r: new Set<number>(), o: new Set<number>() };
  const out: Pair[] = [];
  for (const p of [...cands].sort((a, b) => a.d - b.d || a.r - b.r || a.o - b.o)) {
    if (used.r.has(p.r) || used.o.has(p.o)) continue;
    used.r.add(p.r);
    used.o.add(p.o);
    out.push(p);
  }
  return out.sort((a, b) => a.r - b.r);
};

export const fpsOf = (m: Measure): number => (m.source.fps > 0 ? m.source.fps : 30);

/** Boundaries whose takeover frames are within tol seconds, the other's moved back by offset. d = |difference| in seconds. */
export const pairBoundaries = (ref: Measure, other: Measure, tol: number, offset = 0): Pair[] => {
  const fr = fpsOf(ref), fo = fpsOf(other);
  const cands: Pair[] = [];
  ref.boundaries.forEach((a, r) => other.boundaries.forEach((b, o) => {
    const d = Math.abs(a.frame / fr + offset - b.frame / fo);
    if (d <= tol + 1e-9) cands.push({ r, o, d });
  }));
  return matchGreedy(cands);
};

/** How far the other video's boundaries may be moved, all together, to pair with the reference's (seconds). */
export const MAX_OFFSET = 0.5;

/**
 * The one shift of the other video (seconds, later is positive) that pairs the most boundaries within tol, from the
 * differences between boundaries at most MAX_OFFSET apart; the smallest of equals. 0 unless the shift pairs more than
 * none does and at least half of the fewer boundaries (two at least): a shift of the whole video, not one boundary that
 * happens to fall near another. A render that starts a few frames late pairs nothing within two frames otherwise.
 */
export const boundaryOffset = (ref: Measure, other: Measure, tol: number): number => {
  const fr = fpsOf(ref), fo = fpsOf(other);
  const shifts = new Set<number>();
  for (const a of ref.boundaries) for (const b of other.boundaries) {
    const d = b.frame / fo - a.frame / fr;
    if (Math.abs(d) <= MAX_OFFSET && Math.abs(d) > tol) shifts.add(Math.round(d * 1000) / 1000);
  }
  const whole = Math.max(2, Math.ceil(Math.min(ref.boundaries.length, other.boundaries.length) / 2));
  let best = 0, most = pairBoundaries(ref, other, tol).length;
  for (const s of [...shifts].sort((x, y) => Math.abs(x) - Math.abs(y) || x - y)) {
    const n = pairBoundaries(ref, other, tol, s).length;
    if (n > most && n >= whole) { best = s; most = n; }
  }
  return best;
};

export const intervalIoU = (a: [number, number], b: [number, number]): number => {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
  return union > 0 ? inter / union : a[0] === b[0] ? 1 : 0;
};

const shotSeconds = (s: ShotMeasure, fps: number): [number, number] => [s.start / fps, s.end / fps];

/** Shots that overlap in time by at least half (IoU), best overlap first. d = 1 - IoU. */
export const pairShots = (ref: Measure, other: Measure): Pair[] => {
  const fr = fpsOf(ref), fo = fpsOf(other);
  const cands: Pair[] = [];
  ref.shots.forEach((a, r) => other.shots.forEach((b, o) => {
    const iou = intervalIoU(shotSeconds(a, fr), shotSeconds(b, fo));
    if (iou >= 0.5) cands.push({ r, o, d: 1 - iou });
  }));
  return matchGreedy(cands);
};

export const boxIoU = (a: Box, b: Box): number => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
};

export interface TimedEvent { e: MotionEvent; t0: number; t1: number }

export const allEvents = (m: Measure): TimedEvent[] => {
  const fps = fpsOf(m);
  return m.shots.flatMap((s) => s.events.map((e) => ({ e, t0: e.start / fps, t1: e.end / fps })));
};

/** Events whose starts are within 0.5 s and whose boxes overlap (IoU at least 0.2). d mixes the two. */
export const pairEvents = (ref: TimedEvent[], other: TimedEvent[]): Pair[] => {
  const cands: Pair[] = [];
  ref.forEach((a, r) => other.forEach((b, o) => {
    const dt = Math.abs(a.t0 - b.t0), iou = boxIoU(a.e.box, b.e.box);
    if (dt <= 0.5 && iou >= 0.2) cands.push({ r, o, d: dt / 0.5 + (1 - iou) });
  }));
  return matchGreedy(cands);
};

/** Precision, recall and F1 of a pairing; both empty counts as perfect. */
export const prf = (pairs: number, nRef: number, nOther: number): { precision: number; recall: number; f1: number } => {
  if (nRef === 0 && nOther === 0) return { precision: 1, recall: 1, f1: 1 };
  const precision = nOther ? pairs / nOther : 0, recall = nRef ? pairs / nRef : 0;
  return { precision, recall, f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0 };
};
