/**
 * The transition dimension of a shot (score/shots.ts): how the reference's change into the shot compares with the
 * other video's change in the matching place. Left out when the reference changes by a cut.
 *
 * The other video's measured boundary is not required: a change drawn inside a scene, or a soft one, is not always
 * measured as a boundary. The change itself is compared, as the curve of how much of the picture changes between
 * sampled frames (measure.rhythm) over the reference's span and over the other's, resampled to the same length. A cut
 * where the reference has a 12-frame whip is a spike against a plateau. When the other has a measured change of its
 * own there, its kind joins (does the picture move, or only blend), and its direction and mode where both have one.
 *
 * Where the other's change stands: from the project it was rendered from when there is one (windows), else by the
 * time map of compareShots, searched within a tolerance that scales with the shots beside the change.
 */
import type { Boundary, Measure } from '../types';
import { fpsOf } from './pair';
import { kindCredit } from './weights';

/** Share of the shorter shot beside a change that the share-of-the-length mapping may be off: it drifts by a part of a shot, not by frames. */
export const SEARCH_SHARE_OF_SHOT = 0.25;
/** Seconds a project's own timeline may be off the render (a scene that starts its effect early or late): about a quarter of a second, the length of a short whip. */
export const PROJECT_SEARCH_S = 0.25;
/** Rhythm samples of context on each side of a change: the curve must come back to the shot's own level to show a spike or a plateau. */
export const CONTEXT_SAMPLES = 1;
/** The fewest points a window is resampled to: the curve is about ten samples a second, so a quarter-second change has 3. */
export const MIN_POINTS = 4;
/** A change in a hundredth of the picture is "nothing moves" (as the motion dimension reads it): the floor of the curve ratio. */
export const NOTHING_MOVES = 0.01;
/** The floor of a part in the geometric mean: a part at 0 would zero the score whatever the others show, and a change with nothing in common is already a low score at a twentieth. */
const MIN_PART = 0.05;
/** Weights of the three things compared: the curve's shape (always there), what the change is named (kind, direction), and how plain it is (residual). Shape counts most because it is read from every frame; the other two are labels and share the rest. */
export const WEIGHTS = { shape: 0.5, kind: 0.25, plain: 0.25 } as const;
/**
 * How far a preset of the engine is from its own model: none, it is drawn by it. A reference change whose label leaves
 * much unexplained (types.ts Boundary.residual) is a custom effect, and a plain preset does not draw it.
 */
export const PRESET_RESIDUAL = 0;
/** Kinds in which the picture moves (an edge, a camera, a shape travels); the others only blend or fade. */
const MOVES = new Set(['wipe', 'slide', 'whip', 'zoom', 'spin', 'shake', 'glitch']);
/** How many pictures of a change a look command shows: enough to see an edge travel, few enough to read at once. */
export const LOOK_MOMENTS = 6;

export interface Span { from: number; to: number }
/** What a change is named: a measured boundary's or a project's transition's kind and parameters. */
export type Declared = Pick<Boundary, 'kind' | 'direction' | 'mode' | 'via' | 'residual'>;
/** A change's place in seconds, and what the project that draws it calls it when it names one. */
export interface Window extends Span { declared?: Declared }
export interface TransitionResult {
  score: number;
  /** Seconds of the change in the reference and in the other video (where it was found). */
  reference: Span;
  other: Span;
}

/** The mixed span in seconds: half a frame after the last old frame to half a frame after the first new one. */
const spanOf = (b: Boundary, fps: number): Span => ({ from: (b.start + 0.5) / fps, to: (b.end + 0.5) / fps });

/** The curve over a window of seconds, `n` points, each the sample that covers its middle. */
const curveOf = (m: Measure, w: Span, n: number): number[] => {
  const dt = m.rhythm.step / fpsOf(m);
  return Array.from({ length: n }, (_, i) => {
    const t = w.from + ((i + 0.5) / n) * (w.to - w.from);
    const k = Math.min(m.rhythm.change.length - 1, Math.max(0, Math.floor(t / dt)));
    return m.rhythm.change[k] ?? 0;
  });
};

/** How much of the two curves lies under both: 1 the same, 0 nothing in common (a spike against a plateau is a small share). */
const shapeOf = (a: number[], b: number[]): number => {
  const lo = a.reduce((s, x, i) => s + Math.min(x, b[i] as number) + NOTHING_MOVES / 2, 0);
  const hi = a.reduce((s, x, i) => s + Math.max(x, b[i] as number) + NOTHING_MOVES / 2, 0);
  return lo / hi;
};

const paramsScore = (a: Declared, b: Declared): number | undefined => {
  const both = ([[a.direction, b.direction], [a.mode, b.mode]] as [string | undefined, string | undefined][]).filter(([x, y]) => x !== undefined && y !== undefined);
  return both.length ? both.filter(([x, y]) => x === y).length / both.length : undefined;
};

/** The same kind 1; another kind of the same family (moves, or blends) a half; the kind's look-alikes by kindCredit; else 0. */
const kindPart = (a: Declared, b: Declared): number => {
  const same = kindCredit(a.kind, b.kind);
  if (same > 0) return same;
  return MOVES.has(a.kind) === MOVES.has(b.kind) ? 0.5 : 0;
};

/** The other's non-cut boundary whose span meets the window; the one whose middle is nearest the window's. */
const boundaryIn = (other: Measure, w: Span): Boundary | undefined => {
  const fb = fpsOf(other), mid = (w.from + w.to) / 2;
  const centre = (b: Boundary): number => { const s = spanOf(b, fb); return (s.from + s.to) / 2; };
  return other.boundaries
    .filter((b) => b.kind !== 'cut' && spanOf(b, fb).from <= w.to && spanOf(b, fb).to >= w.from)
    .sort((x, y) => Math.abs(centre(x) - mid) - Math.abs(centre(y) - mid))[0];
};

export interface ChangeWhere {
  /** Seconds in the other where the change into the shot stands (centre of the search) and how far to search. */
  span: Window;
  tolerance: number;
}

/** Undefined for a shot the reference enters by a cut (or the first shot). */
export const transitionOf = (ref: Measure, other: Measure, into: Boundary | undefined, locate: (reference: Span) => ChangeWhere): TransitionResult | undefined => {
  if (!into || into.kind === 'cut') return undefined;
  const fa = fpsOf(ref), dtA = ref.rhythm.step / fa, dtB = other.rhythm.step / fpsOf(other);
  const reference = spanOf(into, fa);
  const where = locate(reference);
  if (!ref.rhythm.change.length || !other.rhythm.change.length) return undefined;
  const wa = { from: reference.from - CONTEXT_SAMPLES * dtA, to: reference.to + CONTEXT_SAMPLES * dtA };
  const n = Math.max(MIN_POINTS, Math.round((wa.to - wa.from) / dtA));
  const a = curveOf(ref, wa, n);
  // The other's window is as long as the reference's, slid across the search; the best place is where the change is.
  const shifts = Math.max(0, Math.round(where.tolerance / dtB));
  const options = Array.from({ length: 2 * shifts + 1 }, (_, i) => {
    const d = (i - shifts) * dtB, w = { from: where.span.from + d - CONTEXT_SAMPLES * dtA, to: where.span.from + d + (reference.to - reference.from) + CONTEXT_SAMPLES * dtA };
    return { d, w, shape: shapeOf(a, curveOf(other, w, n)) };
  }).sort((x, y) => y.shape - x.shape || Math.abs(x.d) - Math.abs(y.d));
  const best = options[0] as (typeof options)[number];
  const found = boundaryIn(other, { from: best.w.from + CONTEXT_SAMPLES * dtA, to: best.w.to - CONTEXT_SAMPLES * dtA });
  const at: Span = { from: best.w.from + CONTEXT_SAMPLES * dtA, to: best.w.to - CONTEXT_SAMPLES * dtA };
  // A project's own transition names the change it draws; a cut there says nothing (a scene may draw the effect), the curve does.
  const named = where.span.declared && where.span.declared.kind !== 'cut' ? where.span.declared : found;
  if (!named) return { score: best.shape, reference, other: at };
  const params = paramsScore(into, named);
  const kind = params === undefined ? kindPart(into, named) : (kindPart(into, named) + params) / 2;
  const mine = named === found ? found.residual : PRESET_RESIDUAL;
  const plain = into.residual === undefined || mine === undefined ? undefined : 1 - Math.min(1, Math.abs(into.residual - mine));
  const parts = [[WEIGHTS.shape, best.shape], [WEIGHTS.kind, kind], ...(plain === undefined ? [] : [[WEIGHTS.plain, plain]])] as [number, number][];
  // A weighted geometric mean: a change that is wrong in one thing (the picture moves where the reference blends, a plain preset where the reference's is custom) is not rescued by being right in the others.
  return { score: Math.exp(parts.reduce((s, [w, v]) => s + w * Math.log(Math.max(v, MIN_PART)), 0) / parts.reduce((s, [w]) => s + w, 0)), reference, other: found && named === found ? spanOf(found, fpsOf(other)) : at };
};

/** Evenly spaced seconds from the start of a change to its end, both included. */
export const momentsOf = (s: Span, n = LOOK_MOMENTS): number[] =>
  Array.from({ length: n }, (_, k) => Math.round((s.from + ((s.to - s.from) * k) / (n - 1)) * 100) / 100);
