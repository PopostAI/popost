/**
 * Keyframed camera moves inside one shot: the camera holds, zooms between two scales around a focus point over some
 * frames (eased), then holds (CameraMove in types.ts). The global similarity between consecutive samples (align.ts) is
 * chained into the scale of every sample relative to the first; a hold, an eased ramp and a hold are fitted to the log
 * of that scale, frame by frame, with the easings the format knows. A move is reported only when that fits clearly
 * better than one rate over the shot (CameraRate): a linear ramp over the whole shot is a rate.
 */
import type { CameraMeasure, Ease } from '../types';
import type { Alignment, Similarity } from './align';
import { align, IDENTITY } from './align';
import { round } from './pixels';
import { gaussBlur } from './robust';

export interface MoveInput {
  width: number;
  height: number;
  gray: readonly Uint8Array[];
  /** Native frame of each sample, in order. */
  frames: readonly number[];
  /** Frames per second of the native frames: a move lasts at least MIN_SECONDS. */
  fps: number;
}

export type MeasuredMove = NonNullable<CameraMeasure['moves']>[number] & { ease: Ease };

/** Chained motion of every sample against the first: scale and shift (pixels), as camera.ts chains it. */
interface Track { logS: number[]; S: number[]; tx: number[]; ty: number[] }

/**
 * A step between two samples is trusted when it explains the picture and stays within what a camera does in 1/15 s.
 * A small step leaves a residual of resampling (a fine texture scaled by 1% differs by a level or two), so it is
 * trusted when what is left is small, even if that is not much less than the difference before.
 */
const trusted = (a: Alignment): boolean =>
  a.coverage > 0.3 && a.texture >= 1.5 && (a.residual < 0.6 * a.before || (a.before < 4 && a.residual < 2.5)) && a.scale > 0.6 && a.scale < 1.7 && Math.abs(a.angle) < 0.05;

/** At most this share of the steps may be untrusted; each is replaced by the step before it (a camera keeps its pace). */
const UNTRUSTED = 0.2;

/**
 * Samples are compared softened by a Gaussian of SOFT pixels: a fine, low-contrast texture scaled by 3% between two
 * samples decorrelates pixel by pixel (the fit explains none of it), while its coarser pattern still follows the move.
 */
const SOFT = 1;

/** One step between consecutive samples: the motion used (the fit, or the step before when the fit is not trusted). */
interface Step { scale: number; tx: number; ty: number; ok: boolean }

/** Every step of a shot, fitted once from the step before (a camera keeps its pace), with a coarse search when that fails. */
const stepsOf = (soft: readonly Float32Array[], w: number, h: number): Step[] => {
  const out: Step[] = [];
  let init: Similarity = IDENTITY;
  for (let i = 0; i + 1 < soft.length; i++) {
    const a = soft[i] as Float32Array, b = soft[i + 1] as Float32Array;
    let fit = align(a, b, w, h, { init });
    if (!trusted(fit)) {
      const searched = align(a, b, w, h, { search: true });
      if (searched.residual < fit.residual) fit = searched;
    }
    const ok = trusted(fit);
    const used = ok ? fit : init;
    out.push({ scale: used.scale, tx: used.tx, ty: used.ty, ok });
    init = { scale: used.scale, angle: 0, tx: used.tx, ty: used.ty };
  }
  return out;
};

/** The steps of samples a .. b - 1 chained from sample a; undefined when too many of them are not trusted. */
const trackOf = (st: readonly Step[], a: number, b: number): Track | undefined => {
  const part = st.slice(a, b - 1);
  if (part.filter((s) => !s.ok).length > UNTRUSTED * part.length) return undefined;
  const t: Track = { logS: [0], S: [1], tx: [0], ty: [0] };
  part.forEach((s, i) => {
    const S = (t.S[i] as number) * s.scale;
    t.S.push(S);
    t.logS.push(Math.log(S));
    t.tx.push(s.scale * (t.tx[i] as number) + s.tx);
    t.ty.push(s.scale * (t.ty[i] as number) + s.ty);
  });
  return t;
};

const EASES: readonly Ease[] = ['linear', 'in', 'out', 'in-out'];
const easeAt = (kind: Ease, x: number): number => {
  const q = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (kind === 'in') return q * q * q;
  if (kind === 'out') return 1 - (1 - q) ** 3;
  if (kind === 'in-out') return q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2;
  return q;
};

interface Fit { start: number; end: number; ease: Ease; ratio: number; base: number; err: number }

/** Mean of the log scale over samples whose frame lies in lo..hi (inclusive); undefined when none. */
const meanIn = (fr: readonly number[], v: readonly number[], lo: number, hi: number): number | undefined => {
  let s = 0, n = 0;
  fr.forEach((f, i) => { if (f >= lo && f <= hi) { s += v[i] as number; n++; } });
  return n ? s / n : undefined;
};

/**
 * The hold, ramp, hold model with the ramp from frame s to frame e, its best easing and squared error. Undefined when
 * the holds alone already err by bound or more: every term is a square, and a sum of terms that are not negative never
 * falls as terms are added (rounding included), so no easing could then come under bound.
 */
const fitAt = (fr: readonly number[], L: readonly number[], s: number, e: number, bound = Infinity): Fit | undefined => {
  const first = fr[0] as number, last = fr[fr.length - 1] as number;
  const base = meanIn(fr, L, first, s) ?? (L[0] as number);
  const top = meanIn(fr, L, e, last) ?? (L[L.length - 1] as number);
  const ratio = Math.exp(top - base);
  const holdTerm = (i: number, x: number): number => ((L[i] as number) - (base + Math.log(1 + (ratio - 1) * (x <= 0 ? 0 : 1)))) ** 2;
  if (bound < Infinity) {
    let hold = 0;
    for (let i = 0; i < fr.length; i++) {
      const x = ((fr[i] as number) - s) / (e - s);
      if (x <= 0 || x >= 1) hold += holdTerm(i, x);
    }
    if (hold >= bound) return undefined;
  }
  // the four easings in one pass: outside the ramp they agree (0 before it, 1 after), so those terms are worked out
  // once; each easing still adds its terms in the order of the samples
  const errs = [0, 0, 0, 0];
  for (let i = 0; i < fr.length; i++) {
    const x = ((fr[i] as number) - s) / (e - s);
    if (x <= 0 || x >= 1) {
      const term = holdTerm(i, x);
      for (let k = 0; k < 4; k++) errs[k] = (errs[k] as number) + term;
      continue;
    }
    for (let k = 0; k < 4; k++) errs[k] = (errs[k] as number) + ((L[i] as number) - (base + Math.log(1 + (ratio - 1) * easeAt(EASES[k] as Ease, x)))) ** 2;
  }
  let best: Fit | undefined;
  for (let k = 0; k < EASES.length; k++) {
    const err = errs[k] as number;
    if (!best || err < best.err - 1e-12) best = { start: s, end: e, ease: EASES[k] as Ease, ratio, base, err };
  }
  return best;
};

/**
 * Hold, eased ramp from frame start to frame end (scale lerped as the format does), hold: least squares on log scale.
 * The ramp lasts at least minFrames. Its ends are searched on the sampled frames, then frame by frame around the best.
 */
const fitMove = (fr: readonly number[], L: readonly number[], minFrames: number): Fit | undefined => {
  const first = fr[0] as number, last = fr[fr.length - 1] as number, gap = Math.max(1, Math.round((last - first) / Math.max(1, fr.length - 1)));
  const minLen = Math.max(2, minFrames);
  let best: Fit | undefined;
  const consider = (s: number, e: number): void => {
    if (s < first || e > last || e - s < minLen) return;
    const f = fitAt(fr, L, s, e, best ? best.err - 1e-12 : Infinity);
    if (f && (!best || f.err < best.err - 1e-12)) best = f;
  };
  for (const s of fr) for (const e of fr) consider(s, e);
  // then frame by frame around the best until no neighbour fits better (an eased end is a shallow minimum)
  for (let prev: Fit | undefined; best && best !== prev; ) {
    prev = best;
    const { start, end } = best;
    for (let s = start - gap; s <= start + gap; s++) for (let e = end - gap; e <= end + gap; e++) consider(s, e);
  }
  return best;
};

/** One rate over the shot: the scale linear in time (CameraRate), fitted by least squares on the scale. */
const rateError = (fr: readonly number[], S: readonly number[], L: readonly number[]): number => {
  const n = fr.length, mx = fr.reduce((a, b) => a + b, 0) / n, my = S.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  fr.forEach((f, i) => { sxy += (f - mx) * ((S[i] as number) - my); sxx += (f - mx) ** 2; });
  const b = sxx > 0 ? sxy / sxx : 0;
  return fr.reduce((err, f, i) => { const p = my + b * (f - mx); return err + (p > 0 ? ((L[i] as number) - Math.log(p)) ** 2 : 1); }, 0);
};

/** A move changes the scale by at least 5% over at least a third of a second (a transition's eased tail at the start
 *  of a shot scales the picture back within a few frames); and it must explain the scale clearly better than one rate (a
 *  quarter of the rate's squared error) and well (rms under 1.5% of scale), so a steady push-in or a shaky hold stays a
 *  rate. */
const MIN_RATIO = 1.05;
const MIN_SECONDS = 1 / 3;
const BETTER = 0.25;
const RMS = 0.015;

/**
 * The scale between the frames at the move's start and end, and the point that stays in place: the zoomed-in frame is
 * aligned onto the wider one directly (the chain gives the start, and a chain of small steps on a fine texture comes
 * out a few percent short), and the fixed point of that similarity is c + t / (1 - s).
 */
const endpoints = (c: MoveInput, soft: readonly Float32Array[], tr: Track, i0: number, i1: number): { ratio: number; focus?: [number, number] } => {
  const S01 = (tr.S[i1] as number) / (tr.S[i0] as number);
  const T01x = (tr.tx[i1] as number) - S01 * (tr.tx[i0] as number), T01y = (tr.ty[i1] as number) - S01 * (tr.ty[i0] as number);
  // map of the zoomed-in frame into the wider one
  const inward = S01 >= 1;
  const init: Similarity = inward ? { scale: 1 / S01, angle: 0, tx: -T01x / S01, ty: -T01y / S01 } : { scale: S01, angle: 0, tx: T01x, ty: T01y };
  const a = soft[inward ? i1 : i0] as Float32Array, b = soft[inward ? i0 : i1] as Float32Array;
  const fit = align(a, b, c.width, c.height, { init });
  const sim = fit.residual < 0.6 * fit.before ? fit : init;
  const ratio = inward ? 1 / sim.scale : sim.scale;
  if (Math.abs(1 - sim.scale) < 0.02) return { ratio };
  const fx = ((c.width - 1) / 2 + sim.tx / (1 - sim.scale) + 0.5) / c.width, fy = ((c.height - 1) / 2 + sim.ty / (1 - sim.scale) + 0.5) / c.height;
  return fx > -0.1 && fx < 1.1 && fy > -0.1 && fy < 1.1 ? { ratio, focus: [round(fx, 3), round(fy, 3)] } : { ratio };
};

/** Samples strictly inside the ramp whose log scale lies between a tenth and nine tenths of the way: a ramp drawn
 *  through one jump (a transition's last frame at the start of a shot) has none. */
const inBetween = (fr: readonly number[], L: readonly number[], fit: Fit): number => {
  const top = fit.base + Math.log(fit.ratio);
  return fr.filter((f, i) => {
    const q = ((L[i] as number) - fit.base) / (top - fit.base);
    return f > fit.start && f < fit.end && q > 0.1 && q < 0.9;
  }).length;
};

/** The move of a run of samples, from its soft samples and the steps between them. */
const moveOf = (c: MoveInput, soft: readonly Float32Array[], st: readonly Step[]): MeasuredMove | undefined => {
  const tr = trackOf(st, 0, soft.length);
  if (!tr) return undefined;
  const fit = fitMove(c.frames, tr.logS, Math.round(MIN_SECONDS * c.fps));
  if (!fit) return undefined;
  if (Math.max(fit.ratio, 1 / fit.ratio) < MIN_RATIO || inBetween(c.frames, tr.logS, fit) < 2) return undefined;
  const rms = Math.sqrt(fit.err / c.frames.length);
  if (rms > RMS || fit.err > BETTER * rateError(c.frames, tr.S, tr.logS)) return undefined;
  const i0 = c.frames.reduce((k, f, i) => (f <= fit.start ? i : k), 0);
  const i1 = c.frames.findIndex((f) => f >= fit.end);
  const { ratio, focus } = endpoints(c, soft, tr, i0, i1 < 0 ? c.frames.length - 1 : i1);
  // the direct fit is the better measure of the scale: a drifting chain over a pan can fake a ramp it does not confirm
  if (Math.max(ratio, 1 / ratio) < MIN_RATIO) return undefined;
  const scale: [number, number] = ratio >= 1 ? [1, round(ratio, 3)] : [round(1 / ratio, 3), 1];
  return { start: fit.start, end: fit.end, scale, ...(focus ? { focus } : {}), ease: fit.ease };
};

/** The first or last fifth of a second of a shot's interior may still carry a transition the boundary reader cut
 *  short (a glitch read as a cut leaves its jolts in the next shot); the move is also looked for without them. */
const EDGE_SECONDS = 0.2;

/** The keyframed move of a shot, or undefined when the camera holds or runs at one rate. */
export const measureMove = (c: MoveInput): MeasuredMove | undefined => {
  const n = c.gray.length;
  if (n < 6) return undefined;
  const soft = c.gray.map((g) => gaussBlur(g, c.width, c.height, SOFT, false));
  const st = stepsOf(soft, c.width, c.height);
  const step = Math.max(1, ((c.frames[n - 1] as number) - (c.frames[0] as number)) / (n - 1));
  const k = Math.max(1, Math.round((EDGE_SECONDS * c.fps) / step));
  const trims: Array<[number, number]> = n - 2 * k >= 6 ? [[0, 0], [k, 0], [0, k], [k, k]] : [[0, 0]];
  for (const [a, b] of trims) {
    const mv = moveOf({ ...c, gray: c.gray.slice(a, n - b), frames: c.frames.slice(a, n - b) }, soft.slice(a, n - b), st.slice(a, n - b - 1));
    if (mv) return mv;
  }
  return undefined;
};