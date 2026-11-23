/**
 * Small pixel helpers shared by every measurement. Frames are thumbnails: Uint8Array rows of rgb24 or gray8 bytes.
 * Distances are in 8-bit levels (0..255) unless a name says otherwise.
 */
import type { Decoded } from '../media/decode';

/** Thumbnails of the frames of a video: rgb24 and the matching gray8, all of one size. */
export interface Thumbs {
  width: number;
  height: number;
  /** Rate of these frames (the source rate when every frame was decoded). */
  fps: number;
  rgb: readonly Uint8Array[];
  gray: readonly Uint8Array[];
}

/** BT.601 luma in integer arithmetic, so the same bytes always give the same gray. */
export const grayOf = (rgb: Uint8Array): Uint8Array => {
  const n = rgb.length / 3;
  const g = new Uint8Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 3) g[i] = (77 * (rgb[k] as number) + 150 * (rgb[k + 1] as number) + 29 * (rgb[k + 2] as number) + 128) >> 8;
  return g;
};

export const thumbsOf = (d: Decoded): Thumbs => ({ width: d.width, height: d.height, fps: d.fps, rgb: d.frames, gray: d.frames.map(grayOf) });

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const meanOf = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] as number;
  return a.length ? s / a.length : 0;
};

export const stdOf = (a: ArrayLike<number>): number => {
  const m = meanOf(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += ((a[i] as number) - m) ** 2;
  return a.length ? Math.sqrt(s / a.length) : 0;
};

/** Mean absolute difference of two equally long arrays. */
export const meanAbs = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return a.length ? s / a.length : 0;
};

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

/** Linear-interpolated quantile (q in 0..1) of a list; 0 for an empty list. */
export const quantile = (xs: readonly number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
};

/** Pearson correlation; 0 when either side does not vary. */
export const correlation = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = meanOf(a.slice(0, n));
  const mb = meanOf(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma, y = (b[i] as number) - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
};

/**
 * Area-average of a w x h image with ch interleaved channels onto a gw x gh grid (each output value is the mean of
 * the input pixels whose centres fall in its cell). Works for any sizes, so it is used both to shrink a frame by 2
 * and to make 16 x 16 signatures.
 */
export const resample = (src: ArrayLike<number>, w: number, h: number, ch: number, gw: number, gh: number): Float32Array => {
  const sum = new Float64Array(gw * gh * ch);
  const cnt = new Uint32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gh - 1, Math.floor(((y + 0.5) * gh) / h));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(gw - 1, Math.floor(((x + 0.5) * gw) / w));
      const cell = cy * gw + cx;
      cnt[cell] = (cnt[cell] as number) + 1;
      for (let c = 0; c < ch; c++) sum[cell * ch + c] = (sum[cell * ch + c] as number) + (src[(y * w + x) * ch + c] as number);
    }
  }
  const out = new Float32Array(gw * gh * ch);
  for (let i = 0; i < gw * gh; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = (sum[i * ch + c] as number) / Math.max(1, cnt[i] as number);
  return out;
};

/** Mean absolute horizontal and vertical gradient of a gray image: how much fine detail it has. */
export const detailOf = (g: ArrayLike<number>, w: number, h: number): [number, number] => {
  let sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) sx += Math.abs((g[i + 1] as number) - (g[i] as number));
      if (y + 1 < h) sy += Math.abs((g[i + w] as number) - (g[i] as number));
    }
  }
  return [sx / Math.max(1, (w - 1) * h), sy / Math.max(1, w * (h - 1))];
};

/** Largest per-channel standard deviation of an rgb image: 0 for a flat colour whatever its brightness. */
export const flatnessOf = (rgb: ArrayLike<number>): number => {
  const n = rgb.length / 3;
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    let s = 0, s2 = 0;
    for (let i = c; i < rgb.length; i += 3) { const v = rgb[i] as number; s += v; s2 += v * v; }
    const m = s / n;
    worst = Math.max(worst, Math.sqrt(Math.max(0, s2 / n - m * m)));
  }
  return worst;
};

/** Mean colour of an rgb image. */
export const meanColour = (rgb: ArrayLike<number>): [number, number, number] => {
  const n = rgb.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < rgb.length; i += 3) { r += rgb[i] as number; g += rgb[i + 1] as number; b += rgb[i + 2] as number; }
  return [r / n, g / n, b / n];
};

export const toHex = (c: readonly number[]): string =>
  '#' + [0, 1, 2].map((k) => clamp(Math.round(c[k] ?? 0), 0, 255).toString(16).padStart(2, '0')).join('');

export const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
