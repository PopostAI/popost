/**
 * A transition between a picture and a flat colour that mixes the two (a dissolve, or a zoom whose flat side shows no
 * scale) can be undone: with the mix weight of each frame known, the flat colour is taken out and what remains is the
 * picture as the frame shows it. Its scale against the picture's clean end tells a zoom from a dissolve, which the
 * scaled-blend fit cannot when only one side scales and that side fades.
 */
import type { Thumbs } from './pixels';
import { warpDiffs } from './robust';

/** A side is a flat colour (items on it allowed) when this share of its pixels is within FLAT_LEVELS of one level, and
 *  the picture side when at most PICTURE_SHARE are (a low-contrast picture can have two thirds within a few levels). */
const FLAT_SHARE = 0.8;
const PICTURE_SHARE = 0.7;
const FLAT_LEVELS = 6;
/** The picture's share of a frame must be at least this for the unmixed picture to be trusted. */
const MIN_SHARE = 0.3;
/** A zoom transition scales its picture by 1.25 to 1.5 at the ends of the mix; a camera push-in over half a second by
 *  under 1.05. Between them: a scale of 1.08. */
const MIN_ZOOM = 1.08;
const SCALES = [1, 1.04, 1.08, 1.12, 1.16, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5, 1.6];

/** The level most pixels of a gray picture sit near, and the share of pixels near it. */
const flatLevel = (g: Uint8Array): { level: number; share: number } => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i] as number] = (hist[g[i] as number] as number) + 1;
  let best = 0, at = 0;
  for (let v = 0; v < 256; v++) {
    let s = 0;
    for (let k = Math.max(0, v - FLAT_LEVELS); k <= Math.min(255, v + FLAT_LEVELS); k++) s += hist[k] as number;
    if (s > best) { best = s; at = v; }
  }
  return { level: at, share: best / g.length };
};

/** Mix weight of the new picture in frame m: least squares of m - a against b - a. */
const weightOf = (a: Uint8Array, b: Uint8Array, m: Uint8Array): number => {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { const d = (b[i] as number) - (a[i] as number); num += ((m[i] as number) - (a[i] as number)) * d; den += d * d; }
  return den > 1e-6 ? num / den : 0;
};

/**
 * Per frame of a picture-to-flat (or flat-to-picture) span: the scale about the centre (1 to 1.6) that best explains
 * the unmixed picture against its clean end, and its trimmed difference over that of scale 1. Empty when neither end
 * or both ends are flat.
 */
export const flatSideScales = (t: Thumbs, start: number, end: number, frames: readonly number[]): Array<{ frame: number; scale: number; ratio: number }> => {
  const a = t.gray[start] as Uint8Array, b = t.gray[end] as Uint8Array;
  const fa = flatLevel(a), fb = flatLevel(b);
  const flatA = fa.share >= FLAT_SHARE && fb.share <= PICTURE_SHARE, flatB = fb.share >= FLAT_SHARE && fa.share <= PICTURE_SHARE;
  if (flatA === flatB) return [];
  const pic = flatA ? b : a, flat = flatA ? fa.level : fb.level;
  const out: Array<{ frame: number; scale: number; ratio: number }> = [];
  for (const m of frames) {
    const g = t.gray[m] as Uint8Array;
    const share = flatA ? weightOf(a, b, g) : 1 - weightOf(a, b, g);
    if (share < MIN_SHARE || share > 1.05) continue;
    const unmixed = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) unmixed[i] = ((g[i] as number) - (1 - share) * flat) / share;
    const plain = warpDiffs(pic, unmixed, t.width, t.height, 0, 1)[1];
    let s = 1, e = plain;
    for (const k of SCALES) { const d = warpDiffs(pic, unmixed, t.width, t.height, 0, k)[1]; if (d < e) { e = d; s = k; } }
    if (plain > 1) out.push({ frame: m, scale: s, ratio: e / plain });
  }
  return out;
};

/** A zoom: one frame clearly scaled (ratio under 0.7), or two scaled frames that agree less clearly (under 0.9). Mixes
 *  of a picture and a flat colour that do not scale keep scale 1 on every frame. */
export const isFlatSideZoom = (t: Thumbs, start: number, end: number, frames: readonly number[]): boolean => {
  const scaled = flatSideScales(t, start, end, frames).filter((x) => x.scale >= MIN_ZOOM);
  return scaled.some((x) => x.ratio < 0.7) || scaled.filter((x) => x.ratio < 0.9).length >= 2;
};
