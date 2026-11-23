/**
 * Robust comparisons of gray thumbnails shared by the readers that explain a frame as a warped or blurred copy of
 * another: a plain and a trimmed mean difference (items that stay sharp and upright over a layer that blurs, turns or
 * scales are a minority of pixels the trimmed mean leaves out), a warp about the centre and a Gaussian blur.
 */

/** Share of pixels a model may leave unexplained: items stay sharp and upright over a layer that blurs or turns. */
export const KEEP = 0.8;

/** Mean |a - b| and the mean of its smallest KEEP share (from a histogram of whole levels: linear in the pixels). */
export const diffs = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number] => {
  const hist = new Float64Array(256), sums = new Float64Array(256);
  let all = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] as number) - (b[i] as number));
    const k = Math.min(255, Math.floor(d));
    hist[k] = (hist[k] as number) + 1;
    sums[k] = (sums[k] as number) + d;
    all += d;
  }
  let left = KEEP * a.length, s = 0;
  for (let k = 0; k < 256 && left > 0; k++) {
    const take = Math.min(left, hist[k] as number);
    if (take > 0) s += ((sums[k] as number) / (hist[k] as number)) * take;
    left -= take;
  }
  return [all / Math.max(1, a.length), s / Math.max(1, KEEP * a.length)];
};

/** How much of a frame's difference to its end a model leaves: the better of the plain and the trimmed ratio. */
export const ratio = (model: [number, number], before: [number, number]): number =>
  Math.min(model[0] / (before[0] + 1e-6), model[1] / (before[1] + 1e-6));

/**
 * The two passes of a separable blur. Each output adds the kernel's terms in order from -r to r (outside the frame:
 * skipped when black, else the nearest edge sample), so the interior, which needs no test, gives the very same sums as
 * the border; both passes walk the picture row by row.
 */
const blurRows = (src: ArrayLike<number>, out: Float32Array, k: Float64Array, sum: number, w: number, h: number, black: boolean): void => {
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= r && x < w - r) {
        for (let i = 0, p = row + x - r; i <= 2 * r; i++, p++) s += (k[i] as number) * (src[p] as number);
      } else {
        for (let i = -r; i <= r; i++) {
          let u = x + i;
          if (u < 0 || u >= w) { if (black) continue; u = u < 0 ? 0 : w - 1; }
          s += (k[i + r] as number) * (src[row + u] as number);
        }
      }
      out[row + x] = s / sum;
    }
  }
};

const blurColumns = (src: ArrayLike<number>, out: Float32Array, k: Float64Array, sum: number, w: number, h: number, black: boolean): void => {
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const inside = y >= r && y < h - r;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (inside) {
        for (let i = 0, p = (y - r) * w + x; i <= 2 * r; i++, p += w) s += (k[i] as number) * (src[p] as number);
      } else {
        for (let i = -r; i <= r; i++) {
          let u = y + i;
          if (u < 0 || u >= h) { if (black) continue; u = u < 0 ? 0 : h - 1; }
          s += (k[i + r] as number) * (src[u * w + x] as number);
        }
      }
      out[y * w + x] = s / sum;
    }
  }
};

/** Separable Gaussian blur (sigma in pixels); outside the frame is black, or the nearest edge pixel. */
export const gaussBlur = (g: ArrayLike<number>, w: number, h: number, sigma: number, black: boolean): Float32Array => {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((x, y) => x + y, 0);
  const kk = Float64Array.from(k), across = new Float32Array(w * h), out = new Float32Array(w * h);
  blurRows(g, across, kk, sum, w, h, black);
  blurColumns(across, out, kk, sum, w, h, black);
  return out;
};

/** Smallest scale at which a copy of a w x h picture turned by deg degrees still covers the frame. */
export const coverScale = (deg: number, w: number, h: number): number => {
  const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
};

/** [plain, trimmed] |m - ref turned by deg, scaled about the centre, shifted by tx, ty pixels| at every second pixel;
 *  outside ref is black. */
export const warpDiffs = (ref: ArrayLike<number>, m: ArrayLike<number>, w: number, h: number, deg: number, scale: number, tx = 0, ty = 0): [number, number] => {
  const r = (-deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const got: number[] = [], want: number[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const X = (x - cx - tx) / scale, Y = (y - cy - ty) / scale;
      const sx = cx + c * X - s * Y, sy = cy + s * X + c * Y;
      let v = 0;
      if (sx >= 0 && sy >= 0 && sx <= w - 1.001 && sy <= h - 1.001) {
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
        v = ((ref[i] as number) * (1 - fx) + (ref[i + 1] as number) * fx) * (1 - fy) + ((ref[i + w] as number) * (1 - fx) + (ref[i + w + 1] as number) * fx) * fy;
      }
      got.push(m[y * w + x] as number);
      want.push(v);
    }
  }
  return diffs(got, want);
};
