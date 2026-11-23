// Parts of this file are adapted from rea-video (https://github.com/JuneYaooo/rea-video), rea_video/transitions.py,
// Copyright 2026 JuneYaooo, licensed under the Apache License 2.0; rewritten in TypeScript, with changes. See NOTICE.
/**
 * Models of what happens inside a transition span, each fitted to the in-between frames with the span's two ends
 * A (last old frame) and B (first new frame) as the pictures being mixed. Residuals are relative to |A - B|, so 0 is
 * a perfect fit and 1 is as wrong as showing the other picture.
 */
import type { Direction, WipeDirection } from '../types';
import { correlation, median, quantile } from './pixels';

/** A picture as interleaved rgb floats. */
export interface Img { w: number; h: number; data: Float32Array }

const absDiff = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / Math.max(1, a.length);
};

export interface VeilFit {
  /** Median relative residual of "frame = (1 - o) X + o C", X the old or the new picture, C the flat colour. */
  residual: number;
  via: 'black' | 'white';
  /** Veil opacity per in-between frame. */
  opacity: number[];
  /** Per in-between frame: true when the new picture is the one under the veil. */
  isNew: boolean[];
}

const veilOne = (X: Float32Array, M: Float32Array, c: number): { o: number; r: number } => {
  let num = 0, den = 0;
  for (let i = 0; i < X.length; i++) { const d = (X[i] as number) - c; num += d * ((X[i] as number) - (M[i] as number)); den += d * d; }
  const o = den > 1e-6 ? Math.min(1, Math.max(0, num / den)) : 1;
  let r = 0;
  for (let i = 0; i < X.length; i++) r += Math.abs((M[i] as number) - ((1 - o) * (X[i] as number) + o * c));
  return { o, r: r / X.length };
};

/** Fade or flash: each frame is the old or the new picture under a veil of black or white. */
export const fitVeil = (A: Float32Array, B: Float32Array, mids: readonly Float32Array[]): VeilFit => {
  const D = absDiff(A, B) + 1e-6;
  const fits = (['black', 'white'] as const).map((via) => {
    const c = via === 'black' ? 0 : 255;
    const per = mids.map((M) => { const a = veilOne(A, M, c), b = veilOne(B, M, c); return b.r < a.r ? { ...b, isNew: true } : { ...a, isNew: false }; });
    return { via, residual: median(per.map((p) => p.r / D)), opacity: per.map((p) => p.o), isNew: per.map((p) => p.isNew) };
  });
  const [k, w] = fits as [VeilFit, VeilFit];
  return k.residual <= w.residual ? k : w;
};

export interface BlendFit { residual: number; alpha: number[]; rising: boolean }

/** Dissolve: every frame is A + alpha (B - A) with alpha rising through the span. */
export const fitBlend = (A: Float32Array, B: Float32Array, mids: readonly Float32Array[]): BlendFit => {
  let den = 0, scale = 0;
  for (let i = 0; i < A.length; i++) { const d = (B[i] as number) - (A[i] as number); den += d * d; scale += Math.abs(d); }
  scale = scale / A.length + 1e-6;
  const per = mids.map((M) => {
    let num = 0;
    for (let i = 0; i < A.length; i++) num += ((M[i] as number) - (A[i] as number)) * ((B[i] as number) - (A[i] as number));
    const alpha = den > 1e-6 ? num / den : 0;
    let r = 0;
    for (let i = 0; i < A.length; i++) r += Math.abs((M[i] as number) - ((A[i] as number) + alpha * ((B[i] as number) - (A[i] as number))));
    return { alpha, r: r / A.length / scale };
  });
  const alpha = per.map((p) => p.alpha);
  const idx = alpha.map((_, i) => i);
  const rising = alpha.length < 3 ? (alpha[0] ?? 0) > -0.1 && (alpha[alpha.length - 1] ?? 1) < 1.1 : correlation(alpha, idx) > 0.85 && (alpha[0] as number) < 0.6 && (alpha[alpha.length - 1] as number) > 0.4;
  return { residual: median(per.map((p) => p.r)), alpha, rising };
};

export type EdgeMode = 'wipe' | 'push' | 'cover' | 'reveal';
export interface EdgeFit {
  mode: EdgeMode;
  direction: Direction;
  residual: number;
  position: number[];
  /** Median error with the best blur along the travel axis over the error without: about 1 for a sharp slide, well
   *  under 1 when the pictures are smeared as they travel (a whip). */
  smear: number;
}

/** A copy of a picture turned so that the edge travels left: u along the travel axis, v across it, index (v * size + u) * 3 + c. */
interface Oriented { size: number; across: number; data: Float32Array }

const orient = (img: Img, dir: Direction): Oriented => {
  const { w, h, data } = img;
  const horizontal = dir === 'left' || dir === 'right';
  const size = horizontal ? w : h, across = horizontal ? h : w;
  const out = new Float32Array(size * across * 3);
  for (let v = 0; v < across; v++) {
    for (let u = 0; u < size; u++) {
      const x = dir === 'left' ? u : dir === 'right' ? w - 1 - u : v;
      const y = dir === 'up' ? u : dir === 'down' ? h - 1 - u : v;
      for (let c = 0; c < 3; c++) out[(v * size + u) * 3 + c] = data[(y * w + x) * 3 + c] as number;
    }
  }
  return { size, across, data: out };
};

/** The composed picture with the edge travelled k pixels (new picture on the far side), in oriented layout. */
const compose = (mode: EdgeMode, A: Oriented, B: Oriented, k: number): Float32Array => {
  const { size, across } = A;
  const cut = size - k;
  const oldShift = mode === 'push' || mode === 'reveal' ? k : 0;
  const newShift = mode === 'push' || mode === 'cover' ? -cut : 0;
  const out = new Float32Array(A.data.length);
  for (let v = 0; v < across; v++) {
    for (let u = 0; u < size; u++) {
      const src = u < cut ? (v * size + u + oldShift) * 3 : (v * size + u + newShift) * 3;
      const pic = u < cut ? A.data : B.data;
      for (let c = 0; c < 3; c++) out[(v * size + u) * 3 + c] = pic[src + c] as number;
    }
  }
  return out;
};

/** Two box passes of radius r along u (the travel axis). */
const smearAlong = (P: Float32Array, size: number, across: number, r: number): Float32Array => {
  let cur = P;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(cur.length);
    for (let v = 0; v < across; v++) {
      for (let u = 0; u < size; u++) {
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          for (let q = Math.max(0, u - r); q <= Math.min(size - 1, u + r); q++) { s += cur[(v * size + q) * 3 + c] as number; n++; }
          out[(v * size + u) * 3 + c] = s / n;
        }
      }
    }
    cur = out;
  }
  return cur;
};

const smearRatio = (fit: { mode: EdgeMode; direction: Direction; position: number[] }, A: Img, B: Img, mids: readonly Img[]): number => {
  const oa = orient(A, fit.direction), ob = orient(B, fit.direction);
  const ratios = mids.map((m, i) => {
    const om = orient(m, fit.direction);
    const P = compose(fit.mode, oa, ob, Math.round((fit.position[i] as number) * oa.size));
    const err = (Q: Float32Array): number => absDiff(Q, om.data);
    const sharp = err(P) + 1e-6;
    return Math.min(1, ...[1, 2, 3].map((r) => err(smearAlong(P, oa.size, oa.across, r)) / sharp));
  });
  // a whip smears most in the middle of its travel and hardly at either end, so the median of all frames dilutes it
  return quantile(ratios, 0.25);
};

/** Error of frame M against the composed picture with the edge travelled k pixels (new picture on the far side). */
const edgeError = (mode: EdgeMode, A: Oriented, B: Oriented, M: Oriented, k: number): number => {
  const { size, across } = A;
  const cut = size - k;
  const oldShift = mode === 'push' || mode === 'reveal' ? k : 0;
  const newShift = mode === 'push' || mode === 'cover' ? -cut : 0;
  const a = A.data, b = B.data, m = M.data;
  let err = 0;
  for (let v = 0; v < across; v++) {
    const row = v * size;
    for (let u = 0; u < size; u++) {
      const src = u < cut ? (row + u + oldShift) * 3 : (row + u + newShift) * 3;
      const pic = u < cut ? a : b;
      const at = (row + u) * 3;
      err += Math.abs((m[at] as number) - (pic[src] as number)) + Math.abs((m[at + 1] as number) - (pic[src + 1] as number)) + Math.abs((m[at + 2] as number) - (pic[src + 2] as number));
    }
  }
  return err / (size * across * 3);
};

const DIRS: readonly Direction[] = ['left', 'right', 'up', 'down'];
const MODES: readonly EdgeMode[] = ['wipe', 'push', 'cover', 'reveal'];

/**
 * Wipe or slide: a straight edge crosses the frame; on one side the old picture, on the other the new one, each
 * still (wipe) or moving with the edge (push: both, cover: the new one, reveal: the old one). The edge must travel
 * across the frame in order. Nothing moving is the simpler reading, so a moving mode must fit clearly better.
 */
export const fitEdge = (A: Img, B: Img, mids: readonly Img[]): EdgeFit | undefined => {
  // one in-between frame shows where an edge is, not that it travels: a hard cut with one odd frame is not a wipe
  if (mids.length < 2) return undefined;
  const D = absDiff(A.data, B.data) + 1e-6;
  let best: EdgeFit | undefined;
  for (const direction of DIRS) {
    const oa = orient(A, direction), ob = orient(B, direction), oms = mids.map((m) => orient(m, direction));
    const step = Math.max(1, Math.round(oa.size / 24));
    for (const mode of MODES) {
      const res: number[] = [], pos: number[] = [];
      for (const om of oms) {
        let bk = 0, be = Infinity;
        for (let k = 0; k <= oa.size; k += step) { const e = edgeError(mode, oa, ob, om, k); if (e < be) { be = e; bk = k; } }
        res.push(be / D);
        pos.push(bk / oa.size);
      }
      const r = median(res);
      const better = !best || r < best.residual * (best.mode === 'wipe' && mode !== 'wipe' ? 0.8 : 1);
      if (better) best = { mode, direction, residual: r, position: pos, smear: 1 };
    }
  }
  if (!best) return undefined;
  const pos = best.position;
  // the edge moves on through the frames (they are the mixed ones, so on most of them it is inside the frame)
  const inside = pos.filter((p) => p > 0 && p < 1).length >= pos.length / 2;
  const travels = pos.length < 3 ? (pos[pos.length - 1] ?? 0) > (pos[0] ?? 0) : correlation(pos, pos.map((_, i) => i)) > 0.8 && (pos[pos.length - 1] as number) - (pos[0] as number) >= 0.15;
  if (!travels || !inside) return undefined;
  return best.mode === 'wipe' ? best : { ...best, smear: smearRatio(best, A, B, mids) };
};

/**
 * How well a straight edge explains the frames once its place is found to the pixel (fitEdge searches a 24th of the
 * frame at a time): refined, the median residual then; bend, the median over the frames of how far apart the edge
 * stands in four bands across its travel when each band finds its own place (shares of the frame). A straight edge
 * stands in one place in every band; a curved one, or one led by a moving shape, does not.
 */
export const edgeShape = (A: Img, B: Img, mids: readonly Img[], fit: EdgeFit): { refined: number; bend: number } => {
  const D = absDiff(A.data, B.data) + 1e-6;
  const oa = orient(A, fit.direction), ob = orient(B, fit.direction);
  const step = Math.max(1, Math.round(oa.size / 24));
  const BANDS = 4;
  const res: number[] = [], bends: number[] = [];
  mids.forEach((m, i) => {
    const om = orient(m, fit.direction);
    const k0 = Math.round((fit.position[i] as number) * oa.size);
    let be = Infinity;
    for (let k = Math.max(0, k0 - step); k <= Math.min(oa.size, k0 + step); k++) be = Math.min(be, edgeError(fit.mode, oa, ob, om, k));
    res.push(be / D);
    const rows = Math.max(1, Math.floor(oa.across / BANDS));
    const places: number[] = [];
    for (let band = 0; band < BANDS; band++) {
      const v0 = band * rows, v1 = band === BANDS - 1 ? oa.across : v0 + rows;
      const cut = (o: Oriented): Oriented => ({ size: o.size, across: v1 - v0, data: o.data.subarray(v0 * o.size * 3, v1 * o.size * 3) });
      const ba = cut(oa), bb = cut(ob), bm = cut(om);
      let bk = 0, bandBest = Infinity;
      for (let k = 0; k <= oa.size; k++) { const e = edgeError(fit.mode, ba, bb, bm, k); if (e < bandBest) { bandBest = e; bk = k; } }
      places.push(bk / oa.size);
    }
    bends.push(Math.max(...places) - Math.min(...places));
  });
  return { refined: median(res), bend: median(bends) };
};

/** residual: how far each changing block is from the picture it is nearer to, relative to |A - B| (median over the frames both pictures share). */
export interface RegionFit { purity: number; direction?: WipeDirection; share: number[]; residual: number }

/**
 * Shaped wipes (iris, clock, diagonal, blinds): block by block every in-between frame is the old picture or the new
 * one, the new part grows and a block, once new, stays new. The direction comes from the order in which blocks turn:
 * along x or y, or with the distance from the centre (center-out / edges-in). Blocks are the rgb block means of
 * the small picture (sw x sh blocks).
 */
export const fitRegion = (A: Float32Array, B: Float32Array, mids: readonly Float32Array[], sw: number, sh: number): RegionFit | undefined => {
  const nb = sw * sh;
  const dab = new Float32Array(nb);
  const blockDiff = (P: Float32Array, Q: Float32Array, k: number): number =>
    (Math.abs((P[k * 3] as number) - (Q[k * 3] as number)) + Math.abs((P[k * 3 + 1] as number) - (Q[k * 3 + 1] as number)) + Math.abs((P[k * 3 + 2] as number) - (Q[k * 3 + 2] as number))) / 3;
  const sig: number[] = [];
  for (let k = 0; k < nb; k++) { dab[k] = blockDiff(A, B, k); if ((dab[k] as number) > 10) sig.push(k); }
  if (sig.length < 0.3 * nb || mids.length < 2) return undefined;
  const isNew = mids.map((M) => sig.map((k) => blockDiff(M, B, k) < blockDiff(M, A, k)));
  const pure = mids.map((M) => sig.filter((k) => Math.min(blockDiff(M, A, k), blockDiff(M, B, k)) < 0.35 * (dab[k] as number)).length / sig.length);
  const share = isNew.map((v) => v.filter(Boolean).length / sig.length);
  // judged where the two pictures share the frame; a switch of every block at once (a cut, a dissolve) has no such frame
  const shared = (i: number): boolean => (share[i] as number) > 0.15 && (share[i] as number) < 0.85;
  const central = pure.filter((_, i) => shared(i));
  if (!central.length) return undefined;
  const left = mids.flatMap((M, i) => (shared(i) ? [sig.reduce((n, k) => n + Math.min(blockDiff(M, A, k), blockDiff(M, B, k)) / (dab[k] as number), 0) / sig.length] : []));
  // 0.5: a soft-edged iris leaves a wide band of mixed blocks; half-way through a dissolve no block is pure
  const purity = median(central);
  if (purity < 0.5 || (share[share.length - 1] as number) - (share[0] as number) < 0.3) return undefined;
  let flipsBack = 0;
  for (let j = 0; j < sig.length; j++) for (let i = 1; i < isNew.length; i++) if ((isNew[i - 1] as boolean[])[j] && !(isNew[i] as boolean[])[j]) { flipsBack++; break; }
  if (flipsBack > 0.2 * sig.length) return undefined;
  return { purity, share, residual: median(left), ...regionDirection(isNew, sig, sw, sh) };
};

/** Direction of a region wipe from when each block turns new. */
const regionDirection = (isNew: boolean[][], sig: number[], sw: number, sh: number): { direction?: WipeDirection } => {
  const when = sig.map((_, j) => { const i = isNew.findIndex((v) => v[j] as boolean); return i < 0 ? isNew.length : i; });
  const xs = sig.map((k) => (k % sw) / sw), ys = sig.map((k) => Math.floor(k / sw) / sh);
  const rs = sig.map((k) => Math.hypot((k % sw) / sw - 0.5 + 0.5 / sw, Math.floor(k / sw) / sh - 0.5 + 0.5 / sh));
  const cx = correlation(when, xs), cy = correlation(when, ys), cr = correlation(when, rs);
  const top = Math.max(Math.abs(cx), Math.abs(cy), Math.abs(cr));
  if (top < 0.55) return {};
  if (Math.abs(cr) >= Math.max(Math.abs(cx), Math.abs(cy))) return { direction: cr > 0 ? 'center-out' : 'edges-in' };
  // New blocks first on the left, last on the right: the edge travels right.
  if (Math.abs(cx) >= Math.abs(cy)) return { direction: cx > 0 ? 'right' : 'left' };
  return { direction: cy > 0 ? 'down' : 'up' };
};

/** A picture scaled by s about its centre (bilinear, edges clamped). */
const scaled = (img: Img, s: number): Float32Array => {
  if (s === 1) return img.data;
  const { w, h, data } = img;
  const out = new Float32Array(data.length);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1.001, Math.max(0, cy + (y - cy) / s)), y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, cx + (x - cx) / s)), x0 = Math.floor(sx), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const i = (y0 * w + x0) * 3 + c;
        const top = (data[i] as number) * (1 - fx) + (data[i + 3] as number) * fx, bot = (data[i + w * 3] as number) * (1 - fx) + (data[i + w * 3 + 3] as number) * fx;
        out[(y * w + x) * 3 + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return out;
};

const blendResidual = (X: Float32Array, Y: Float32Array, M: Float32Array): number => {
  let num = 0, den = 0;
  for (let i = 0; i < X.length; i++) { const d = (Y[i] as number) - (X[i] as number); num += ((M[i] as number) - (X[i] as number)) * d; den += d * d; }
  const w = den > 0 ? Math.min(1, Math.max(0, num / den)) : 0;
  let r = 0;
  for (let i = 0; i < X.length; i++) r += Math.abs((M[i] as number) - ((X[i] as number) + w * ((Y[i] as number) - (X[i] as number))));
  return r / X.length;
};

const OLD_SCALES = [1, 1.1, 1.2, 1.35, 1.5];
const NEW_SCALES = [1, 1.1, 1.2, 1.3];

/**
 * Zoom: every frame is a blend of the old picture scaled up and the new one scaled (a crossfade while the pictures
 * grow or shrink). gain: the scaled blend's residual over the plain blend's (well under 1 when scaling explains it).
 * residual: the scaled blend's mean residual relative to |A - B|, as the other models give theirs.
 */
export const fitScaledBlend = (A: Img, B: Img, mids: readonly Img[]): { gain: number; scale: number; residual: number } => {
  const D = absDiff(A.data, B.data) + 1e-6;
  const As = OLD_SCALES.map((s) => scaled(A, s)), Bs = NEW_SCALES.map((s) => scaled(B, s));
  let plain = 0, best = 0, scale = 1;
  for (const M of mids) {
    plain += blendResidual(A.data, B.data, M.data) / D;
    let b = Infinity, bs = 1;
    As.forEach((X, i) => Bs.forEach((Y, j) => { const r = blendResidual(X, Y, M.data) / D; if (r < b - 1e-9) { b = r; bs = Math.max(OLD_SCALES[i] as number, NEW_SCALES[j] as number); } }));
    best += b;
    scale = Math.max(scale, bs);
  }
  return { gain: plain > 0 ? best / plain : 1, scale, residual: mids.length ? best / mids.length : 1 };
};
