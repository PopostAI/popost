/**
 * The picture dimensions: rhythm (change curves), colour (background and palette per shot) and picture (signature
 * thumbnails at the same times, on gray levels and on gradients).
 */
import type { DimensionScore, Measure } from '../types';
import { correlation, meanOf, stdOf } from '../measure/pixels';
import { deltaE, hexToRgb, toLab } from '../measure/colour';
import { signatureFrames } from '../measure/signature';
import { SCALES } from './weights';
import { fpsOf, pairShots } from './pair';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Common step of the resampled change curves, seconds. */
const RHYTHM_STEP = 0.1;

/** The change curve at times 0, RHYTHM_STEP, ... (linear between samples; sample k sits at (k + 0.5) x step / fps). */
const resampleCurve = (m: Measure, until: number): number[] => {
  const dt = m.rhythm.step / fpsOf(m), c = m.rhythm.change;
  const out: number[] = [];
  for (let t = 0; t <= until + 1e-9; t += RHYTHM_STEP) {
    const x = t / dt - 0.5, i = Math.floor(x);
    const a = c[Math.max(0, Math.min(c.length - 1, i))] ?? 0, b = c[Math.max(0, Math.min(c.length - 1, i + 1))] ?? 0;
    out.push(a + (b - a) * Math.min(1, Math.max(0, x - i)));
  }
  // a [1 2 1] / 4 smoothing, so a cut one frame early is close rather than a total miss
  return out.map((v, i) => ((out[i - 1] ?? v) + 2 * v + (out[i + 1] ?? v)) / 4);
};

export const rhythm = (ref: Measure, other: Measure): DimensionScore => {
  // A measurement without a change curve (the truth of a synthetic case) has no rhythm to compare.
  if (!ref.rhythm.change.length || !other.rhythm.change.length) return { score: 0, n: 0, detail: {} };
  const until = Math.min(ref.source.duration, other.source.duration);
  const a = resampleCurve(ref, until), b = resampleCurve(other, until);
  const n = Math.min(a.length, b.length);
  if (n < 3) return { score: 0, n: 0, detail: {} };
  const flatA = stdOf(a) < 0.005, flatB = stdOf(b) < 0.005;
  const r = flatA && flatB ? 1 - Math.min(1, 10 * Math.abs(meanOf(a) - meanOf(b))) : flatA || flatB ? 0 : correlation(a, b);
  return { score: r3(Math.max(0, r)), n, detail: { correlation: r3(r), seconds: r3(until), meanChangeRef: r3(meanOf(a)), meanChangeOther: r3(meanOf(b)) } };
};

const labOf = (hex: string): [number, number, number] => toLab(hexToRgb(hex));

export const paletteDistance = (a: Measure['shots'][number]['palette'], b: Measure['shots'][number]['palette']): number => {
  if (!a.length || !b.length) return a.length === b.length ? 0 : 100;
  const one = (x: typeof a, y: typeof b): number => {
    const w = x.reduce((s, c) => s + c.share, 0) || 1;
    return x.reduce((s, c) => s + c.share * Math.min(...y.map((d) => deltaE(labOf(c.hex), labOf(d.hex)))), 0) / w;
  };
  return (one(a, b) + one(b, a)) / 2;
};

export const colour = (ref: Measure, other: Measure): DimensionScore => {
  const per = pairShots(ref, other).flatMap((p) => {
    const a = ref.shots[p.r], b = other.shots[p.o];
    if (!a || !b || !a.background || !b.background) return [];
    const bg = deltaE(labOf(a.background), labOf(b.background)), pal = paletteDistance(a.palette, b.palette);
    return [{ bg, pal, score: 0.4 * Math.exp(-bg / SCALES.colour) + 0.6 * Math.exp(-pal / SCALES.colour) }];
  });
  return { score: r3(mean(per.map((x) => x.score))), n: per.length, detail: { backgroundDeltaE: r3(mean(per.map((x) => x.bg))), paletteDeltaE: r3(mean(per.map((x) => x.pal))) } };
};

const gradient = (p: Uint8Array, w: number, h: number): number[] => {
  const out: number[] = [];
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    out.push(Math.abs((p[i + 1] as number) - (p[i] as number)) + Math.abs((p[i + w] as number) - (p[i] as number)));
  }
  return out;
};

/** Similarity of two thumbnails: layout (correlation of levels) and edges (correlation of gradient magnitudes). */
export const thumbSimilarity = (a: Uint8Array, b: Uint8Array, w: number, h: number): { px: number; grad: number } => {
  const la = Array.from(a), lb = Array.from(b);
  const flat = stdOf(la) < 2 && stdOf(lb) < 2;
  const px = flat ? 1 - Math.abs(meanOf(la) - meanOf(lb)) / 255 : Math.max(0, correlation(la, lb));
  const ga = gradient(a, w, h), gb = gradient(b, w, h);
  const grad = stdOf(ga) < 1 && stdOf(gb) < 1 ? px : Math.max(0, correlation(ga, gb));
  return { px, grad };
};

export const picture = (ref: Measure, other: Measure): DimensionScore => {
  const fa = signatureFrames(ref.signature), fb = signatureFrames(other.signature);
  const ra = fpsOf(ref), rb = fpsOf(other);
  const w = ref.signature.width, h = ref.signature.height;
  if (w !== other.signature.width || h !== other.signature.height) return { score: 0, n: 0, detail: { note: 'signature sizes differ' } };
  const per = fa.flatMap((a, k) => {
    const t = (k * ref.signature.every) / ra;
    const j = Math.round((t * rb) / other.signature.every);
    const b = fb[j];
    return b && j < other.signature.count ? [thumbSimilarity(a, b, w, h)] : [];
  });
  const px = mean(per.map((x) => x.px)), grad = mean(per.map((x) => x.grad));
  return { score: r3(0.5 * px + 0.5 * grad), n: per.length, detail: { levels: r3(px), edges: r3(grad) } };
};
