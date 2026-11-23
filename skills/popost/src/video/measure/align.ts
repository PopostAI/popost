/**
 * Global motion between two gray frames: the similarity (scale, rotation and shift about the centre) that carries
 * the first picture onto the second. Fitted by Gauss-Newton on an image pyramid with Huber weights, so an element
 * that moves on its own does not drag the fit; an optional coarse search finds large moves first.
 * Units: tx, ty in pixels of the given frames; angle in radians, clockwise on screen (y grows downwards).
 */

export interface Similarity { scale: number; angle: number; tx: number; ty: number }
export const IDENTITY: Similarity = { scale: 1, angle: 0, tx: 0, ty: 0 };

export interface Alignment extends Similarity {
  /** Mean |b(W(p)) - a(p)| over the pixels of a that land inside b, after alignment, in levels. */
  residual: number;
  /** Mean |b(p) - a(p)| over the same pixels: the difference that no motion explains. */
  before: number;
  /** Share of a's pixels that land inside b. */
  coverage: number;
  /** Mean absolute gradient of a, in levels per pixel: how much there is to track. */
  texture: number;
}

export interface AlignOptions {
  init?: Similarity;
  /** Try a grid of shifts and scales on the coarsest level first (for moves larger than a few pixels). */
  search?: boolean;
  rotation?: boolean;
}

interface Level { w: number; h: number; a: Float32Array; b: Float32Array; bx: Float32Array; by: Float32Array }

const half = (src: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } => {
  const w2 = w >> 1, h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * w2 + x] = ((src[i] as number) + (src[i + 1] as number) + (src[i + w] as number) + (src[i + w + 1] as number)) / 4;
    }
  }
  return { data: out, w: w2, h: h2 };
};

const gradients = (b: Float32Array, w: number, h: number): [Float32Array, Float32Array] => {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = ((b[y * w + Math.min(w - 1, x + 1)] as number) - (b[y * w + Math.max(0, x - 1)] as number)) / 2;
      gy[i] = ((b[Math.min(h - 1, y + 1) * w + x] as number) - (b[Math.max(0, y - 1) * w + x] as number)) / 2;
    }
  }
  return [gx, gy];
};

const pyramid = (a: Float32Array, b: Float32Array, w: number, h: number): Level[] => {
  const levels: Level[] = [];
  let ca = { data: a, w, h }, cb = { data: b, w, h };
  for (;;) {
    const [bx, by] = gradients(cb.data, cb.w, cb.h);
    levels.push({ w: ca.w, h: ca.h, a: ca.data, b: cb.data, bx, by });
    if (Math.min(ca.w, ca.h) < 32) break;
    ca = half(ca.data, ca.w, ca.h);
    cb = half(cb.data, cb.w, cb.h);
  }
  return levels;
};

const bilinear = (img: Float32Array, w: number, x: number, y: number): number => {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  const top = (img[i] as number) + ((img[i + 1] as number) - (img[i] as number)) * fx;
  const bot = (img[i + w] as number) + ((img[i + w + 1] as number) - (img[i + w] as number)) * fx;
  return top + (bot - top) * fy;
};

/** Parameters in the linear form the fit uses: x' = cx + (1+p0)X - p1 Y + p2, y' = cy + p1 X + (1+p0)Y + p3. */
type Params = [number, number, number, number];

const toParams = (s: Similarity, sx: number, sy: number): Params =>
  [s.scale * Math.cos(s.angle) - 1, s.scale * Math.sin(s.angle), s.tx * sx, s.ty * sy];

const fromParams = (p: Params, sx: number, sy: number): Similarity =>
  ({ scale: Math.hypot(1 + p[0], p[1]), angle: Math.atan2(p[1], 1 + p[0]), tx: p[2] / sx, ty: p[3] / sy });

/** Calls f(r, x', y', X, Y) for every pixel of a whose image lies inside b (one pixel of margin). Returns how many. */
const eachPixel = (L: Level, p: Params, stride: number, f: (r: number, qx: number, qy: number, X: number, Y: number) => void): number => {
  const cx = (L.w - 1) / 2, cy = (L.h - 1) / 2;
  let n = 0;
  for (let y = 1; y < L.h - 1; y += stride) {
    const Y = y - cy;
    for (let x = 1; x < L.w - 1; x += stride) {
      const X = x - cx;
      const qx = cx + (1 + p[0]) * X - p[1] * Y + p[2];
      const qy = cy + p[1] * X + (1 + p[0]) * Y + p[3];
      if (qx < 0 || qy < 0 || qx >= L.w - 1 || qy >= L.h - 1) continue;
      n++;
      f(bilinear(L.b, L.w, qx, qy) - (L.a[y * L.w + x] as number), qx, qy, X, Y);
    }
  }
  return n;
};

/**
 * The loops below are eachPixel written out for each use (the same pixels in the same order and the same arithmetic,
 * so the same sums): a callback per pixel is most of the time of a fit.
 */
const meanResidual = (L: Level, p: Params, stride: number): { mean: number; coverage: number } => {
  const cx = (L.w - 1) / 2, cy = (L.h - 1) / 2, w = L.w, a = L.a, b = L.b, p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
  let s = 0, n = 0;
  for (let y = 1; y < L.h - 1; y += stride) {
    const Y = y - cy;
    for (let x = 1; x < w - 1; x += stride) {
      const X = x - cx;
      const qx = cx + (1 + p0) * X - p1 * Y + p2;
      const qy = cy + p1 * X + (1 + p0) * Y + p3;
      if (qx < 0 || qy < 0 || qx >= w - 1 || qy >= L.h - 1) continue;
      n++;
      s += Math.abs(bilinear(b, w, qx, qy) - (a[y * w + x] as number));
    }
  }
  const total = Math.max(1, Math.ceil((L.w - 2) / stride) * Math.ceil((L.h - 2) / stride));
  return { mean: n ? s / n : Infinity, coverage: n / total };
};

const SEARCH_SCALES = [0.8, 0.9, 1, 1.1, 1.25];

/** Best shift and scale on a grid, at the coarsest level, among overlaps of at least half the frame. */
const coarseSearch = (L: Level, start: Params): Params => {
  let best = start, bestErr = meanResidual(L, start, 2).mean;
  const R = Math.max(2, Math.round(Math.min(L.w, L.h) * 0.3));
  for (const s of SEARCH_SCALES) {
    for (let ty = -R; ty <= R; ty++) {
      for (let tx = -R; tx <= R; tx++) {
        const p: Params = [s - 1, 0, tx, ty];
        const r = meanResidual(L, p, 2);
        if (r.coverage >= 0.5 && r.mean < bestErr - 1e-9) { best = p; bestErr = r.mean; }
      }
    }
  }
  return best;
};

/** Solves the n x n system H d = g in place by Gaussian elimination with partial pivoting; null when singular. */
const solve = (H: number[][], g: number[]): number[] | null => {
  const n = g.length;
  const m = H.map((row, i) => [...row, g[i] as number]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[piv] as number[])[c] as number)) piv = r;
    if (Math.abs((m[piv] as number[])[c] as number) < 1e-9) return null;
    [m[c], m[piv]] = [m[piv] as number[], m[c] as number[]];
    const rowC = m[c] as number[];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r] as number[];
      const f = (row[c] as number) / (rowC[c] as number);
      for (let k = c; k <= n; k++) row[k] = (row[k] as number) - f * (rowC[k] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
};

/** One Gauss-Newton step with Huber weights (k in levels). Returns the parameter change. */
const step = (L: Level, p: Params, k: number, rotation: boolean): number[] | null => {
  const np = rotation ? 4 : 3;
  const H = Array.from({ length: np }, () => new Array<number>(np).fill(0));
  const g = new Array<number>(np).fill(0);
  if (rotation) {
    eachPixel(L, p, 1, (r, qx, qy, X, Y) => {
      const gx = bilinear(L.bx, L.w, qx, qy), gy = bilinear(L.by, L.w, qx, qy);
      const J = [gx * X + gy * Y, -gx * Y + gy * X, gx, gy];
      const a = Math.abs(r);
      const wgt = a <= k ? 1 : k / a;
      for (let i = 0; i < np; i++) {
        const Ji = J[i] as number;
        g[i] = (g[i] as number) - wgt * Ji * r;
        const Hi = H[i] as number[];
        for (let j = i; j < np; j++) Hi[j] = (Hi[j] as number) + wgt * Ji * (J[j] as number);
      }
    });
  } else {
    // three parameters (no turn), the loop of eachPixel written out with the sums kept in locals
    const cx = (L.w - 1) / 2, cy = (L.h - 1) / 2, w = L.w, la = L.a, lb = L.b, bx = L.bx, by = L.by, p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
    let g0 = 0, g1 = 0, g2 = 0, h00 = 0, h01 = 0, h02 = 0, h11 = 0, h12 = 0, h22 = 0;
    for (let y = 1; y < L.h - 1; y++) {
      const Y = y - cy;
      for (let x = 1; x < w - 1; x++) {
        const X = x - cx;
        const qx = cx + (1 + p0) * X - p1 * Y + p2;
        const qy = cy + p1 * X + (1 + p0) * Y + p3;
        if (qx < 0 || qy < 0 || qx >= w - 1 || qy >= L.h - 1) continue;
        const r = bilinear(lb, w, qx, qy) - (la[y * w + x] as number);
        const gx = bilinear(bx, w, qx, qy), gy = bilinear(by, w, qx, qy);
        const J0 = gx * X + gy * Y, J1 = gx, J2 = gy;
        const a = Math.abs(r);
        const wgt = a <= k ? 1 : k / a;
        g0 = g0 - wgt * J0 * r; h00 = h00 + wgt * J0 * J0; h01 = h01 + wgt * J0 * J1; h02 = h02 + wgt * J0 * J2;
        g1 = g1 - wgt * J1 * r; h11 = h11 + wgt * J1 * J1; h12 = h12 + wgt * J1 * J2;
        g2 = g2 - wgt * J2 * r; h22 = h22 + wgt * J2 * J2;
      }
    }
    g[0] = g0; g[1] = g1; g[2] = g2;
    H[0] = [h00, h01, h02]; H[1] = [0, h11, h12]; H[2] = [0, 0, h22];
  }
  for (let i = 0; i < np; i++) {
    const Hi = H[i] as number[];
    for (let j = 0; j < i; j++) Hi[j] = (H[j] as number[])[i] as number;
    Hi[i] = (Hi[i] as number) * 1.0001 + 1e-6; // a touch of damping keeps flat directions from blowing up
  }
  const d = solve(H, g);
  if (!d) return null;
  return rotation ? d : [d[0] as number, 0, d[1] as number, d[2] as number];
};

/** |residual| of every stride-th pixel that lands inside b, in eachPixel's order. */
const absResiduals = (L: Level, p: Params, stride: number): Float64Array => {
  const cx = (L.w - 1) / 2, cy = (L.h - 1) / 2, w = L.w, a = L.a, b = L.b, p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
  const out = new Float64Array(Math.ceil((L.w - 2) / stride) * Math.ceil((L.h - 2) / stride));
  let n = 0;
  for (let y = 1; y < L.h - 1; y += stride) {
    const Y = y - cy;
    for (let x = 1; x < w - 1; x += stride) {
      const X = x - cx;
      const qx = cx + (1 + p0) * X - p1 * Y + p2;
      const qy = cy + p1 * X + (1 + p0) * Y + p3;
      if (qx < 0 || qy < 0 || qx >= w - 1 || qy >= L.h - 1) continue;
      out[n++] = Math.abs(bilinear(b, w, qx, qy) - (a[y * w + x] as number));
    }
  }
  return out.subarray(0, n);
};

const fitLevel = (L: Level, start: Params, rotation: boolean, iters: number): Params => {
  let p: Params = [...start];
  for (let it = 0; it < iters; it++) {
    const res = absResiduals(L, p, 2);
    if (res.length < 16) return p;
    res.sort();
    const k = Math.max(2, 1.5 * 1.4826 * (res[res.length >> 1] as number));
    const d = step(L, p, k, rotation);
    if (!d) return p;
    p = [p[0] + (d[0] as number), p[1] + (d[1] as number), p[2] + (d[2] as number), p[3] + (d[3] as number)];
    if (Math.abs(d[2] as number) + Math.abs(d[3] as number) < 0.01 && Math.abs(d[0] as number) + Math.abs(d[1] as number) < 1e-4) break;
  }
  return p;
};

/** Mean |residual| after the fit and without motion, both over the pixels that land inside b, and the coverage. */
const finalResidual = (L: Level, p: Params): { residual: number; before: number; coverage: number } => {
  let after = 0, before = 0;
  const n = eachPixel(L, p, 1, (r, _qx, _qy, X, Y) => {
    after += Math.abs(r);
    const i = Math.round(Y + (L.h - 1) / 2) * L.w + Math.round(X + (L.w - 1) / 2);
    before += Math.abs((L.b[i] as number) - (L.a[i] as number));
  });
  const total = Math.max(1, (L.w - 2) * (L.h - 2));
  return n ? { residual: after / n, before: before / n, coverage: n / total } : { residual: Infinity, before: 0, coverage: 0 };
};

/** Fits the global motion from frame a to frame b (both gray, w x h). */
export const align = (a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, opts: AlignOptions = {}): Alignment => {
  const fa = Float32Array.from(a), fb = Float32Array.from(b);
  const levels = pyramid(fa, fb, w, h);
  const rotation = opts.rotation ?? false;
  const top = levels.length - 1;
  const scaleOf = (l: number): [number, number] => [(levels[l] as Level).w / w, (levels[l] as Level).h / h];
  let p = toParams(opts.init ?? IDENTITY, ...scaleOf(top));
  if (opts.search) p = coarseSearch(levels[top] as Level, p);
  for (let l = top; l >= 0; l--) {
    p = fitLevel(levels[l] as Level, p, rotation, l === 0 ? 6 : 10);
    if (l > 0) {
      const [sx0, sy0] = scaleOf(l), [sx1, sy1] = scaleOf(l - 1);
      p = [p[0], p[1], (p[2] * sx1) / sx0, (p[3] * sy1) / sy0];
    }
  }
  const L0 = levels[0] as Level;
  const fit = finalResidual(L0, p);
  const s = fromParams(p, 1, 1);
  let tex = 0;
  for (let i = 0; i < L0.a.length; i++) tex += Math.abs(L0.bx[i] as number) + Math.abs(L0.by[i] as number);
  return { ...s, residual: fit.residual, before: fit.before, coverage: fit.coverage, texture: tex / L0.a.length };
};

/** True when b is mostly a moved, scaled or turned copy of a: the change between them is movement, not new picture. */
export const motionExplains = (m: Alignment): boolean =>
  m.coverage > 0.5 && m.texture > 1.5 && m.before > 1 && m.residual < 0.45 * m.before && (Math.abs(m.scale - 1) > 0.01 || Math.hypot(m.tx, m.ty) > 0.5 || Math.abs(m.angle) > 0.01);
