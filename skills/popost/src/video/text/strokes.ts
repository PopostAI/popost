/**
 * The raw material of the caption letters (letters.ts, core.ts, highlight.ts): the colours that recur inside the lines'
 * boxes, matched from line to line, and the pixels of a colour that lie on thin strokes.
 */
import { deltaE } from '../measure/colour';
import { labMedian, rgbMedian, type Frame, type Lab, type Rect, type Rgb } from './frame';

/** ΔE within which a pixel is of a colour. */
export const NEAR = 16;
/** ΔE within which two clusters, or one cluster on two lines, are one colour. */
export const SAME = 14;

interface Cluster { lab: Lab; rgb: Rgb; share: number }
/** A colour that recurs from line to line: where it was found (its colour on each line, undefined elsewhere). */
export interface Group { lab: Lab; rgb: Rgb; at: (Lab | undefined)[]; lines: number }

/** Bins of the coarse Lab histogram: lightness in steps of 6, a and b in steps of 8. */
const BINS = 18 * 64 * 64;

/** The main colours of some pixels: the peaks of a coarse Lab histogram, merged within SAME, with their shares. */
export const coloursOf = (f: Frame, idx: number[]): Cluster[] => {
  // Count, then the sums of L, a, b, R, G, B, per bin.
  const sums = new Float64Array(BINS * 7);
  for (const i of idx) {
    const L = f.lab[3 * i] ?? 0, a = f.lab[3 * i + 1] ?? 0, b = f.lab[3 * i + 2] ?? 0;
    const key = (Math.min(17, Math.max(0, Math.floor(L / 6))) * 64 + Math.min(63, Math.max(0, Math.floor((a + 128) / 8)))) * 64 + Math.min(63, Math.max(0, Math.floor((b + 128) / 8)));
    const o = key * 7;
    sums[o] = (sums[o] ?? 0) + 1;
    sums[o + 1] = (sums[o + 1] ?? 0) + L; sums[o + 2] = (sums[o + 2] ?? 0) + a; sums[o + 3] = (sums[o + 3] ?? 0) + b;
    sums[o + 4] = (sums[o + 4] ?? 0) + (f.rgb[3 * i] ?? 0); sums[o + 5] = (sums[o + 5] ?? 0) + (f.rgb[3 * i + 1] ?? 0); sums[o + 6] = (sums[o + 6] ?? 0) + (f.rgb[3 * i + 2] ?? 0);
  }
  const bins: number[][] = [];
  for (let k = 0; k < BINS; k++) if (sums[k * 7]) bins.push(Array.from(sums.subarray(k * 7, k * 7 + 7)));
  const mean = (s: number[], from: number): Lab => [(s[from] ?? 0) / (s[0] || 1), (s[from + 1] ?? 0) / (s[0] || 1), (s[from + 2] ?? 0) / (s[0] || 1)];
  const clusters: number[][] = [];
  // The fullest bins first; ties keep the bins' order, so the result does not depend on anything else.
  for (const bin of bins.map((b, k) => ({ b, k })).sort((x, y) => (y.b[0] ?? 0) - (x.b[0] ?? 0) || x.k - y.k).map((x) => x.b)) {
    const lab = mean(bin, 1);
    const near = clusters.map((c, j) => ({ j, d: deltaE(mean(c, 1), lab) })).filter((x) => x.d <= SAME).sort((x, y) => x.d - y.d)[0];
    if (near) clusters[near.j] = (clusters[near.j] ?? []).map((v, j) => v + (bin[j] ?? 0));
    else clusters.push(bin);
  }
  return clusters.filter((c) => (c[0] ?? 0) >= 0.02 * idx.length).map((c) => ({ lab: mean(c, 1), rgb: mean(c, 4), share: (c[0] ?? 0) / idx.length }));
};

/** The colours of each line's box, matched from line to line, the most common over all lines first. */
export const groupsOf = (per: Cluster[][]): Group[] => {
  const groups: { first: Lab; at: (Cluster | undefined)[] }[] = [];
  const all = per.flatMap((cs, k) => cs.map((c) => ({ c, k }))).sort((a, b) => b.c.share - a.c.share);
  for (const { c, k } of all) {
    const near = groups.map((g) => ({ g, d: deltaE(g.first, c.lab) })).filter((x) => x.d <= SAME).sort((a, b) => a.d - b.d);
    // A second cluster of one colour on a line is part of the first.
    if (near.some((x) => x.g.at[k])) continue;
    const g = near[0]?.g;
    if (g) g.at[k] = c;
    else groups.push({ first: c.lab, at: per.map((_c, j) => (j === k ? c : undefined)) });
  }
  const total = (g: { at: (Cluster | undefined)[] }): number => g.at.reduce((s, c) => s + (c?.share ?? 0), 0);
  return [...groups].sort((a, b) => total(b) - total(a)).map((g) => {
    const seen = g.at.flatMap((c) => (c ? [c] : []));
    return { lab: labMedian(seen.map((c) => c.lab)), rgb: rgbMedian(seen.map((c) => c.rgb)), at: g.at.map((c) => c?.lab), lines: seen.length };
  });
};

/** For each set cell, the length of the run of set cells it lies on: `lines` lines of `len` cells, cells `step` apart, lines `next` apart. */
const runLengths = (m: Uint8Array, len: number, lines: number, step: number, next: number): Uint16Array => {
  const out = new Uint16Array(m.length);
  for (let l = 0; l < lines; l++) {
    for (let s = 0; s < len;) {
      if (!m[l * next + s * step]) { s++; continue; }
      let e = s;
      while (e < len && m[l * next + e * step]) e++;
      for (let j = s; j < e; j++) out[l * next + j * step] = e - s;
      s = e;
    }
  }
  return out;
};

/**
 * The pixels of a box near a colour that lie on thin strokes: on runs of that colour at most `max` long, across or
 * down. Runs are followed past the box, so the picture above and below the letters, which goes on outside the box,
 * is not taken for strokes.
 */
export const strokesOf = (f: Frame, box: Rect, lab: Lab, max: number): number[] => {
  // Half a box height past the box is enough: a run that reaches that far is longer than any stroke (strokeMax).
  const pad = Math.round(0.5 * (box.y1 - box.y0));
  const x0 = Math.max(0, Math.round(box.x0) - pad), x1 = Math.min(f.w, Math.round(box.x1) + pad);
  const y0 = Math.max(0, Math.round(box.y0) - pad), y1 = Math.min(f.h, Math.round(box.y1) + pad);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const near = new Uint8Array(w * h), L = f.lab, near2 = NEAR * NEAR;
  // ΔE within NEAR, written out: this runs over every pixel around every line for every candidate.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 3 * ((y + y0) * f.w + x + x0);
      const dl = (L[i] ?? 0) - lab[0], da = (L[i + 1] ?? 0) - lab[1], db = (L[i + 2] ?? 0) - lab[2];
      near[y * w + x] = dl * dl + da * da + db * db <= near2 ? 1 : 0;
    }
  }
  const across = runLengths(near, w, h, 1, w), down = runLengths(near, h, w, w, 1);
  const out: number[] = [];
  for (let y = Math.max(y0, Math.round(box.y0)); y < Math.min(y1, Math.round(box.y1)); y++)
    for (let x = Math.max(x0, Math.round(box.x0)); x < Math.min(x1, Math.round(box.x1)); x++) {
      const j = (y - y0) * w + x - x0;
      if (near[j] && Math.min(across[j] ?? 0, down[j] ?? 0) <= max) out.push(y * f.w + x);
    }
  return out;
};

/** The longest run of one colour, across or down, that is still a stroke of a letter: about a third of the line's box. */
export const strokeMax = (box: Rect): number => Math.max(3, Math.round(0.35 * (box.y1 - box.y0)));
