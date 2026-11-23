/**
 * Background colour and palette of a shot. Pixels of a few frames are binned at 4 bits per channel; bins are merged
 * greedily, largest first, into clusters whose mean colours are within ΔE 12 (CIE76 in Lab) of each other. Ties are
 * broken by bin index, so the result is deterministic. The background is the cluster that holds most of the
 * frame's border.
 */
import { toHex, round } from './pixels';

export interface ColourResult { background: string; palette: { hex: string; share: number }[] }

/** sRGB (0..255) to CIE Lab (D65). */
export const toLab = (rgb: readonly number[]): [number, number, number] => {
  const lin = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};

export const deltaE = (a: readonly number[], b: readonly number[]): number => Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number));

export const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
};

/** Clusters closer than this (ΔE) are one colour. */
const MERGE = 12;
const MAX_PALETTE = 6;
const MIN_SHARE = 0.02;

interface Cluster { sum: [number, number, number]; count: number; border: number; lab: [number, number, number] }

export const measureColour = (frames: readonly Uint8Array[], w: number, h: number): ColourResult => {
  const count = new Float64Array(4096), border = new Float64Array(4096);
  const sums = new Float64Array(4096 * 3);
  for (const f of frames) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const bin = (((f[i] as number) >> 4) << 8) | (((f[i + 1] as number) >> 4) << 4) | ((f[i + 2] as number) >> 4);
        count[bin] = (count[bin] as number) + 1;
        for (let c = 0; c < 3; c++) sums[bin * 3 + c] = (sums[bin * 3 + c] as number) + (f[i + c] as number);
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) border[bin] = (border[bin] as number) + 1;
      }
    }
  }
  const bins = Array.from({ length: 4096 }, (_, b) => b).filter((b) => (count[b] as number) > 0).sort((a, b) => (count[b] as number) - (count[a] as number) || a - b);
  const clusters: Cluster[] = [];
  for (const b of bins) {
    const n = count[b] as number;
    const mean = [0, 1, 2].map((c) => (sums[b * 3 + c] as number) / n);
    const lab = toLab(mean);
    let best: Cluster | undefined, bestD = Infinity;
    for (const cl of clusters) { const d = deltaE(cl.lab, lab); if (d < bestD) { bestD = d; best = cl; } }
    if (best && (bestD < MERGE || clusters.length >= 32)) {
      best.count += n;
      best.border += border[b] as number;
      for (let c = 0; c < 3; c++) best.sum[c] = (best.sum[c] as number) + (sums[b * 3 + c] as number);
      best.lab = toLab(best.sum.map((v) => v / best.count));
    } else {
      clusters.push({ sum: [sums[b * 3] as number, sums[b * 3 + 1] as number, sums[b * 3 + 2] as number], count: n, border: border[b] as number, lab });
    }
  }
  const total = clusters.reduce((s, c) => s + c.count, 0) || 1;
  const ordered = [...clusters].sort((a, b) => b.count - a.count);
  const bg = [...clusters].sort((a, b) => b.border - a.border || b.count - a.count)[0];
  const hex = (c: Cluster): string => toHex(c.sum.map((v) => v / c.count));
  return {
    background: bg ? hex(bg) : '#000000',
    palette: ordered.filter((c) => c.count / total >= MIN_SHARE).slice(0, MAX_PALETTE).map((c) => ({ hex: hex(c), share: round(c.count / total, 3) })),
  };
};
