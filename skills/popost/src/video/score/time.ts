/**
 * The time-structure dimensions: structure (boundaries and shot lengths), transitions, camera and motion. Each
 * returns a DimensionScore whose detail a person can read; n = 0 leaves the dimension out of the composite.
 */
import type { Boundary, DimensionScore, Measure } from '../types';
import { easeCredit, kindCredit, SCALES } from './weights';
import { allEvents, boundaryOffset, fpsOf, intervalIoU, pairBoundaries, pairEvents, pairShots, prf } from './pair';
import { pairCutsByShare } from './shots';
import type { Pair } from './pair';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Boundaries paired within the tolerance (seconds): F1, how close the paired ones are, and shot lengths. */
export const structure = (ref: Measure, other: Measure, tol: number): DimensionScore => {
  // A whole video a few frames late is one offset, not every boundary missed: pair after it, and say it.
  const offset = boundaryOffset(ref, other, tol);
  const pairs = pairBoundaries(ref, other, tol, offset);
  const { precision, recall, f1 } = prf(pairs.length, ref.boundaries.length, other.boundaries.length);
  const timing = pairs.length ? mean(pairs.map((p) => 1 - p.d / (tol + 1e-9))) : f1;
  const fr = fpsOf(ref), fo = fpsOf(other);
  const shots = pairShots(ref, other);
  const lengths = ref.shots.map((s, r) => {
    const p = shots.find((x) => x.r === r);
    if (!p) return 0;
    const lr = (s.end - s.start) / fr, o = other.shots[p.o];
    const lo = o ? (o.end - o.start) / fo : 0;
    return Math.min(lr, lo) / Math.max(lr, lo, 1e-9);
  });
  const shotLength = mean(lengths);
  return {
    score: r3(0.6 * f1 + 0.2 * timing + 0.2 * shotLength),
    n: Math.max(1, ref.boundaries.length + other.boundaries.length - pairs.length),
    detail: { precision: r3(precision), recall: r3(recall), f1: r3(f1), paired: pairs.length, reference: ref.boundaries.length, other: other.boundaries.length, timing: r3(timing), shotLength: r3(shotLength), ...(offset ? { offset } : {}) },
  };
};

/** The mixed span in seconds: from half a frame after the last old frame to half a frame after the first new one. */
const spanSeconds = (b: Boundary, fps: number): [number, number] => [(b.start + 0.5) / fps, (b.end + 0.5) / fps];

const params = (a: Boundary, b: Boundary): number | undefined => {
  const checks: number[] = [];
  if (a.direction || b.direction) checks.push(a.direction === b.direction ? 1 : 0);
  if (a.mode || b.mode) checks.push(a.mode === b.mode ? 1 : 0);
  if (a.via || b.via) checks.push(a.via === b.via ? 1 : 0);
  return checks.length ? mean(checks) : undefined;
};

/**
 * Between two paired boundaries (or an end of the video), as many unpaired ones in each video: they pair in order. A
 * short shot leaves too little room to pair its edges by share of the length (9 frames: 0.3% of a 42 s video).
 */
const fillGaps = (ref: Measure, other: Measure, pairs: Pair[]): Pair[] => {
  const anchors: Pair[] = [{ r: -1, o: -1, d: 0 }, ...pairs, { r: ref.boundaries.length, o: other.boundaries.length, d: 0 }];
  const filled = anchors.slice(1).flatMap((b, i) => {
    const a = anchors[i] as Pair, n = b.r - a.r - 1;
    return n > 0 && n === b.o - a.o - 1 ? Array.from({ length: n }, (_, j): Pair => ({ r: a.r + 1 + j, o: a.o + 1 + j, d: 0 })) : [];
  });
  return [...pairs, ...filled].sort((x, y) => x.r - y.r);
};

/**
 * For paired boundaries: the kind (with half credit for look-alikes), the overlap of the spans, the parameters.
 * Boundaries pair by time after structure's offset, as structure pairs them. When that pairs fewer than half of the
 * reference's, they pair in order by share of the length (compareShots' pairing, then fillGaps), and each span is
 * compared with the other's moved onto it: a render re-timed to its voice still shows the reference's transitions in
 * their places, and pairing by time alone scored it 0 with nothing paired. Structure keeps judging the timing.
 */
export const transitions = (ref: Measure, other: Measure, tol: number): DimensionScore => {
  const offset = boundaryOffset(ref, other, tol);
  const byTime = pairBoundaries(ref, other, tol, offset);
  const byShare = 2 * byTime.length < ref.boundaries.length ? fillGaps(ref, other, pairCutsByShare(ref, other)) : [];
  const shared = byShare.length > byTime.length;
  const pairs = shared ? byShare : byTime;
  const fr = fpsOf(ref), fo = fpsOf(other);
  const per = pairs.map((p) => {
    const a = ref.boundaries[p.r] as Boundary, b = other.boundaries[p.o] as Boundary;
    const shift = shared ? a.frame / fr - b.frame / fo : -offset;
    const [b0, b1] = spanSeconds(b, fo);
    // two cuts have one-frame spans: their timing is structure's business, here they overlap fully
    const overlap = a.kind === 'cut' && b.kind === 'cut' ? 1 : intervalIoU(spanSeconds(a, fr), [b0 + shift, b1 + shift]);
    const kind = kindCredit(a.kind, b.kind), pr = params(a, b);
    return { kind, overlap, pr, score: pr === undefined ? 0.6 * kind + 0.4 * overlap : 0.5 * kind + 0.3 * overlap + 0.2 * pr };
  });
  const prs = per.map((x) => x.pr).filter((x): x is number => x !== undefined);
  return {
    score: r3(mean(per.map((x) => x.score))), n: pairs.length,
    detail: {
      kind: r3(mean(per.map((x) => x.kind))), spanOverlap: r3(mean(per.map((x) => x.overlap))), params: prs.length ? r3(mean(prs)) : '-', exactKind: per.filter((x) => x.kind === 1).length,
      ...(shared ? { pairedBy: 'share of the length' } : {}),
    },
  };
};

/** Zoom and pan per paired shot, where both cameras could be read. */
export const camera = (ref: Measure, other: Measure): DimensionScore => {
  const per = pairShots(ref, other).flatMap((p: Pair) => {
    const a = ref.shots[p.r]?.camera, b = other.shots[p.o]?.camera;
    if (!a || !b || a.kind === 'unknown' || b.kind === 'unknown') return [];
    const err = Math.hypot(a.zoomPerS - b.zoomPerS, a.panPerS[0] - b.panPerS[0], a.panPerS[1] - b.panPerS[1]);
    const kind = a.kind === b.kind ? 1 : (a.kind === 'static') !== (b.kind === 'static') ? 0 : 0.5;
    return [{ err, kind, score: 0.3 * kind + 0.7 * Math.exp(-err / SCALES.camera) }];
  });
  return { score: r3(mean(per.map((x) => x.score))), n: per.length, detail: { meanError: r3(mean(per.map((x) => x.err))), sameKind: r3(mean(per.map((x) => x.kind))) } };
};

/**
 * Motion events paired by time and box: precision and recall, then per pair the start time (half the pair's score;
 * one frame of the reference is free) and the rest: kind, how, direction, ease and length.
 */
export const motion = (ref: Measure, other: Measure): DimensionScore => {
  const re = allEvents(ref), oe = allEvents(other);
  const pairs = pairEvents(re, oe);
  const { precision, recall, f1 } = prf(pairs.length, re.length, oe.length);
  const frame = 1 / fpsOf(ref);
  const per = pairs.map((p) => {
    const a = re[p.r] as (typeof re)[number], b = oe[p.o] as (typeof oe)[number];
    const parts = [
      a.e.kind === b.e.kind ? 1 : 0,
      a.e.how === b.e.how ? 1 : 0,
      easeCredit(a.e.ease, b.e.ease),
      Math.min(a.t1 - a.t0, b.t1 - b.t0) / Math.max(a.t1 - a.t0, b.t1 - b.t0, 1e-9),
      ...(a.e.direction || b.e.direction ? [a.e.direction === b.e.direction ? 1 : 0] : []),
    ];
    const timing = Math.exp(-Math.max(0, Math.abs(a.t0 - b.t0) - frame) / SCALES.motionTime);
    return 0.5 * timing + 0.5 * mean(parts);
  });
  const quality = per.length ? mean(per) : 0;
  return {
    score: r3(f1 * quality), n: re.length + oe.length - pairs.length,
    detail: { precision: r3(precision), recall: r3(recall), f1: r3(f1), pairQuality: r3(quality), reference: re.length, other: oe.length },
  };
};
