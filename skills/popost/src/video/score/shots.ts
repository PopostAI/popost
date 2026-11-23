/**
 * compareShots: where two videos differ most, shot by shot, so that whoever looks knows where to look. For each shot
 * of the reference, the matching part of the other video is found and compared on what can be told per shot:
 * picture (the signature thumbnails at matching moments), colour (ground and palette), motion (how much of the picture
 * changes, the camera, the motion events) and, when both were read, text (how many lines, where, how large; never
 * the words, which a re-creation changes). worst names the shots that differ most, each with the dimension that makes
 * it so and its seconds in both videos. An addition to scoreMeasures: nothing here changes its scores.
 *
 * The matching part: the reference's cuts are paired with the other's by their share of the length, one to one and in
 * order, and the time between paired cuts is mapped in proportion. Videos whose lengths differ by a few percent pair
 * their cuts all the same; a cut one of them misses is passed over, and the shots on either side of it are found by
 * share of the length.
 */
import type { Measure, MotionEvent } from '../types';
import type { TextCue, TextTrack } from '../text/types';
import { deltaE, hexToRgb, toLab } from '../measure/colour';
import { signatureFrames } from '../measure/signature';
import { boxIoU, fpsOf, matchGreedy, type Pair } from './pair';
import { paletteDistance, thumbSimilarity } from './picture';
import { easeCredit, SCALES } from './weights';
import { PROJECT_SEARCH_S, SEARCH_SHARE_OF_SHOT, transitionOf, type Window } from './shot-transition';

export const SHOT_DIMENSIONS = ['picture', 'colour', 'motion', 'text', 'transition'] as const;
export type ShotDimension = (typeof SHOT_DIMENSIONS)[number];

export { momentsOf } from './shot-transition';
export interface ShotSpan { from: number; to: number }

export interface ShotDifference {
  /** The reference's shot, from 1. */
  shot: number;
  /** Seconds in the reference, and of the matching part of the other video. */
  reference: ShotSpan;
  other: ShotSpan;
  /** cuts: both edges of the shot are cuts paired with the other's; share: at least one edge was placed by share of the length. */
  paired: 'cuts' | 'share';
  /** 0..1, 1 the same; a dimension that cannot be told for this shot is left out. */
  scores: Partial<Record<ShotDimension, number>>;
  /** The mean of its scores, and the lowest of them. */
  score: number;
  by: ShotDimension;
  /** The moment to look at, in seconds of both videos: the least alike pair of pictures, or the middle of the shot. */
  at: { reference: number; other: number };
  /** by transition only: the change into the shot, in seconds of both videos (a look command shows it frame by frame). */
  change?: { reference: ShotSpan; other: ShotSpan };
}

export interface ShotComparison { shots: ShotDifference[]; worst: ShotDifference[] }

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const durationOf = (m: Measure): number => (m.source.frames > 0 ? m.source.frames / fpsOf(m) : m.source.duration);

/** Cuts that share of the length apart at most pair: a twentieth, and less than half of the shorter shot beside the cut. */
const MAX_SHARE = 0.05;

/** The longest run of pairs whose other indexes rise with the reference's: cuts are paired in order. */
const inOrder = (pairs: Pair[]): Pair[] => {
  const p = [...pairs].sort((a, b) => a.r - b.r);
  const best = p.map(() => 1), prev = p.map(() => -1);
  p.forEach((x, i) => { for (let j = 0; j < i; j++) if ((p[j] as Pair).o < x.o && (best[j] as number) + 1 > (best[i] as number)) { best[i] = (best[j] as number) + 1; prev[i] = j; } });
  let i = best.indexOf(Math.max(0, ...best));
  const out: Pair[] = [];
  while (i >= 0) { out.unshift(p[i] as Pair); i = prev[i] as number; }
  return out;
};

/** The reference's cuts paired with the other's by share of the length; r and o index the boundaries. */
export const pairCutsByShare = (ref: Measure, other: Measure): Pair[] => {
  const da = durationOf(ref), db = durationOf(other), fa = fpsOf(ref), fb = fpsOf(other);
  const starts = [0, ...ref.boundaries.map((b) => b.frame / fa), da];
  const cands: Pair[] = [];
  ref.boundaries.forEach((a, r) => {
    const room = Math.min((starts[r + 1] as number) - (starts[r] as number), (starts[r + 2] as number) - (starts[r + 1] as number)) / da;
    const tol = Math.min(MAX_SHARE, 0.45 * room);
    other.boundaries.forEach((b, o) => {
      const d = Math.abs(a.frame / fa / da - b.frame / fb / db);
      if (d <= tol) cands.push({ r, o, d });
    });
  });
  return inOrder(matchGreedy(cands));
};

/** Seconds of the reference to seconds of the other: piecewise linear through the paired cuts and the two ends. */
const timeMap = (ref: Measure, other: Measure, pairs: Pair[]): ((t: number) => number) => {
  const fa = fpsOf(ref), fb = fpsOf(other);
  const anchors: [number, number][] = [[0, 0], ...pairs.map((p): [number, number] => [(ref.boundaries[p.r]?.frame ?? 0) / fa, (other.boundaries[p.o]?.frame ?? 0) / fb]), [durationOf(ref), durationOf(other)]];
  return (t) => {
    const k = Math.max(0, anchors.findIndex(([a], i) => i > 0 && t <= a) - 1);
    const [a0, b0] = anchors[k] as [number, number], [a1, b1] = (anchors[k + 1] ?? anchors[k]) as [number, number];
    return a1 > a0 ? b0 + ((t - a0) * (b1 - b0)) / (a1 - a0) : b0;
  };
};

const labOf = (hex: string): [number, number, number] => toLab(hexToRgb(hex));

/** The other's shot that covers most of a span. */
const coveringShot = (other: Measure, span: ShotSpan): Measure['shots'][number] | undefined => {
  const fb = fpsOf(other);
  const overlap = (s: Measure['shots'][number]): number => Math.max(0, Math.min(span.to, s.end / fb) - Math.max(span.from, s.start / fb));
  return [...other.shots].sort((a, b) => overlap(b) - overlap(a))[0];
};

/** The signature pictures inside the shot (away from its two ends), each against the other's at the mapped moment. */
const pictureOf = (ref: Measure, other: Measure, span: ShotSpan, map: (t: number) => number): { score: number; at?: { reference: number; other: number } } | undefined => {
  const fa = ref.signature.every / fpsOf(ref), fb = other.signature.every / fpsOf(other);
  const w = ref.signature.width, h = ref.signature.height;
  if (!ref.signature.count || !other.signature.count || w !== other.signature.width || h !== other.signature.height) return undefined;
  const a = signatureFrames(ref.signature), b = signatureFrames(other.signature);
  const edge = Math.min(0.15 * (span.to - span.from), 0.2);
  let times = a.map((_x, k) => k * fa).filter((t) => t >= span.from + edge && t < span.to - edge);
  if (!times.length) times = [Math.min((a.length - 1) * fa, Math.round((span.from + span.to) / 2 / fa) * fa)];
  const per = times.flatMap((t) => {
    const u = map(t);
    const x = a[Math.round(t / fa)], y = b[Math.min(b.length - 1, Math.max(0, Math.round(u / fb)))];
    if (!x || !y) return [];
    const s = thumbSimilarity(x, y, w, h);
    return [{ t, u, score: 0.5 * s.px + 0.5 * s.grad }];
  });
  if (!per.length) return undefined;
  const least = [...per].sort((p, q) => p.score - q.score)[0];
  return { score: mean(per.map((p) => p.score)), ...(least ? { at: { reference: least.t, other: least.u } } : {}) };
};

const colourOf = (a: Measure['shots'][number] | undefined, b: Measure['shots'][number] | undefined): number | undefined => {
  if (!a || !b || !a.background || !b.background) return undefined;
  const bg = deltaE(labOf(a.background), labOf(b.background)), pal = paletteDistance(a.palette, b.palette);
  return 0.4 * Math.exp(-bg / SCALES.colour) + 0.6 * Math.exp(-pal / SCALES.colour);
};

/** The mean share of the picture that changes between samples inside a span (the rhythm curve). */
const changeIn = (m: Measure, span: ShotSpan): number | undefined => {
  const dt = m.rhythm.step / fpsOf(m);
  const xs = m.rhythm.change.filter((_c, k) => (k + 0.5) * dt >= span.from && (k + 0.5) * dt < span.to);
  return xs.length ? mean(xs) : undefined;
};

interface Timed { e: MotionEvent; t: number; len: number }
const eventsIn = (m: Measure, span: ShotSpan): Timed[] => {
  const fps = fpsOf(m);
  return m.shots.flatMap((s) => s.events).filter((e) => e.start / fps >= span.from && e.start / fps < span.to).map((e) => ({ e, t: e.start / fps, len: (e.end - e.start) / fps }));
};

/** Events paired as the motion dimension pairs them (starts within 0.5 s, boxes overlapping), the reference's times mapped. */
const eventsScore = (a: Timed[], b: Timed[], map: (t: number) => number): number | undefined => {
  if (!a.length && !b.length) return undefined;
  const cands: Pair[] = [];
  a.forEach((x, r) => b.forEach((y, o) => {
    const dt = Math.abs(map(x.t) - y.t), iou = boxIoU(x.e.box, y.e.box);
    if (dt <= 0.5 && iou >= 0.2) cands.push({ r, o, d: dt / 0.5 + (1 - iou) });
  }));
  const pairs = matchGreedy(cands);
  if (!pairs.length) return 0;
  const f1 = (2 * pairs.length) / (a.length + b.length);
  const quality = mean(pairs.map((p) => {
    const x = a[p.r] as Timed, y = b[p.o] as Timed;
    const parts = [x.e.kind === y.e.kind ? 1 : 0, x.e.how === y.e.how ? 1 : 0, easeCredit(x.e.ease, y.e.ease), Math.min(x.len, y.len) / Math.max(x.len, y.len, 1e-9)];
    return 0.5 * Math.exp(-Math.abs(map(x.t) - y.t) / SCALES.motionTime) + 0.5 * mean(parts);
  }));
  return f1 * quality;
};

const motionOf = (ref: Measure, other: Measure, shot: Measure['shots'][number], span: ShotSpan, theirs: ShotSpan, map: (t: number) => number): number | undefined => {
  const ca = changeIn(ref, span), cb = changeIn(other, theirs);
  // How much of the picture keeps changing: a page that scrolls against a still card. A hundredth is "nothing moves".
  const change = ca === undefined || cb === undefined ? undefined : (Math.min(ca, cb) + 0.01) / (Math.max(ca, cb) + 0.01);
  const a = shot.camera;
  const b = coveringShot(other, theirs)?.camera;
  const camera = !a || !b || a.kind === 'unknown' || b.kind === 'unknown' ? undefined
    : 0.3 * (a.kind === b.kind ? 1 : (a.kind === 'static') !== (b.kind === 'static') ? 0 : 0.5) + 0.7 * Math.exp(-Math.hypot(a.zoomPerS - b.zoomPerS, a.panPerS[0] - b.panPerS[0], a.panPerS[1] - b.panPerS[1]) / SCALES.camera);
  const parts = [change, camera, eventsScore(eventsIn(ref, span), eventsIn(other, theirs), map)].filter((x): x is number => x !== undefined);
  return parts.length ? mean(parts) : undefined;
};

/** Lines on screen during a span, the watermark left out: where they sit and how large they are. */
const linesIn = (t: TextTrack, span: ShotSpan, fps: number): TextCue[] =>
  t.cues.filter((c) => c.role !== 'watermark' && c.start / fps < span.to && c.end / fps > span.from);

/** How many lines, where and how large, against the other's; undefined when neither shows any. */
const textOf = (a: TextCue[], b: TextCue[]): number | undefined => {
  if (!a.length && !b.length) return undefined;
  if (!a.length || !b.length) return 0;
  const count = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const centre = (c: TextCue): [number, number] => [c.box[0] + c.box[2] / 2, c.box[1] + c.box[3] / 2];
  const cands: Pair[] = [];
  a.forEach((x, r) => b.forEach((y, o) => {
    const [ax, ay] = centre(x), [bx, by] = centre(y);
    const d = Math.hypot(ax - bx, ay - by);
    if (d <= 0.15) cands.push({ r, o, d });
  }));
  const pairs = matchGreedy(cands);
  const placed = pairs.length ? ((2 * pairs.length) / (a.length + b.length)) * mean(pairs.map((p) => {
    const x = a[p.r] as TextCue, y = b[p.o] as TextCue;
    return (Math.min(x.size, y.size) / Math.max(x.size, y.size, 1e-9)) * (1 - p.d / 0.15 / 2);
  })) : 0;
  return 0.4 * count + 0.6 * placed;
};

export interface CompareShotsOptions {
  /** The text read from each video (popost video text, or describe's text.json); text is compared only with both. */
  text?: { reference: TextTrack; other: TextTrack };
  /** How many shots worst names: default a third of the shots, at least 3 and at most 5. */
  worst?: number;
  /** Where a render's project has the change into each reference shot (from 0), in seconds of the other video (score/project-windows.ts). */
  windows?: (Window | undefined)[];
}

export const compareShots = (ref: Measure, other: Measure, o: CompareShotsOptions = {}): ShotComparison => {
  const fa = fpsOf(ref), fb = fpsOf(other);
  const pairs = pairCutsByShare(ref, other);
  const map = timeMap(ref, other, pairs);
  const anchored = new Set(pairs.map((p) => p.r));
  const shots = ref.shots.map((s, k): ShotDifference => {
    const span = { from: s.start / fa, to: s.end / fa };
    const theirs = { from: map(span.from), to: map(span.to) };
    const ends = (k === 0 || anchored.has(k - 1)) && (k === ref.shots.length - 1 || anchored.has(k));
    const picture = pictureOf(ref, other, span, map);
    const textA = o.text ? linesIn(o.text.reference, span, fa) : undefined, textB = o.text ? linesIn(o.text.other, theirs, fb) : undefined;
    const scores: Partial<Record<ShotDimension, number>> = Object.fromEntries(([
      ['picture', picture?.score], ['colour', colourOf(s, coveringShot(other, theirs))], ['motion', motionOf(ref, other, s, span, theirs, map)],
      ['text', textA && textB ? textOf(textA, textB) : undefined],
    ] as [ShotDimension, number | undefined][]).flatMap(([d, v]) => (v === undefined ? [] : [[d, r3(v)]])));
    const adjacent = Math.min(span.to - span.from, k > 0 ? (ref.shots[k - 1] as Measure['shots'][number]).end / fa - (ref.shots[k - 1] as Measure['shots'][number]).start / fa : Infinity);
    const tr = transitionOf(ref, other, k > 0 ? ref.boundaries[k - 1] : undefined, (r) => {
      const given = o.windows?.[k];
      return given ? { span: given, tolerance: PROJECT_SEARCH_S } : { span: { from: map(r.from), to: map(r.to) }, tolerance: SEARCH_SHARE_OF_SHOT * adjacent };
    });
    if (tr) scores.transition = r3(tr.score);
    const values = SHOT_DIMENSIONS.flatMap((d) => (scores[d] === undefined ? [] : [{ d, v: scores[d] as number }]));
    const lowest = [...values].sort((x, y) => x.v - y.v)[0];
    const middle = (span.from + span.to) / 2;
    const change = lowest?.d === 'transition' && tr ? { reference: tr.reference, other: tr.other } : undefined;
    const at = change ? { reference: (change.reference.from + change.reference.to) / 2, other: (change.other.from + change.other.to) / 2 }
      : lowest?.d === 'picture' && picture?.at ? picture.at : { reference: middle, other: map(middle) };
    return {
      shot: k + 1, reference: { from: r2(span.from), to: r2(span.to) }, other: { from: r2(theirs.from), to: r2(theirs.to) }, paired: ends ? 'cuts' : 'share',
      scores, score: r3(mean(values.map((x) => x.v))), by: lowest?.d ?? 'picture', at: { reference: r2(at.reference), other: r2(at.other) },
      ...(change ? { change: { reference: { from: r2(change.reference.from), to: r2(change.reference.to) }, other: { from: r2(change.other.from), to: r2(change.other.to) } } } : {}),
    };
  });
  const n = o.worst ?? Math.min(5, Math.max(3, Math.round(shots.length / 3)));
  const worst = [...shots].sort((a, b) => a.score - b.score || a.shot - b.shot).slice(0, Math.min(n, shots.length));
  return { shots, worst };
};
