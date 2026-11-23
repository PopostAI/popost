/**
 * The pixels the caption look is measured on (look.ts, letters.ts): a frame cropped to the caption band, as sRGB and
 * as Lab, and the small things both readers do with it: rectangles, rings around a box, medians, how alike colours are.
 */
import { deltaE } from '../measure/colour';
import { toHex } from '../measure/pixels';

export type Rgb = [number, number, number];
export type Lab = [number, number, number];
export type Channel = 0 | 1 | 2;
export const CHANNELS: readonly Channel[] = [0, 1, 2];
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Frame { w: number; h: number; rgb: Uint8Array; lab: Float32Array }
/** A colour seen in a frame: its Lab for distances, its sRGB to report. */
export interface Seen { lab: Lab; rgb: Rgb }

export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
export const r2 = (v: number): number => Math.round(v * 100) / 100;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const labOf = (f: Frame, i: number): Lab => [f.lab[3 * i] ?? 0, f.lab[3 * i + 1] ?? 0, f.lab[3 * i + 2] ?? 0];
export const rgbOf = (f: Frame, i: number): Rgb => [f.rgb[3 * i] ?? 0, f.rgb[3 * i + 1] ?? 0, f.rgb[3 * i + 2] ?? 0];
export const seenAt = (f: Frame, i: number): Seen => ({ lab: labOf(f, i), rgb: rgbOf(f, i) });
export const inside = (f: Frame, x: number, y: number): boolean => x >= 0 && y >= 0 && x < f.w && y < f.h;
export const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/** Pixel indexes in outer and not in inner, inside the frame. */
export const ring = (f: Frame, inner: Rect, outer: Rect): number[] => {
  const out: number[] = [];
  for (let y = Math.max(0, Math.round(outer.y0)); y < Math.min(f.h, Math.round(outer.y1)); y++)
    for (let x = Math.max(0, Math.round(outer.x0)); x < Math.min(f.w, Math.round(outer.x1)); x++)
      if (x < inner.x0 || x >= inner.x1 || y < inner.y0 || y >= inner.y1) out.push(y * f.w + x);
  return out;
};
export const area = (f: Frame, r: Rect): number[] => ring(f, { x0: 0, y0: 0, x1: 0, y1: 0 }, r);

/** The per-channel median colour of some pixels. */
export const medianRgb = (f: Frame, idx: number[]): Rgb => CHANNELS.map((c) => median(idx.map((i) => f.rgb[3 * i + c] ?? 0))) as Rgb;
export const spreadOf = (f: Frame, idx: number[], lab: Lab): number => median(idx.map((i) => deltaE(labOf(f, i), lab)));
export const labMedian = (xs: Lab[]): Lab => CHANNELS.map((c) => median(xs.map((x) => x[c]))) as Lab;
export const rgbMedian = (xs: Rgb[]): Rgb => CHANNELS.map((c) => median(xs.map((x) => x[c]))) as Rgb;

/** Share of the colours within ΔE 15 of their median: 1 when they are one colour. Fewer than `least` is 0: too few to tell. */
export const consistency = (xs: Seen[], least = 20): number => {
  if (xs.length < least) return 0;
  const m = labMedian(xs.map((x) => x.lab));
  return xs.filter((x) => deltaE(x.lab, m) <= 15).length / xs.length;
};
/** The colour of the seen colours near their median, in sRGB. */
export const colourOf = (xs: Seen[]): string => {
  const m = labMedian(xs.map((x) => x.lab));
  const near = xs.filter((x) => deltaE(x.lab, m) <= 15);
  return toHex(rgbMedian((near.length ? near : xs).map((x) => x.rgb)));
};
