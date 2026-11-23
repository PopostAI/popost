// Parts of this file are adapted from rea-video (https://github.com/JuneYaooo/rea-video), rea_video/transitions.py,
// Copyright 2026 JuneYaooo, licensed under the Apache License 2.0; rewritten in TypeScript, with changes. See NOTICE.
/**
 * Gradual transitions: "a steady picture A, a ramp, a steady picture B" over windows of about 0.15 to 1.7 seconds.
 * A window qualifies when its two ends are different pictures, the picture holds still just outside it, most of the
 * frame changes, the frames inside move from A to B, and neither a camera move, a change of light nor a hard cut inside a
 * moving shot explains it.
 */
import type { Thumbs } from './pixels';
import type { Signals } from './signals';
import { dist, viaOf } from './signals';
import type { Alignment } from './align';
import { align, IDENTITY, motionExplains } from './align';
import type { Similarity } from './align';
import { median } from './pixels';

export interface Ramp {
  /** Last steady frame before the ramp and first steady frame after it (the window's ends). */
  s: number;
  e: number;
}

const WINDOW_SECONDS = [0.15, 0.25, 0.4, 0.6, 0.9, 1.3, 1.7];
/** Just outside the window the picture may change by at most this share of the change across it. */
const PLATEAU = 0.3;
/** Least change across a window, levels of the block-mean picture. */
const MIN_CHANGE = 8;
/** Share of the blocks that must change across the window (a panel opening or a person walking in changes less). */
const MIN_CHANGED = 0.5;

/** Share of blocks of the small pictures of frames i and j whose colour moved by more than 10 levels. */
export const changedShare = (s: Signals, i: number, j: number): number => {
  const a = s.small[i] as Float32Array, b = s.small[j] as Float32Array;
  let hit = 0;
  for (let k = 0; k < a.length; k += 3) {
    const d = Math.max(Math.abs((a[k] as number) - (b[k] as number)), Math.abs((a[k + 1] as number) - (b[k + 1] as number)), Math.abs((a[k + 2] as number) - (b[k + 2] as number)));
    if (d > 10) hit++;
  }
  return hit / (a.length / 3);
};

/** Progress of frame m from picture s (0) to picture e (1), by distance. */
export const progressAt = (s: Signals, a: number, b: number, m: number): number => {
  const da = dist(s, m, a), db = dist(s, m, b);
  return da / (da + db + 1e-6);
};

/**
 * Same scene under different light: per channel, picture b is a gain and an offset of picture a (residual under 15%
 * of the change). Only asked when both ends have detail; between two flat colours light and a dissolve look alike.
 */
export const sameScene = (t: Thumbs, sg: Signals, i: number, j: number): boolean => {
  if (Math.min(sg.gstd[i] as number, sg.gstd[j] as number) < 8) return false;
  const a = sg.small[i] as Float32Array, b = sg.small[j] as Float32Array;
  let resid = 0, change = 0;
  for (let c = 0; c < 3; c++) {
    let sa = 0, sb = 0, saa = 0, sab = 0, n = 0;
    for (let k = c; k < a.length; k += 3) { const x = a[k] as number, y = b[k] as number; sa += x; sb += y; saa += x * x; sab += x * y; n++; }
    const va = saa / n - (sa / n) ** 2;
    const gain = va > 1e-6 ? (sab / n - (sa / n) * (sb / n)) / va : 0;
    const off = sb / n - gain * (sa / n);
    for (let k = c; k < a.length; k += 3) { resid += Math.abs((b[k] as number) - (gain * (a[k] as number) + off)); change += Math.abs((b[k] as number) - (a[k] as number)); }
  }
  void t;
  return change > 0 && resid < 0.15 * change;
};

const steadyAround = (sg: Signals, s: number, e: number, pad: number, dab: number): boolean => {
  const before = Math.max(0, s - pad), after = Math.min(sg.n - 1, e + pad);
  return dist(sg, before, s) <= PLATEAU * dab && dist(sg, e, after) <= PLATEAU * dab;
};

const ramps = (sg: Signals, s: number, e: number, pad: number): boolean => {
  const lo = Math.max(0, s - pad), hi = Math.min(sg.n - 1, e + pad);
  for (let m = lo; m <= s; m++) if (progressAt(sg, s, e, m) > 0.3) return false;
  for (let m = e; m <= hi; m++) if (progressAt(sg, s, e, m) < 0.7) return false;
  // the middle of the window is between the two pictures (a hard cut at its edge would put it at one end)
  const mid = progressAt(sg, s, e, (s + e) >> 1);
  return mid > 0.1 && mid < 0.9;
};

/**
 * The picture keeps moving through the window: no still stretch of more than max(3, 0.25 x L) frames inside it,
 * except on flat black or white (a flash holds white for a third of its span, a fade through black for a frame or
 * two). A window spanning two transitions with a shot between them holds still on that shot.
 */
const keepsMoving = (sg: Signals, s: number, e: number, dab: number): boolean => {
  const still = Math.max(0.8, 0.02 * dab);
  let run = 0, longest = 0;
  for (let m = s + 1; m < e; m++) {
    run = dist(sg, m, m - 1) < still && !viaOf(sg, m) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest <= Math.max(3, 0.25 * (e - s));
};

/**
 * A hard cut inside a moving shot: one step carries most of the change across the window and the other steps inside
 * it are no busier than the shot just outside it. The cut detector reports that cut; read as a ramp, the shot's own
 * movement would pass for the transition.
 */
const cutInPace = (sg: Signals, s: number, e: number, pad: number, dab: number): boolean => {
  let jump = s + 1;
  for (let m = s + 2; m <= e; m++) if (dist(sg, m, m - 1) > dist(sg, jump, jump - 1)) jump = m;
  if (dist(sg, jump, jump - 1) < 0.6 * dab) return false;
  // each side of the jump against the same shot just outside the window
  const steps = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let m = Math.max(1, a); m <= Math.min(sg.n - 1, b); m++) out.push(dist(sg, m, m - 1));
    return out;
  };
  const calm = (inside: number[], outside: number[]): boolean =>
    inside.length < 2 || outside.length === 0 || median(inside) <= 1.5 * median(outside) + 0.5;
  return calm(steps(s + 1, jump - 1), steps(s - pad + 1, s)) && calm(steps(jump + 1, e), steps(e + 1, e + pad));
};

const alignFrames = (t: Thumbs, a: number, b: number): Alignment =>
  align(t.gray[a] as Uint8Array, t.gray[b] as Uint8Array, t.width, t.height, { search: true, rotation: true });

/** Pieces of about 6 frames for chained alignment: a fast pan leaves too little overlap between the window's ends. */
const PIECE = 6;

/**
 * Camera motion: the window's ends are one moved picture, or every piece of the window is (a pan too fast for its
 * ends to overlap). A chain whose shifts add up to one whole frame is a push slide, the new picture sliding in.
 */
const piecesExplain = (t: Thumbs, s: number, e: number): boolean => {
  const n = Math.max(2, Math.ceil((e - s) / PIECE));
  let tx = 0, ty = 0, scale = 1;
  for (let k = 0; k < n; k++) {
    const a = s + Math.round(((e - s) * k) / n), b = s + Math.round(((e - s) * (k + 1)) / n);
    const m = alignFrames(t, a, b);
    if (!motionExplains(m) && m.before > 1.5) return false;
    tx += m.tx;
    ty += m.ty;
    scale *= m.scale;
  }
  const travel = Math.max(Math.abs(tx) / t.width, Math.abs(ty) / t.height);
  return Math.abs(scale - 1) > 0.02 || (travel > 0.02 && Math.abs(travel - 1) > 0.15);
};

const explainedByCamera = (t: Thumbs, sg: Signals, s: number, e: number): boolean =>
  motionExplains(alignFrames(t, s, e)) || piecesExplain(t, s, e) || (!passesFlat(sg, s, e) && followsCamera(t, s, e));

/** A camera shows its picture throughout: a window with a flat black or white frame in it (a fade through a colour,
 *  a flash) is no camera move, however well its small steps fit one. */
const passesFlat = (sg: Signals, s: number, e: number): boolean => {
  for (let m = s; m <= e; m++) if (viaOf(sg, m)) return true;
  return false;
};

/**
 * A fast camera move (a 2x push-in over half a second scales the picture by 10 to 20% from one frame to the next, too
 * much for six-frame pieces): every frame of the window is the one before it moved, fitted frame by frame from the
 * step before (a camera keeps its pace), and the steps add up to a change of scale. Travel alone does not count: a
 * slide or a push moves the whole picture the same way from frame to frame, and a pan is left to the pieces above.
 * The chained steps must also carry the first frame onto the last: a camera shows the same picture throughout, while
 * a slide over a flat colour fits each step (the flat part matches anything flat) but brings in a picture the first
 * frame does not have. A frame that hardly
 * changes (under 1.5 levels) is a hold. A zoom on a fine texture leaves a resampling residual of up to 70% of a small
 * step's difference, so a step counts as a move when it explains a quarter of it (a mix of two pictures explains next
 * to none, and the steps must add up to a real move).
 */
const STEP_EXPLAINS = 0.75;
/** Share of the steps that may go unexplained; each keeps the step before it, as the camera keeps its pace. A step
 *  that moves the frame's corners by under half a pixel is taken as fitted: on a fine texture such a step leaves a
 *  resampling residual as large as its difference (the slow end of an eased move), and it adds next to nothing. */
const UNEXPLAINED = 0.2;
const SUBPIXEL = 0.5;
/** The direct fit of the last frame onto the first may land up to this far (log of scale) from the chained steps: each
 *  small step of a fine texture underestimates its scale a little, and over a second that adds up to a fifth. */
const CHAIN_DRIFT = 0.25;
/** The last frame laid onto the first must lose half of its difference, as motionExplains asks of a move: small steps
 *  of a mix of two pictures fit a camera too (each changes little), but the new picture laid on the old does not. */
const WHOLE_EXPLAINS = 0.5;
const followsCamera = (t: Thumbs, s: number, e: number): boolean => {
  let init: Similarity = IDENTITY, scale = 1, tx = 0, ty = 0, missed = 0;
  for (let m = s; m < e; m++) {
    const a = align(t.gray[m] as Uint8Array, t.gray[m + 1] as Uint8Array, t.width, t.height, { init });
    if (a.before < 1.5) continue;
    const corner = (Math.abs(a.scale - 1) * Math.hypot(t.width, t.height)) / 2 + Math.hypot(a.tx, a.ty);
    const explained = a.residual < STEP_EXPLAINS * a.before || (a.before < 4 && a.residual < 2.5) || corner < SUBPIXEL;
    const step = a.coverage > 0.5 && a.texture > 1.5 && explained ? a : undefined;
    if (!step && ++missed > UNEXPLAINED * (e - s)) return false;
    const k = step ?? init;
    scale *= k.scale;
    tx = k.scale * tx + k.tx;
    ty = k.scale * ty + k.ty;
    init = { scale: k.scale, angle: 0, tx: k.tx, ty: k.ty };
  }
  if (Math.abs(scale - 1) <= 0.05) return false;
  // the closer frame laid onto the wider one (the other way most of it falls outside the frame)
  const inward = scale > 1;
  const [a, b] = inward ? [e, s] : [s, e];
  const chained = inward ? { scale: 1 / scale, angle: 0, tx: -tx / scale, ty: -ty / scale } : { scale, angle: 0, tx, ty };
  const whole = align(t.gray[a] as Uint8Array, t.gray[b] as Uint8Array, t.width, t.height, { init: chained });
  return whole.coverage > 0.5 && whole.residual < WHOLE_EXPLAINS * whole.before && Math.abs(Math.log(whole.scale / chained.scale)) < CHAIN_DRIFT;
};

export const findRamps = (t: Thumbs, sg: Signals): Ramp[] => {
  const found: Ramp[] = [];
  const lengths = [...new Set(WINDOW_SECONDS.map((sec) => Math.max(3, Math.round(sec * sg.fps))))];
  for (const L of lengths) {
    const pad = Math.max(2, Math.min(Math.round(0.3 * sg.fps), Math.round(L / 2)));
    for (let s = 1; s + L < sg.n - 1; s += Math.max(1, Math.round(L / 5))) {
      const e = s + L;
      if (found.some((r) => s < r.e && e > r.s && (r.e - r.s) <= L)) continue;
      const dab = dist(sg, s, e);
      if (dab < MIN_CHANGE || !steadyAround(sg, s, e, pad, dab) || changedShare(sg, s, e) < MIN_CHANGED) continue;
      if (!ramps(sg, s, e, pad) || !keepsMoving(sg, s, e, dab) || cutInPace(sg, s, e, pad, dab)) continue;
      if (sameScene(t, sg, s, e) || explainedByCamera(t, sg, s, e)) continue;
      found.push({ s, e });
    }
  }
  return found.sort((a, b) => a.s - b.s || a.e - b.e);
};