/**
 * Per-frame signals of a video's thumbnails, computed once and shared by the boundary detector, the rhythm and the
 * scorer's inputs. Index i compares frame i with frame i - 1 (index 0 holds 0).
 */
import type { Thumbs } from './pixels';
import { detailOf, flatnessOf, meanAbs, meanColour, meanOf, resample, stdOf } from './pixels';

/** Side of the square blocks averaged into the "small" picture used for distances (pixels of the thumbnail). */
export const BLOCK = 4;
/** A pixel counts as changed when one of its channels moves by more than this many levels (or 0.3 of the frame's
 *  standard deviation, if that is more), so compression noise and dithering do not count. */
const PIXEL_CHANGE = 10;

export interface Signals {
  n: number;
  fps: number;
  /** Block means (rgb, BLOCK x BLOCK pixels each) of every frame: the picture with noise and tiny motion averaged out. */
  small: Float32Array[];
  sw: number;
  sh: number;
  /** Hellinger distance (0..1) of the colour histograms of frame i and frame i - 1. */
  hist: Float32Array;
  /** Mean absolute gray difference to the previous frame, levels. */
  pix: Float32Array;
  /** Share of pixels that changed noticeably since the previous frame. */
  chg: Float32Array;
  /** Share of the 6 x 8 grid's cells in which more than half of the pixels changed. */
  blk: Float32Array;
  /** Share of the 6 x 8 grid's cells in which at least 2% of the pixels changed: how widely a change is spread. */
  spread: Float32Array;
  /** The changed pixels' bounding box, its smaller side as a share of the frame's (0 when nothing changed). */
  extent: Float32Array;
  /** Cut score: 0.6 x hist + 0.4 x min(1, 4 x pix / 255). */
  score: Float32Array;
  luma: Float32Array;
  /** Lowest and highest of the three channel means: near white has a high low, near black a low high. */
  lowCh: Float32Array;
  highCh: Float32Array;
  /** Standard deviation of the gray picture. */
  gstd: Float32Array;
  /** Largest per-channel standard deviation: near 0 for a flat colour. */
  flat: Float32Array;
  /** Mean absolute gradient across (x) and down (y): sharpness. */
  dx: Float32Array;
  dy: Float32Array;
}

/** Soft 4 x 4 x 4 rgb histogram of every second pixel (each value shares its weight between the two nearest bins). */
const histogram = (rgb: Uint8Array, w: number, h: number): Float32Array => {
  const out = new Float32Array(64);
  let total = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const k = (y * w + x) * 3;
      const u = [0, 1, 2].map((c) => ((rgb[k + c] as number) * 3) / 255);
      const lo = u.map((v) => Math.min(2, Math.floor(v)));
      const fr = u.map((v, c) => v - (lo[c] as number));
      for (let m = 0; m < 8; m++) {
        let wgt = 1, bin = 0;
        for (let c = 0; c < 3; c++) {
          const up = (m >> c) & 1;
          wgt *= up ? (fr[c] as number) : 1 - (fr[c] as number);
          bin = bin * 4 + (lo[c] as number) + up;
        }
        out[bin] = (out[bin] as number) + wgt;
      }
      total++;
    }
  }
  for (let i = 0; i < 64; i++) out[i] = (out[i] as number) / Math.max(1, total);
  return out;
};

const hellinger = (p: Float32Array, q: Float32Array): number => {
  let bc = 0;
  for (let i = 0; i < p.length; i++) bc += Math.sqrt((p[i] as number) * (q[i] as number));
  return Math.sqrt(Math.max(0, 1 - bc));
};

/**
 * Between two rgb frames: share of changed pixels, share of 6 x 8 grid cells that are mostly changed, share of cells
 * touched by the change (2% of their pixels) and the smaller side of the changed pixels' bounding box.
 */
const changed = (a: Uint8Array, b: Uint8Array, w: number, h: number, thr: number): [number, number, number, number] => {
  const gw = 6, gh = 8;
  const cellHit = new Uint32Array(gw * gh), cellAll = new Uint32Array(gw * gh);
  let hits = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      const d = Math.max(Math.abs((a[k] as number) - (b[k] as number)), Math.abs((a[k + 1] as number) - (b[k + 1] as number)), Math.abs((a[k + 2] as number) - (b[k + 2] as number)));
      const cell = cy * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
      cellAll[cell] = (cellAll[cell] as number) + 1;
      if (d > thr) {
        hits++;
        cellHit[cell] = (cellHit[cell] as number) + 1;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  let cells = 0, touched = 0;
  for (let c = 0; c < gw * gh; c++) {
    if ((cellHit[c] as number) > 0.5 * (cellAll[c] as number)) cells++;
    if ((cellHit[c] as number) >= 0.02 * (cellAll[c] as number) && (cellHit[c] as number) > 0) touched++;
  }
  const extent = x1 < 0 ? 0 : Math.min((x1 - x0 + 1) / w, (y1 - y0 + 1) / h);
  return [hits / (w * h), cells / (gw * gh), touched / (gw * gh), extent];
};

export const computeSignals = (t: Thumbs): Signals => {
  const n = t.rgb.length;
  const { width: w, height: h } = t;
  const sw = Math.max(1, Math.round(w / BLOCK)), sh = Math.max(1, Math.round(h / BLOCK));
  const small = t.rgb.map((f) => resample(f, w, h, 3, sw, sh));
  const hists = t.rgb.map((f) => histogram(f, w, h));
  const s: Signals = {
    n, fps: t.fps, small, sw, sh,
    hist: new Float32Array(n), pix: new Float32Array(n), chg: new Float32Array(n), blk: new Float32Array(n), spread: new Float32Array(n), extent: new Float32Array(n), score: new Float32Array(n),
    luma: new Float32Array(n), lowCh: new Float32Array(n), highCh: new Float32Array(n), gstd: new Float32Array(n), flat: new Float32Array(n), dx: new Float32Array(n), dy: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const g = t.gray[i] as Uint8Array;
    s.luma[i] = meanOf(g);
    s.gstd[i] = stdOf(g);
    s.flat[i] = flatnessOf(t.rgb[i] as Uint8Array);
    const mc = meanColour(t.rgb[i] as Uint8Array);
    s.lowCh[i] = Math.min(...mc);
    s.highCh[i] = Math.max(...mc);
    const [dx, dy] = detailOf(g, w, h);
    s.dx[i] = dx;
    s.dy[i] = dy;
    if (i === 0) continue;
    s.hist[i] = hellinger(hists[i - 1] as Float32Array, hists[i] as Float32Array);
    s.pix[i] = meanAbs(t.gray[i - 1] as Uint8Array, g);
    const thr = Math.max(PIXEL_CHANGE, 0.3 * Math.min(s.gstd[i] as number, s.gstd[i - 1] as number));
    const [c, b, spread, extent] = changed(t.rgb[i - 1] as Uint8Array, t.rgb[i] as Uint8Array, w, h, thr);
    s.chg[i] = c;
    s.blk[i] = b;
    s.spread[i] = spread;
    s.extent[i] = extent;
    s.score[i] = 0.6 * (s.hist[i] as number) + 0.4 * Math.min(1, (4 * (s.pix[i] as number)) / 255);
  }
  return s;
};

/** Distance of two frames' small pictures, in levels (mean over blocks and channels). */
export const dist = (s: Signals, i: number, j: number): number => meanAbs(s.small[i] as Float32Array, s.small[j] as Float32Array);

/** Detail (sum of the gradients) of frame i. */
export const detail = (s: Signals, i: number): number => (s.dx[i] as number) + (s.dy[i] as number);

/** Flat black or white (each channel's mean under 40, or over 215): the colour a fade passes through. A flat cream or
 *  navy card is a shot, not a fade. */
export const viaOf = (s: Signals, m: number): 'black' | 'white' | undefined => {
  if ((s.flat[m] as number) >= 6) return undefined;
  if ((s.highCh[m] as number) < 40) return 'black';
  if ((s.lowCh[m] as number) > 215) return 'white';
  return undefined;
};
