/**
 * Trajectories: where something was on screen over time, sampled, in fractions of the canvas. Two things are followed,
 * both on the every-frame thumbnails and both against a picture that holds still:
 *
 * - The region of the new picture during a transition (reveal.ts), when the pictures on both sides hold still and each
 *   pixel shows one of them: followed as the object at the region's front when a shape leads it, else as the middle of
 *   the region's edge, with the edge's shape. The window runs from where the picture before stops holding still (back to
 *   the cut before it, a second at most) to where the picture after holds still: an effect is often longer than the
 *   span the boundary was measured on. A transition that moves or mixes its pictures (a push, a dissolve) gives none.
 * - An element that travels while it appears or disappears (a motion event): the pixels of the event's box that differ
 *   from the picture without the element. An element that fades or grows in place gives none.
 *
 * Deterministic and cheap: sums over thumbnails, no search.
 */
import type { Boundary, Ease, MotionEvent, RevealEdge, ShotMeasure, Trajectory, TrajectoryPath, TrajectorySample } from '../types';
import type { Thumbs } from './pixels';
import { clamp, median, round } from './pixels';
import { changedShare, keepRegion, NEW, readRegion, revealMask, type EdgeShape, type FrameReading } from './reveal';

/** A picture holds still when less than this share of it changes between frames 1/15 s apart. */
const STILL = 0.002;
/** The window of a transition reaches at most this many seconds past its measured span on either side. */
const REACH_S = 1;
/** The new picture shows from this cover on, and is all there is at 1 - SHOWS. */
const SHOWS = 0.01;
/** A transition is read as a region when at most this share of its pixels is neither picture (the median over its frames). */
const MOST_FOREIGN = 0.25;
/** ... and the pixels that are one of the two pictures stand at most this far from it (reveal.ts, mixed): a dissolve stands near 0.5. */
const MOST_MIXED = 0.2;
/** A region grows: its cover ends at REACHES or more and falls back by at most FALLS in sum on the way. */
const REACHES = 0.9;
const FALLS = 0.1;
/** An object keeps its size: the upper quartile of its area at most this many times the lower. */
const STEADY = 3;
/** The two pictures must differ on this share of the frame for a region to be read. */
const LEAST_KNOWN = 0.15;
/** The shape of the edge is read on frames whose cover lies between EDGE_FROM and 1 - EDGE_FROM. */
const EDGE_FROM = 0.08;
export const MOST_SAMPLES = 24;
/** An element travels when its centre goes this far (canvas widths) while its size holds within SAME_SIZE. */
const TRAVELS = 0.03;
const SAME_SIZE = 0.6;

const two = (n: number): string => String(n).padStart(2, '0');

/** n of the items, evenly spread, the first and the last kept. */
const thin = <T>(xs: readonly T[], n: number): T[] =>
  xs.length <= n ? [...xs] : [...new Set(Array.from({ length: n }, (_v, i) => Math.round((i * (xs.length - 1)) / (n - 1))))].map((i) => xs[i] as T);

const easeOf = (samples: readonly TrajectorySample[], w: number, h: number): Ease => {
  const a = samples[0] as TrajectorySample, b = samples[samples.length - 1] as TrajectorySample;
  const dx = (b.centre[0] - a.centre[0]) * w, dy = (b.centre[1] - a.centre[1]) * h, len2 = dx * dx + dy * dy;
  if (len2 < 1e-9 || b.frame === a.frame) return 'linear';
  // Progress along the straight way at the sample nearest the middle of the time.
  const mid = [...samples].sort((x, y) => Math.abs(x.frame - (a.frame + b.frame) / 2) - Math.abs(y.frame - (a.frame + b.frame) / 2))[0] as TrajectorySample;
  const t = (mid.frame - a.frame) / (b.frame - a.frame);
  const p = (((mid.centre[0] - a.centre[0]) * w) * dx + ((mid.centre[1] - a.centre[1]) * h) * dy) / len2;
  if (Math.abs(t - 0.5) > 0.2) return 'linear';
  return p - t > 0.1 ? 'out' : p - t < -0.1 ? 'in' : 'linear';
};

export const pathOf = (samples: readonly TrajectorySample[], w: number, h: number, fps: number): TrajectoryPath => {
  const a = samples[0] as TrajectorySample, b = samples[samples.length - 1] as TrajectorySample;
  const px = (s: TrajectorySample, t: TrajectorySample): number => Math.hypot((t.centre[0] - s.centre[0]) * w, (t.centre[1] - s.centre[1]) * h);
  const chord = px(a, b);
  let gone = 0;
  for (let i = 1; i < samples.length; i++) gone += px(samples[i - 1] as TrajectorySample, samples[i] as TrajectorySample);
  const seconds = Math.max(1, b.frame - a.frame) / fps;
  return {
    from: a.centre, to: b.centre,
    angle: chord < 0.5 ? 0 : round((Math.atan2((b.centre[1] - a.centre[1]) * h, (b.centre[0] - a.centre[0]) * w) * 180) / Math.PI, 1),
    length: round(chord / w, 3), speed: round(chord / w / seconds, 3), straightness: gone > 0 ? round(clamp(chord / gone, 0, 1), 2) : 1, ease: easeOf(samples, w, h),
  };
};

const medianSize = (samples: readonly TrajectorySample[]): [number, number] => [round(median(samples.map((s) => s.size[0])), 3), round(median(samples.map((s) => s.size[1])), 3)];

/** The mean direction of angles in degrees. */
const meanAngle = (xs: readonly number[]): number =>
  (Math.atan2(xs.reduce((s, a) => s + Math.sin((a * Math.PI) / 180), 0), xs.reduce((s, a) => s + Math.cos((a * Math.PI) / 180), 0)) * 180) / Math.PI;

/** The window of a transition: back while the picture before still changes, on while the picture after still does. */
const windowOf = (t: Thumbs, bs: readonly Boundary[], k: number, shots: readonly ShotMeasure[]): [number, number] => {
  const b = bs[k] as Boundary, n = t.rgb.length, step = Math.max(1, Math.round(t.fps / 15)), reach = Math.round(REACH_S * t.fps);
  const before = k > 0 ? (bs[k - 1] as Boundary) : undefined, after = bs[k + 1];
  const floor = Math.max(before ? (before.kind === 'cut' ? before.frame : before.end) : 0, b.start - reach);
  // A camera move of the shot after is not the transition: the window ends before the first one.
  const move = shots[k + 1]?.camera.moves?.[0]?.start;
  const ceiling = Math.min(n - 1, after ? after.start : n - 1, b.end + reach, move !== undefined && move > b.end ? move - 1 : n - 1);
  const moves = (f: number, g: number): boolean => { const c = changedShare(t.rgb[f] as Uint8Array, t.rgb[g] as Uint8Array); return c >= STILL && c < 0.5; };
  let lo = Math.max(floor, Math.min(b.start, n - 1)), hi = Math.min(ceiling, Math.max(b.end, 0));
  while (lo > floor && moves(Math.max(floor, lo - step), lo)) lo--;
  while (hi < ceiling && moves(hi, Math.min(ceiling, hi + step))) hi++;
  return [lo, hi];
};

interface Read { frame: number; cover: number; foreign: number; region?: FrameReading }

const edgeOf = (reads: readonly Read[], w: number, h: number): RevealEdge | undefined => {
  const mid = reads.filter((r) => r.region && r.cover >= EDGE_FROM && r.cover <= 1 - EDGE_FROM).map((r) => (r.region as FrameReading).shape);
  if (!mid.length) return undefined;
  const count = (s: EdgeShape): number => mid.filter((m) => m.shape === s).length;
  const shape = (['straight', 'circle', 'wedge', 'irregular'] as const).reduce((best, s) => (count(s) > count(best) ? s : best));
  const mine = mid.filter((m) => m.shape === shape);
  const angles = mine.flatMap((m) => (m.angle === undefined ? [] : [m.angle]));
  const centres = mine.flatMap((m) => (m.centre ? [m.centre] : []));
  return {
    shape, fit: round(median(mine.map((m) => m.fit)), 2), share: round(mine.length / mid.length, 2),
    ...(angles.length ? { angle: round(meanAngle(angles), 1) } : {}),
    ...(shape === 'wedge' ? { spread: round(median(mine.map((m) => m.spread ?? 0)), 0) } : {}),
    ...(centres.length ? { centre: [round(median(centres.map((c) => c[0])) / w, 3), round(median(centres.map((c) => c[1])) / h, 3)] as [number, number], grows: mine.filter((m) => m.grows).length * 2 >= mine.length } : {}),
  };
};

const transitionTrack = (t: Thumbs, bs: readonly Boundary[], k: number, shots: readonly ShotMeasure[]): Trajectory | undefined => {
  const w = t.width, h = t.height;
  const [lo, hi] = windowOf(t, bs, k, shots);
  if (hi - lo < 2) return undefined;
  const a = t.rgb[lo] as Uint8Array, b = t.rgb[hi] as Uint8Array;
  const masks = Array.from({ length: hi - lo + 1 }, (_v, i) => ({ frame: lo + i, ...revealMask(t.rgb[lo + i] as Uint8Array, a, b) }));
  const known = masks.filter((m) => m.total >= LEAST_KNOWN * w * h);
  const done = known.find((m) => m.fresh / m.total >= 1 - SHOWS) ?? known[known.length - 1];
  if (!done) return undefined;
  // From the last frame back: the region of each frame is the part of the new pixels that continues the later region.
  const live: typeof masks = [];
  let later: Uint8Array | undefined;
  for (const m of known.filter((x) => x.frame <= done.frame).reverse()) {
    m.fresh = keepRegion(m.mask, w, h, later);
    if (m.fresh / m.total <= SHOWS) break;
    later = m.mask;
    live.unshift(m);
  }
  const first = live[0];
  const covers = live.map((m) => m.fresh / m.total);
  const fallen = covers.reduce((s, c, i) => s + (i > 0 ? Math.max(0, (covers[i - 1] as number) - c) : 0), 0);
  if ((covers[covers.length - 1] ?? 0) < REACHES || fallen > FALLS) return undefined;
  const middle = live.filter((m) => m.fresh / m.total >= 0.2 && m.fresh / m.total <= 0.8);
  if (!first || live.length < 3 || median(live.map((m) => m.foreign / m.total)) > MOST_FOREIGN || median((middle.length ? middle : live).map((m) => m.mixed)) > MOST_MIXED) return undefined;
  // Where the region began: the middle of the new picture's pixels on its first frame.
  let ox = 0, oy = 0, on = 0;
  first.mask.forEach((v, p) => { if (v === NEW) { ox += p % w; oy += Math.floor(p / w); on++; } });
  const origin: [number, number] = [ox / Math.max(1, on), oy / Math.max(1, on)];
  const reads: Read[] = live.map((m) => { const region = readRegion(m.mask, w, h, origin); return { frame: m.frame, cover: m.fresh / m.total, foreign: m.foreign / m.total, ...(region ? { region } : {}) }; });
  const edge = edgeOf(reads, w, h);
  if (!edge) return undefined;
  // The object at the front: while the front is inside the frame and the region has a head.
  const inside = (r: Read): boolean => { const f = r.region?.front; return f !== undefined && f[0] > 1 && f[1] > 1 && f[0] < w - 2 && f[1] < h - 2; };
  const led = reads.filter((r) => r.region?.head && inside(r));
  const areas = led.map((r) => { const box = (r.region as FrameReading).head?.box ?? [0, 0, 0, 0]; return box[2] * box[3]; }).sort((x, y) => x - y);
  const steady = areas.length > 0 && (areas[Math.floor(0.75 * (areas.length - 1))] as number) <= STEADY * Math.max(1, areas[Math.floor(0.25 * (areas.length - 1))] as number);
  const object = led.length >= 4 && led.length >= 0.5 * reads.filter(inside).length && steady;
  const sample = (r: Read): TrajectorySample => {
    const g = r.region as FrameReading, box = object ? (g.head?.box ?? g.box) : g.box;
    const centre: [number, number] = object ? [(box[0] + box[2] / 2) / w, (box[1] + box[3] / 2) / h] : [(g.edge[0] + 0.5) / w, (g.edge[1] + 0.5) / h];
    return { frame: r.frame, centre: [round(centre[0], 3), round(centre[1], 3)], size: [round(box[2] / w, 3), round(box[3] / h, 3)], cover: round(r.cover, 3) };
  };
  const used = object ? led : reads.filter((r) => r.region);
  if (used.length < 2) return undefined;
  const samples = thin(used.map(sample), MOST_SAMPLES);
  const calm = 1 - median(live.map((m) => m.foreign / m.total));
  return {
    id: 'transition-' + two(k + 2), of: 'transition', shot: k + 2, what: object ? 'object' : 'region', method: object ? 'reveal-front' : 'reveal-region',
    start: (samples[0] as TrajectorySample).frame, end: (samples[samples.length - 1] as TrajectorySample).frame,
    samples, path: pathOf(samples, w, h, t.fps), size: medianSize(samples),
    reveal: { start: first.frame, end: done.frame, edge },
    confidence: round(clamp(calm * (edge.shape === 'irregular' ? 0.6 : edge.fit) * (0.5 + 0.5 * edge.share), 0, 1), 2),
  };
};

/** The pixels of the event's box (a little more) that differ from the picture without the element, on frame f. */
const elementBox = (t: Thumbs, f: number, without: Uint8Array, e: MotionEvent): [number, number, number, number] | undefined => {
  const w = t.width, h = t.height, pad = 0.03;
  const x0 = clamp(Math.floor((e.box[0] - pad) * w), 0, w - 1), x1 = clamp(Math.ceil((e.box[0] + e.box[2] + pad) * w), x0 + 1, w);
  const y0 = clamp(Math.floor((e.box[1] - pad) * h), 0, h - 1), y1 = clamp(Math.ceil((e.box[1] + e.box[3] + pad) * h), y0 + 1, h);
  const frame = t.rgb[f] as Uint8Array;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 3;
    if (Math.abs((frame[i] as number) - (without[i] as number)) + Math.abs((frame[i + 1] as number) - (without[i + 1] as number)) + Math.abs((frame[i + 2] as number) - (without[i + 2] as number)) <= 90) continue;
    n++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
  }
  return n >= 4 ? [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1] : undefined;
};

const eventTrack = (t: Thumbs, s: ShotMeasure, e: MotionEvent, k: number): Trajectory | undefined => {
  if (e.kind === 'change' || e.end - e.start < 3) return undefined;
  const w = t.width, h = t.height, n = t.rgb.length;
  const without = t.rgb[e.kind === 'appear' ? Math.max(0, e.start - 1) : Math.min(n - 1, e.end)] as Uint8Array;
  const all: TrajectorySample[] = [];
  for (let f = Math.max(0, e.start); f <= Math.min(n - 1, e.end); f++) {
    const box = elementBox(t, f, without, e);
    if (box) all.push({ frame: f, centre: [round((box[0] + box[2] / 2) / w, 3), round((box[1] + box[3] / 2) / h, 3)], size: [round(box[2] / w, 3), round(box[3] / h, 3)] });
  }
  if (all.length < 3) return undefined;
  // An element that comes in over the frame's border is cut by it there: its size is judged on the samples clear of the border.
  const clear = all.filter((x) => x.centre[0] - x.size[0] / 2 > 0.5 / w && x.centre[1] - x.size[1] / 2 > 0.5 / h && x.centre[0] + x.size[0] / 2 < 1 - 0.5 / w && x.centre[1] + x.size[1] / 2 < 1 - 0.5 / h);
  const areas = clear.map((x) => x.size[0] * x.size[1]);
  const path = pathOf(all, w, h, t.fps);
  if (areas.length < 2 || path.length < TRAVELS || Math.min(...areas) < SAME_SIZE * Math.max(...areas)) return undefined;
  const samples = thin(all, MOST_SAMPLES);
  return {
    id: 'shot-' + two(s.index + 1) + '-event-' + (k + 1), of: 'event', shot: s.index + 1, event: k, what: 'element', method: 'changed-region',
    start: (samples[0] as TrajectorySample).frame, end: (samples[samples.length - 1] as TrajectorySample).frame,
    samples, path, size: medianSize(samples), confidence: e.confidence,
  };
};

/** Every trajectory of a video: the transitions that are not cuts, then the events, in order of time. */
export const measureTracks = (t: Thumbs, boundaries: readonly Boundary[], shots: readonly ShotMeasure[]): Trajectory[] => [
  ...boundaries.flatMap((b, k) => { const tr = b.kind === 'cut' ? undefined : transitionTrack(t, boundaries, k, shots); return tr ? [tr] : []; }),
  ...shots.flatMap((s) => s.events.flatMap((e, k) => { const tr = eventTrack(t, s, e, k); return tr ? [tr] : []; })),
];
