/**
 * Keyframed camera moves of a picture or video base: a pure function from the frame to the scale and offset of the
 * picture. Shared by the page runtime, the build step (how large to extract footage) and the tests.
 */
import type { CameraMove, ResolvedCameraMove } from '../types';
import { clamp01, ease, lerp } from './easing';

export interface CameraState {
  /** Around the centre of the canvas. */
  scale: number;
  /** Offset of the picture as fractions of the canvas width and height, applied with the scale around the centre. */
  translate: [number, number];
}

export const STILL_CAMERA: CameraState = { scale: 1, translate: [0, 0] };

/** A move with its defaults filled in and its frames made absolute (start: the segment's first frame). */
export const fullMove = (m: CameraMove, start: number): ResolvedCameraMove => ({
  from: start + m.from,
  to: start + m.to,
  scale: m.scale,
  focus: m.focus ?? [0.5, 0.5],
  shift: m.shift ?? [[0, 0], [0, 0]],
  ease: m.ease ?? 'linear',
});

/**
 * The state of one move at eased progress e: the scale around the focus point f (which stays in place on screen:
 * f + s (p - f) = c + s (p - c) + (1 - s)(f - c) with c the centre), plus the shift.
 */
const moveState = (m: ResolvedCameraMove, e: number): CameraState => {
  const s = lerp(m.scale[0], m.scale[1], e);
  const shift = [lerp(m.shift[0][0], m.shift[1][0], e), lerp(m.shift[0][1], m.shift[1][1], e)];
  return { scale: s, translate: [(1 - s) * (m.focus[0] - 0.5) + (shift[0] ?? 0), (1 - s) * (m.focus[1] - 0.5) + (shift[1] ?? 0)] };
};

/**
 * The camera of a list of moves (in time order, not overlapping) at absolute frame n: the move under way, else the
 * end of the last move that has finished, else the start of the first.
 */
export const movesAt = (moves: readonly ResolvedCameraMove[], n: number): CameraState => {
  const first = moves[0];
  if (!first) return STILL_CAMERA;
  const current = [...moves].reverse().find((m) => n >= m.from) ?? first;
  const t = n < current.from ? 0 : clamp01((n - current.from) / Math.max(1, current.to - current.from));
  return moveState(current, ease(current.ease, t));
};

/** The largest scale any of the moves reaches (each is monotonic, so at one of its ends). */
export const movesPeak = (moves: readonly ResolvedCameraMove[]): number => Math.max(1, ...moves.flatMap((m) => m.scale));

/**
 * How far an edge of the picture would show at the start or end of a move, as a fraction of the canvas (0 = none).
 * A covering picture shows no edge while |offset| <= (scale - 1) / 2 on both axes; scale and offset change together
 * along one eased progress, so the worst point is at an end.
 */
export const edgeShown = (m: ResolvedCameraMove): number =>
  Math.max(...[0, 1].map((e) => {
    const st = moveState(m, e);
    return Math.max(0, ...st.translate.map((t) => Math.abs(t) - (st.scale - 1) / 2));
  }));
