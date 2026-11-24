/**
 * A change between two pictures that hold still, read as a region: on every frame each pixel is still the old picture,
 * already the new one, or neither (an object drawn over both, which counts with the new picture it brings). The region
 * of the new picture is then described: an edge that is straight, a circle or a wedge (each a model whose fit is the
 * share of the smaller side it puts on the right side of its edge), and the head of the region, when a shape leads it:
 * the part between the region's front and the narrowest place behind it. Pure; pixels in, pixels out: tracks.ts turns
 * the results into fractions of the canvas.
 */
import { median } from './pixels';

/** Classes of a pixel of the mask; 0: the two pictures are alike there and the frame is like them. */
export const OLD = 1;
export const NEW = 2;
/** Two colours differ when their channels are this far apart in sum (a mean of 30 levels). */
const FAR = 90;

/** mixed: how far the pixels that are one of the two pictures stand from the nearer one, as a share of the way between them (a mix of both: up to 0.5). */
export interface RevealMask { mask: Uint8Array; total: number; fresh: number; foreign: number; mixed: number }

const l1 = (a: Uint8Array, b: Uint8Array, i: number): number =>
  Math.abs((a[i] as number) - (b[i] as number)) + Math.abs((a[i + 1] as number) - (b[i + 1] as number)) + Math.abs((a[i + 2] as number) - (b[i + 2] as number));

/** Frame f against the old picture a and the new one b (rgb24 of one size). */
export const revealMask = (f: Uint8Array, a: Uint8Array, b: Uint8Array): RevealMask => {
  const n = f.length / 3;
  const mask = new Uint8Array(n);
  let total = 0, fresh = 0, foreign = 0, mixed = 0;
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const da = l1(f, a, i), db = l1(f, b, i);
    if (da > FAR && db > FAR) { mask[p] = NEW; foreign++; fresh++; total++; continue; }
    const dab = l1(a, b, i);
    if (dab < FAR) continue;
    total++;
    mixed += Math.min(da, db) / dab;
    if (db < da) { mask[p] = NEW; fresh++; } else mask[p] = OLD;
  }
  return { mask, total, fresh, foreign, mixed: total > foreign ? mixed / (total - foreign) : 0 };
};

/** New pixels this many pixels apart are one part: a shape joined to its trail by less than a pixel stays with it. */
const JOIN = 2;

/**
 * The region among the new pixels: their largest connected part (pixels within JOIN of each other) that lies within two pixels of the region
 * of the frame after (later: the frames are read from the last one back, since the region ends as the whole picture and
 * begins as a few pixels). Other new pixels (a caption that appears meanwhile) are left out of the mask. The mask is
 * changed in place; the number of pixels of the region is returned, 0 when nothing continues the later region.
 */
export const keepRegion = (mask: Uint8Array, w: number, h: number, later?: Uint8Array): number => {
  const label = new Int32Array(mask.length);
  const sizes: number[] = [0], near: boolean[] = [false];
  const touches = (p: number): boolean => {
    if (!later) return true;
    const x = p % w, y = Math.floor(p / w);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && later[yy * w + xx] === NEW) return true;
    }
    return false;
  };
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== NEW || label[seed]) continue;
    const id = sizes.length, stack = [seed];
    sizes.push(0); near.push(false);
    label[seed] = id;
    while (stack.length) {
      const p = stack.pop() as number, x = p % w, y = Math.floor(p / w);
      sizes[id] = (sizes[id] as number) + 1;
      if (!near[id] && touches(p)) near[id] = true;
      for (let dy = -JOIN; dy <= JOIN; dy++) for (let dx = -JOIN; dx <= JOIN; dx++) {
        const xx = x + dx, yy = y + dy, q = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[q] === NEW && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
  }
  let best = 0;
  for (let id = 1; id < sizes.length; id++) if (near[id] && (sizes[id] as number) > (sizes[best] as number)) best = id;
  for (let p = 0; p < mask.length; p++) if (mask[p] === NEW && label[p] !== best) mask[p] = 0;
  return best ? (sizes[best] as number) : 0;
};

/** The share of the pixels that change by more than FAR between two frames. */
export const changedShare = (a: Uint8Array, b: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (l1(a, b, i) > FAR) n++;
  return n / (a.length / 3);
};

interface Points { x: Float32Array; y: Float32Array; fresh: Uint8Array; n: number; nNew: number }

const pointsOf = (mask: Uint8Array, w: number, skip?: Uint8Array): Points => {
  const idx: number[] = [];
  mask.forEach((v, p) => { if (v && !(skip && skip[p])) idx.push(p); });
  const x = new Float32Array(idx.length), y = new Float32Array(idx.length), fresh = new Uint8Array(idx.length);
  let nNew = 0;
  idx.forEach((p, k) => { x[k] = p % w; y[k] = Math.floor(p / w); if (mask[p] === NEW) { fresh[k] = 1; nNew++; } });
  return { x, y, fresh, n: idx.length, nNew };
};

/**
 * How well a model's edge parts the two sides: the pixels with the lowest scores, as many as there are new ones, are
 * called new; fit is 1 minus the share of the smaller side that lands on the wrong side. at: the score of the edge.
 */
const fitOf = (p: Points, score: Float32Array): { fit: number; at: number } => {
  const order = Array.from({ length: p.n }, (_v, i) => i).sort((i, j) => (score[i] as number) - (score[j] as number) || i - j);
  let right = 0;
  for (let r = 0; r < p.nNew; r++) if (p.fresh[order[r] as number]) right++;
  const small = Math.min(p.nNew, p.n - p.nNew);
  return { fit: small ? 1 - (p.nNew - right) / small : 0, at: p.nNew ? (score[order[p.nNew - 1] as number] as number) : 0 };
};

const centroid = (p: Points, fresh: number): [number, number] => {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < p.n; i++) if (p.fresh[i] === fresh) { sx += p.x[i] as number; sy += p.y[i] as number; n++; }
  return n ? [sx / n, sy / n] : [0, 0];
};

const degrees = (dx: number, dy: number): number => (Math.atan2(dy, dx) * 180) / Math.PI;

/** A straight edge: the new picture on one side of a line. angle: where the edge travels (from new towards old). */
const straightFit = (p: Points): { fit: number; angle: number } => {
  const [nx, ny] = centroid(p, 1), [ox, oy] = centroid(p, 0);
  const len = Math.hypot(ox - nx, oy - ny);
  if (len < 1e-6) return { fit: 0, angle: 0 };
  const ux = (ox - nx) / len, uy = (oy - ny) / len;
  const score = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) score[i] = (p.x[i] as number) * ux + (p.y[i] as number) * uy;
  return { fit: fitOf(p, score).fit, angle: degrees(ux, uy) };
};

/** New pixels that touch an old one (4 neighbours): the edge of the region, the frame's border left out. */
const edgePixels = (mask: Uint8Array, w: number, h: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (mask[p] !== NEW) continue;
    if ((x > 0 && mask[p - 1] === OLD) || (x + 1 < w && mask[p + 1] === OLD) || (y > 0 && mask[p - w] === OLD) || (y + 1 < h && mask[p + w] === OLD)) out.push([x, y]);
  }
  return out;
};

/** Solves a 3 x 3 linear system by Cramer's rule; undefined when it has no single answer. */
const solve3 = (m: number[][], v: number[]): [number, number, number] | undefined => {
  const det = (a: number[][]): number =>
    (a[0]?.[0] ?? 0) * ((a[1]?.[1] ?? 0) * (a[2]?.[2] ?? 0) - (a[1]?.[2] ?? 0) * (a[2]?.[1] ?? 0))
    - (a[0]?.[1] ?? 0) * ((a[1]?.[0] ?? 0) * (a[2]?.[2] ?? 0) - (a[1]?.[2] ?? 0) * (a[2]?.[0] ?? 0))
    + (a[0]?.[2] ?? 0) * ((a[1]?.[0] ?? 0) * (a[2]?.[1] ?? 0) - (a[1]?.[1] ?? 0) * (a[2]?.[0] ?? 0));
  const d = det(m);
  if (Math.abs(d) < 1e-9) return undefined;
  const col = (k: number): number[][] => m.map((row, r) => row.map((x, c) => (c === k ? (v[r] as number) : x)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
};

/**
 * A circle through the region's edge (least squares on x2 + y2 + ax + by + c = 0, about the edge's own centre): the new
 * picture inside it (grows) or outside it. None when the edge is too short or so flat that it is a line.
 */
const circleFit = (p: Points, edge: [number, number][], w: number, h: number): { fit: number; centre: [number, number]; grows: boolean } | undefined => {
  if (edge.length < 8) return undefined;
  const mx = edge.reduce((s, e) => s + e[0], 0) / edge.length, my = edge.reduce((s, e) => s + e[1], 0) / edge.length;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [ex, ey] of edge) {
    const x = ex - mx, y = ey - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const s = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, edge.length]], [-sxz, -syz, -sz]);
  if (!s) return undefined;
  const cx = -s[0] / 2, cy = -s[1] / 2, r = Math.sqrt(Math.max(0, cx * cx + cy * cy - s[2]));
  if (!(r > 1) || r > 3 * Math.max(w, h)) return undefined;
  const inside = new Float32Array(p.n), outside = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) { inside[i] = Math.hypot((p.x[i] as number) - mx - cx, (p.y[i] as number) - my - cy); outside[i] = -(inside[i] as number); }
  const a = fitOf(p, inside).fit, b = fitOf(p, outside).fit;
  return { fit: Math.max(a, b), centre: [cx + mx, cy + my], grows: a >= b };
};

/** The front of the region: the mean of its pixels farthest from where it began (the farthest hundredth, at least 3). */
const frontOf = (p: Points, origin: [number, number]): [number, number] => {
  const far: { d: number; i: number }[] = [];
  for (let i = 0; i < p.n; i++) if (p.fresh[i]) far.push({ d: Math.hypot((p.x[i] as number) - origin[0], (p.y[i] as number) - origin[1]), i });
  far.sort((a, b) => b.d - a.d || a.i - b.i);
  const top = far.slice(0, Math.max(3, Math.round(far.length / 100)));
  return [top.reduce((s, f) => s + (p.x[f.i] as number), 0) / Math.max(1, top.length), top.reduce((s, f) => s + (p.y[f.i] as number), 0) / Math.max(1, top.length)];
};

/** A head is at least this broad (pixels), and the place behind it at most NECK of its breadth. */
const HEAD_BREADTH = 3;
const NECK = 0.6;

export interface Head { box: [number, number, number, number]; neck: [number, number]; pixels: Uint8Array }

/**
 * The head of the region: going back from the front along the way it came, the region broadens (the shape) and then
 * narrows to NECK of that breadth or less; the head ends at the narrowest place before the region is broader than the
 * shape again (the last one of several, within a pixel, or the first gap). A region that only broadens (a wedge, a
 * straight edge) has none.
 */
const headOf = (mask: Uint8Array, w: number, h: number, front: [number, number], u: [number, number]): Head | undefined => {
  const lo: number[] = [], hi: number[] = [];
  const along = (x: number, y: number): number => Math.max(0, Math.round((front[0] - x) * u[0] + (front[1] - y) * u[1]));
  const across = (x: number, y: number): number => -(x - front[0]) * u[1] + (y - front[1]) * u[0];
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== NEW) continue;
    const x = p % w, y = Math.floor(p / w), s = along(x, y), c = across(x, y);
    lo[s] = Math.min(lo[s] ?? Infinity, c); hi[s] = Math.max(hi[s] ?? -Infinity, c);
  }
  const breadth = Array.from({ length: Math.max(lo.length, hi.length) }, (_v, s) => (lo[s] === undefined ? 0 : (hi[s] as number) - (lo[s] as number) + 1));
  let peak = 0, s = 0;
  for (; s < breadth.length; s++) {
    peak = Math.max(peak, breadth[s] as number);
    if (peak >= HEAD_BREADTH && (breadth[s] as number) <= NECK * peak) break;
  }
  if (s >= breadth.length) return undefined;
  let end = s;
  while (end < breadth.length && (breadth[end] as number) <= peak) end++;
  const narrow = Math.min(...breadth.slice(s, end));
  let neck = s;
  for (let k = s; k < end; k++) { if ((breadth[k] as number) <= narrow + 1) neck = k; if ((breadth[k] as number) === 0) { neck = k; break; } }
  const pixels = new Uint8Array(mask.length);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== NEW) continue;
    const x = p % w, y = Math.floor(p / w);
    if (along(x, y) > neck) continue;
    pixels[p] = 1;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 < x0 ? undefined : { box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], neck: [front[0] - u[0] * neck, front[1] - u[1] * neck], pixels };
};

/** A wedge: the new picture within an angle of an axis from its tip. spread: the whole opening in degrees. */
const wedgeFit = (p: Points, tip: [number, number]): { fit: number; angle: number; spread: number } => {
  const [cx, cy] = centroid(p, 1);
  const len = Math.hypot(cx - tip[0], cy - tip[1]);
  if (len < 1e-6) return { fit: 0, angle: 0, spread: 0 };
  const ax = (cx - tip[0]) / len, ay = (cy - tip[1]) / len;
  const score = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const dx = (p.x[i] as number) - tip[0], dy = (p.y[i] as number) - tip[1];
    score[i] = Math.abs(Math.atan2(dx * ay - dy * ax, dx * ax + dy * ay));
  }
  const f = fitOf(p, score);
  // The tip points where the region travels: against the axis, which runs from the tip into the wedge.
  return { fit: f.fit, angle: degrees(-ax, -ay), spread: (2 * f.at * 180) / Math.PI };
};

export type EdgeShape = 'straight' | 'wedge' | 'circle' | 'irregular';

export interface FrameShape {
  shape: EdgeShape;
  fit: number;
  /** straight and wedge: where the edge or the tip travels, degrees on screen (0 right, 90 down). */
  angle?: number;
  /** circle: its centre in pixels (it may lie outside the frame), and whether the new picture is inside it. */
  centre?: [number, number];
  grows?: boolean;
  /** wedge: its opening in degrees. */
  spread?: number;
}

/** A straight edge or a circle is taken at this fit, a wedge at WEDGE_FIT and no wider than WIDEST degrees (a half-plane is 180). */
const CLEAN_FIT = 0.9;
const WEDGE_FIT = 0.85;
const WIDEST = 170;

export interface FrameReading { shape: FrameShape; head?: Head; front: [number, number]; edge: [number, number]; box: [number, number, number, number] }

/** One frame's region: its shape, its head when it has one, its front and the middle of its edge (pixels). */
export const readRegion = (mask: Uint8Array, w: number, h: number, origin: [number, number]): FrameReading | undefined => {
  const all = pointsOf(mask, w);
  if (all.nNew < 4 || all.nNew === all.n) return undefined;
  const front = frontOf(all, origin);
  const run = Math.hypot(front[0] - origin[0], front[1] - origin[1]);
  const straight = straightFit(all);
  const edges = edgePixels(mask, w, h);
  const circle = circleFit(all, edges, w, h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < all.n; i++) if (all.fresh[i]) { x0 = Math.min(x0, all.x[i] as number); y0 = Math.min(y0, all.y[i] as number); x1 = Math.max(x1, all.x[i] as number); y1 = Math.max(y1, all.y[i] as number); }
  const edge: [number, number] = edges.length ? [median(edges.map((e) => e[0])), median(edges.map((e) => e[1]))] : front;
  const base = { front, edge, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] as [number, number, number, number] };
  if (straight.fit >= CLEAN_FIT && straight.fit >= (circle?.fit ?? 0) - 0.03) return { ...base, shape: { shape: 'straight', fit: straight.fit, angle: straight.angle } };
  if (circle && circle.fit >= CLEAN_FIT) return { ...base, shape: { shape: 'circle', fit: circle.fit, centre: circle.centre, grows: circle.grows } };
  const head = run > 1 ? headOf(mask, w, h, front, [(front[0] - origin[0]) / run, (front[1] - origin[1]) / run]) : undefined;
  const rest = head ? pointsOf(mask, w, head.pixels) : all;
  const wedge = rest.nNew >= 4 && rest.nNew < rest.n ? wedgeFit(rest, head ? head.neck : front) : { fit: 0, angle: 0, spread: 0 };
  const shape: FrameShape = wedge.fit >= WEDGE_FIT && wedge.spread <= WIDEST ? { shape: 'wedge', fit: wedge.fit, angle: wedge.angle, spread: wedge.spread }
    : { shape: 'irregular', fit: Math.max(straight.fit, circle?.fit ?? 0, wedge.fit) };
  return { ...base, shape, ...(head ? { head } : {}) };
};
