/**
 * Bars round the picture: bands along the edges that never change through the whole video, as when a picture of other
 * proportions is letterboxed or pillarboxed (black bars, or a flat ground), with whatever stays drawn on them (a title
 * strip, a logo). A band's rows need not each be flat: a still title in the top bar kept 41% of a 9:16 frame of black
 * and white around a 16:9 window, which then held too little of the box for any of its cuts to show. The band as a whole
 * is mostly one flat level, though: a still picture round an element that pops in is no bar. The cuts are judged inside the box
 * the bands leave: averaged over the whole frame, a change inside a third of it stays under every threshold (a 16:9
 * picture of four shots between the bars of a 9:16 frame: none of the three cuts was found). Found from measure's own
 * thumbnails, before there are shots. No bands, bands of less than MIN_BARS of the frame, or a box of less than
 * MIN_LIVE of it leave the frame whole, and the measure as it was.
 */
import type { Thumbs } from './pixels';

/** Levels a bar's pixel may move through the whole video (compression, dithering). */
const STILL = 12;
/** A row or column is a bar's when this share of its pixels are still: what never changes carries no cut. */
const BAR_LINE = 0.97;
/** Levels a bar's pixel may differ from its band's median, and the share of the band's pixels that must: one flat ground. */
const FLAT = 12;
const BAR_FLAT = 0.75;
/** The bands must cover at least this share of the frame, and leave a box of at least this share. */
const MIN_BARS = 0.1;
const MIN_LIVE = 0.1;
/** Frames looked at, spread evenly over the video. */
const SAMPLES = 120;

export interface LiveBox { x: number; y: number; width: number; height: number }

/** Per pixel, the lowest and highest gray level over the sampled frames. */
const rangeOf = (t: Thumbs): { lo: Uint8Array; hi: Uint8Array } => {
  const n = t.gray.length, k = Math.min(SAMPLES, n), size = t.width * t.height;
  const lo = new Uint8Array(size).fill(255), hi = new Uint8Array(size);
  for (let s = 0; s < k; s++) {
    const g = t.gray[Math.floor((s * (n - 1)) / Math.max(1, k - 1))] as Uint8Array;
    for (let p = 0; p < size; p++) {
      const v = g[p] as number;
      if (v < (lo[p] as number)) lo[p] = v;
      if (v > (hi[p] as number)) hi[p] = v;
    }
  }
  return { lo, hi };
};

/** The box of the picture inside the bars, in thumbnail pixels; undefined when the frame is to be judged whole. */
export const liveBox = (t: Thumbs): LiveBox | undefined => {
  const { width: w, height: h } = t;
  if (t.gray.length < 2 || w < 4 || h < 4) return undefined;
  const { lo, hi } = rangeOf(t);
  const isBar = (pixels: number[]): boolean => pixels.filter((p) => (hi[p] as number) - (lo[p] as number) <= STILL).length >= BAR_LINE * pixels.length;
  const row = (y: number): number[] => Array.from({ length: w }, (_, x) => y * w + x);
  const column = (x: number, y0: number, y1: number): number[] => Array.from({ length: y1 - y0 }, (_, i) => (y0 + i) * w + x);
  const flat = (n: number, line: (i: number) => number[]): number => {
    const mid = Array.from({ length: n }, (_, i) => line(i)).flat().map((p) => ((lo[p] as number) + (hi[p] as number)) / 2);
    const median = [...mid].sort((a, b) => a - b)[mid.length >> 1] as number;
    return n && mid.filter((v) => Math.abs(v - median) <= FLAT).length >= BAR_FLAT * mid.length ? n : 0;
  };
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < h && isBar(row(top))) top++;
  top = flat(top, row);
  while (bottom < h - top && isBar(row(h - 1 - bottom))) bottom++;
  bottom = flat(bottom, (i) => row(h - 1 - i));
  while (left < w && isBar(column(left, top, h - bottom))) left++;
  left = flat(left, (i) => column(i, top, h - bottom));
  while (right < w - left && isBar(column(w - 1 - right, top, h - bottom))) right++;
  right = flat(right, (i) => column(w - 1 - i, top, h - bottom));
  const box = { x: left, y: top, width: w - left - right, height: h - top - bottom };
  const live = (box.width * box.height) / (w * h);
  return box.width >= 4 && box.height >= 4 && live >= MIN_LIVE && live <= 1 - MIN_BARS ? box : undefined;
};

/** The thumbnails cut to a box. */
export const cropThumbs = (t: Thumbs, b: LiveBox): Thumbs => {
  const crop = (src: Uint8Array, ch: number): Uint8Array => {
    const out = new Uint8Array(b.width * b.height * ch);
    for (let y = 0; y < b.height; y++) {
      const from = ((b.y + y) * t.width + b.x) * ch;
      out.set(src.subarray(from, from + b.width * ch), y * b.width * ch);
    }
    return out;
  };
  return { width: b.width, height: b.height, fps: t.fps, rgb: t.rgb.map((f) => crop(f, 3)), gray: t.gray.map((g) => crop(g, 1)) };
};
