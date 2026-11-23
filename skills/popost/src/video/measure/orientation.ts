/**
 * Rotation between two pictures from their gradient-orientation histograms: turning a picture shifts the histogram
 * by the angle, whatever the scale or position. Used to tell a spin from the other transitions. The answer is in
 * -45..45 degrees for pictures whose edges are mostly horizontal and vertical (their histogram repeats every 90
 * degrees), so a quarter turn reads as none; the frames on the way to it do not.
 */

const BINS = 36; // 5 degrees each, over 0..180

const histogram = (g: ArrayLike<number>, w: number, h: number): Float64Array => {
  const out = new Float64Array(BINS);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (g[i + 1] as number) - (g[i - 1] as number), gy = (g[i + w] as number) - (g[i - w] as number);
      const mag = Math.hypot(gx, gy);
      if (mag < 8) continue;
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI;
      const pos = (a / Math.PI) * BINS - 0.5;
      const lo = Math.floor(pos), fr = pos - lo;
      out[(lo + BINS) % BINS] = (out[(lo + BINS) % BINS] as number) + mag * (1 - fr);
      out[(lo + 1) % BINS] = (out[(lo + 1) % BINS] as number) + mag * fr;
    }
  }
  return out;
};

const circularCorrelation = (a: Float64Array, b: Float64Array, shift: number): number => {
  let s = 0;
  for (let i = 0; i < BINS; i++) s += (a[i] as number) * (b[(i + shift + BINS) % BINS] as number);
  return s;
};

/**
 * Turn of picture b against picture a in degrees (positive: clockwise on screen), or 0 when either picture has too
 * few edges or the best shift is not clearly better than none.
 */
export const rotationBetween = (a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number): number => {
  const ha = histogram(a, w, h), hb = histogram(b, w, h);
  const ea = ha.reduce((x, y) => x + y, 0), eb = hb.reduce((x, y) => x + y, 0);
  if (ea < 1e3 || eb < 1e3) return 0;
  const norm = (v: Float64Array, e: number): Float64Array => v.map((x) => x / e - 1 / BINS);
  const na = norm(ha, ea), nb = norm(hb, eb);
  let best = 0, bestC = -Infinity;
  for (let s = -BINS / 2; s < BINS / 2; s++) { const c = circularCorrelation(na, nb, s); if (c > bestC) { bestC = c; best = s; } }
  const zero = circularCorrelation(na, nb, 0);
  const self = circularCorrelation(na, na, 0);
  if (self <= 0 || bestC - zero < 0.25 * self) return 0;
  const l = circularCorrelation(na, nb, best - 1), r = circularCorrelation(na, nb, best + 1);
  const den = l - 2 * bestC + r;
  const sub = den < 0 ? (0.5 * (l - r)) / den : 0;
  return (best + sub) * (180 / BINS);
};
