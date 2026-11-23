/**
 * Camera movement inside a shot: the global similarity between frames a third of a second apart (align.ts), chained
 * from the shot's first clean frame to its last, then fitted with the conventions of CameraSpec: the scale grows as
 * 1 + zoom x seconds (a pull-out ends at scale 1), and the picture travels pan x canvas per second.
 */
import type { CameraMeasure } from '../types';
import type { Alignment, Similarity } from './align';
import { align } from './align';
import { median, round } from './pixels';
import { measureMove } from './moves';

/**
 * Gray frames of one shot's clean interior with the time of each, seconds from the first. With frames (the native
 * frame of each) and seconds (the whole shot's length), a keyframed move is looked for first (moves.ts).
 */
export interface CameraInput { width: number; height: number; gray: readonly Uint8Array[]; times: readonly number[]; frames?: readonly number[]; seconds?: number }

/** Below these rates (per second) the camera counts as still: half a percent of scale or of the frame. */
const STILL_ZOOM = 0.005;
const STILL_PAN = 0.005;
/** Mean gradient (levels per pixel) under which a picture has nothing to track. */
const MIN_TEXTURE = 1.5;

const UNKNOWN: CameraMeasure = { kind: 'unknown', zoomPerS: 0, panPerS: [0, 0], confidence: 0 };

interface Step { dt: number; scale: number; tx: number; ty: number; ok: boolean; flat: boolean }

/**
 * The motion between samples i and j, from the previous step's motion; the first step also tries a coarse search and
 * keeps whichever fits better (a title fading in can lure the search to a false shift).
 */
const fitStep = (c: CameraInput, i: number, j: number, init: Similarity, first: boolean): Alignment => {
  const a = c.gray[i] as Uint8Array, b = c.gray[j] as Uint8Array;
  const near = align(a, b, c.width, c.height, { init });
  if (!first) return near;
  const searched = align(a, b, c.width, c.height, { init, search: true });
  return searched.residual < near.residual ? searched : near;
};

const steps = (c: CameraInput): Step[] => {
  const n = c.gray.length;
  const span = (c.times[n - 1] as number) - (c.times[0] as number);
  const stride = Math.max(1, Math.round((n - 1) / Math.max(1, Math.round(span / 0.33))));
  const out: Step[] = [];
  let init: Similarity = { scale: 1, angle: 0, tx: 0, ty: 0 };
  for (let i = 0; i + 1 < n; i += stride) {
    const j = Math.min(n - 1, i + stride);
    const a = fitStep(c, i, j, init, out.length === 0);
    const ok = a.coverage > 0.5 && a.texture >= MIN_TEXTURE && (a.before < 1 || a.residual < 0.6 * a.before) && a.scale > 0.7 && a.scale < 1.4;
    out.push({ dt: (c.times[j] as number) - (c.times[i] as number), scale: a.scale, tx: a.tx / c.width, ty: a.ty / c.height, ok, flat: a.texture < MIN_TEXTURE });
    if (ok) init = { scale: a.scale, angle: 0, tx: a.tx, ty: a.ty };
    if (j === n - 1) break;
  }
  return out;
};

/** Least-squares slope through the origin. */
const slope = (ts: number[], vs: number[]): number => {
  let num = 0, den = 0;
  ts.forEach((t, i) => { num += t * (vs[i] as number); den += t * t; });
  return den > 0 ? num / den : 0;
};

/** A shot with a keyframed move: the move, and zoomPerS as the mean rate over the whole shot (as the truth says). */
const withMove = (c: CameraInput): CameraMeasure | undefined => {
  if (!c.frames || !c.seconds) return undefined;
  const n = c.frames.length, span = (c.times[n - 1] as number) - (c.times[0] as number);
  const fps = span > 0 ? ((c.frames[n - 1] as number) - (c.frames[0] as number)) / span : 30;
  const mv = measureMove({ width: c.width, height: c.height, gray: c.gray, frames: c.frames, fps });
  if (!mv) return undefined;
  const { ease: _ease, ...move } = mv;
  return { kind: 'move', zoomPerS: round((move.scale[1] / move.scale[0] - 1) / c.seconds, 4), panPerS: [0, 0], confidence: 0.8, moves: [move] };
};

/** A keyframed move changes the scale by 5% or more (moves.ts): a shot whose steps a third of a second apart are
 *  trusted or too flat to track, and never take the scale 3% from where it started, has none (moves.ts cannot track a
 *  flat picture either), and the frame-by-frame search is skipped. */
const mayMove = (st: readonly Step[]): boolean => {
  let S = 1;
  for (const s of st) {
    if (s.flat) continue;
    if (!s.ok) return true;
    S *= s.scale;
    if (Math.abs(S - 1) > 0.03) return true;
  }
  return false;
};

export const measureCamera = (c: CameraInput): CameraMeasure => {
  if (c.gray.length < 3) return UNKNOWN;
  const st = steps(c);
  const moved = mayMove(st) ? withMove(c) : undefined;
  if (moved) return moved;
  const good = st.filter((s) => s.ok);
  if (good.length < Math.max(1, 0.5 * st.length)) return UNKNOWN;
  // chain: x_j = c + S_j (x_0 - c) + T_j; a step (s, t) gives S' = s S, T' = s T + t
  let S = 1, tx = 0, ty = 0, time = 0;
  const ts: number[] = [], zs: number[] = [], xs: number[] = [], ys: number[] = [];
  for (const s of st) {
    time += s.dt;
    if (s.ok) { S *= s.scale; tx = s.scale * tx + s.tx; ty = s.scale * ty + s.ty; }
    ts.push(time); zs.push(S - 1); xs.push(tx); ys.push(ty);
  }
  const z1 = slope(ts, zs);
  const zoomPerS = z1 >= 0 ? z1 : z1 / S; // a pull-out is measured from a scale that ends at 1
  const panPerS: [number, number] = [slope(ts, xs), slope(ts, ys)];
  const rates = good.map((s) => [s.tx / s.dt, s.ty / s.dt] as const);
  const path = good.reduce((a, s) => a + Math.hypot(s.tx, s.ty), 0), net = Math.hypot(tx, ty);
  const flips = rates.slice(1).filter((r, i) => r[0] * (rates[i] as readonly [number, number])[0] < 0 || r[1] * (rates[i] as readonly [number, number])[1] < 0).length;
  const moving = Math.abs(zoomPerS) >= STILL_ZOOM || Math.hypot(...panPerS) >= STILL_PAN;
  const confidence = round(Math.min(1, good.length / st.length) * (good.length >= 3 ? 0.9 : 0.6), 3);
  if (path > 0.03 && path > 3 * net && flips >= 0.4 * rates.length) return { kind: 'unsteady', zoomPerS: round(zoomPerS, 4), panPerS: [round(panPerS[0], 4), round(panPerS[1], 4)], confidence };
  if (!moving) return { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence };
  return { kind: 'move', zoomPerS: round(zoomPerS, 4), panPerS: [round(panPerS[0], 4), round(panPerS[1], 4)], confidence };
};

export { median };