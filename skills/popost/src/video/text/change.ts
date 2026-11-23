/**
 * Whether the picture changed between two frames, from small grey pictures of them: a cell of the small picture is the
 * mean grey of its block of the frame, and two pictures differ where cells are off by CHANGE_LEVEL levels or more. The
 * mean colour of a frame hardly moves when a dark screen recording scrolls or opens another panel; what it shows does.
 *
 * Measured on renders, references and synthetic screen recordings (cells off by 10 levels, small pictures 64 wide, looks
 * about a second apart): the same picture encoded again differs in under half a percent of the cells; a caption or a
 * word coming in, in up to about 3%; a cut, a scroll or another panel, in more (a quarter or more on screen recordings).
 */
import { grayOf } from '../measure/pixels';

/** A small grey picture: w x h cells, row by row; NaN where a cell is left out. */
export interface Small {
  w: number;
  h: number;
  grey: Float32Array;
}

export const SMALL_WIDTH = 64;
export const CHANGE_LEVEL = 10;

/**
 * The small grey picture of an rgb24 frame of w x h, at most `width` cells wide; cells whose centre falls in `skip`
 * (from and to, fractions of the height) are left out, so that a band that changes on its own (a bar's mark) or stays
 * (a band laid over the picture) does not count.
 */
export const smallOf = (rgb: Uint8Array, w: number, h: number, o: { width?: number; skip?: readonly [number, number] } = {}): Small => {
  const sw = Math.max(1, Math.min(w, o.width ?? SMALL_WIDTH)), sh = Math.max(1, Math.round((sw * h) / w));
  const sum = new Float64Array(sw * sh), count = new Uint32Array(sw * sh), g = grayOf(rgb);
  for (let y = 0; y < h; y++) {
    const row = Math.min(sh - 1, Math.floor((y * sh) / h)) * sw;
    for (let x = 0; x < w; x++) {
      const i = row + Math.min(sw - 1, Math.floor((x * sw) / w));
      sum[i] = (sum[i] as number) + (g[y * w + x] ?? 0);
      count[i] = (count[i] as number) + 1;
    }
  }
  const [s0, s1] = o.skip ?? [0, 0];
  const grey = new Float32Array(sw * sh);
  for (let i = 0; i < grey.length; i++) {
    const cy = (Math.floor(i / sw) + 0.5) / sh, n = count[i] as number;
    grey[i] = (cy >= s0 && cy < s1) || !n ? NaN : (sum[i] as number) / n;
  }
  return { w: sw, h: sh, grey };
};

/** The share of the cells of two small pictures of one size that are off by `level` grey levels or more; a cell left out of either does not count. */
export const changedShare = (a: Small, b: Small, level = CHANGE_LEVEL): number => {
  let changed = 0, n = 0;
  for (let i = 0; i < a.grey.length; i++) {
    const x = a.grey[i] as number, y = b.grey[i] as number;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    n++;
    if (Math.abs(x - y) >= level) changed++;
  }
  return n ? changed / n : 0;
};
