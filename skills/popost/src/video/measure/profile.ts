/**
 * How one element changes inside one region, from rgb crops of the frames in time order (the first crop before the
 * change, the last after it). Shared by the motion events and by measureCurve. The element is what differs between
 * the first and the last crop; its mask, extent, centre and blend weight are followed frame by frame.
 */
import type { Direction, Ease, MotionEvent } from '../types';
import { clamp, median, toHex } from './pixels';

export interface Crop { w: number; h: number; frames: readonly Uint8Array[] }

export interface Profile {
  kind: MotionEvent['kind'];
  /** Index of the first crop that differs from the first one, and one past the first crop equal to the last one. */
  start: number;
  end: number;
  how: NonNullable<MotionEvent['how']>;
  direction?: Direction;
  ease: Ease | 'instant';
  overshoot?: number;
  colour?: string;
  /** Element at rest, as fractions of the crop: [x, y, w, h]. */
  box: [number, number, number, number];
  /** Progress 0..1 of each crop from start - 1 to end - 1. */
  progress: number[];
  /** Mean change of the element's pixels between rest states, levels. */
  contrast: number;
}

/** Largest channel difference between pixel i of a and pixel j of b (j = i unless given). */
const pixDiff = (a: Uint8Array, b: Uint8Array, i: number, j: number = i): number =>
  Math.max(Math.abs((a[i] as number) - (b[j] as number)), Math.abs((a[i + 1] as number) - (b[j + 1] as number)), Math.abs((a[i + 2] as number) - (b[j + 2] as number)));

const meanDiff = (a: Uint8Array, b: Uint8Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += pixDiff(a, b, i);
  return s / (a.length / 3);
};

interface Shape { mass: number; x0: number; x1: number; y0: number; y1: number; cx: number; cy: number; alpha: number }

/** Mask of pixels changed by more than half the contrast against ref; its extent, centre and blend weight onto target. */
const shapeOf = (f: Uint8Array, ref: Uint8Array, target: Uint8Array, w: number, h: number, thr: number): Shape => {
  let mass = 0, x0 = w, x1 = -1, y0 = h, y1 = -1, sx = 0, sy = 0, num = 0, den = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) { const d = (target[i + c] as number) - (ref[i + c] as number); num += ((f[i + c] as number) - (ref[i + c] as number)) * d; den += d * d; }
      if (pixDiff(f, ref, i) <= thr) continue;
      mass++; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { mass, x0, x1, y0, y1, cx: mass ? sx / mass : w / 2, cy: mass ? sy / mass : h / 2, alpha: den > 0 ? num / den : 0 };
};

/** Where a rising curve reaches one half, as a fraction of its length (linear interpolation between samples). */
const halfTime = (q: number[]): number => {
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1] as number, b = q[i] as number;
    if (b >= 0.5 && a < 0.5) return (i - 1 + (0.5 - a) / (b - a + 1e-9)) / (q.length - 1);
  }
  return 0.5;
};

/** Ease class from a progress curve sampled on every frame of the change (first 0, last 1). */
export const easeOf = (q: number[]): Ease | 'instant' => {
  if (q.length <= 2) return 'instant';
  const t = halfTime(q);
  if (t < 0.38) return 'out';
  if (t > 0.62) return 'in';
  const at = (f: number): number => { const x = f * (q.length - 1), i = Math.floor(x); return (q[i] as number) + ((q[Math.min(q.length - 1, i + 1)] as number) - (q[i] as number)) * (x - i); };
  return at(0.25) < 0.15 && at(0.75) > 0.85 ? 'in-out' : 'linear';
};

/**
 * Mean contrast between pixels two steps apart (left, right, up, down) in one image: across the outline of the
 * changed area (a changed pixel against an unchanged one), and inside the ground (two unchanged pixels), which is
 * what any line through a detailed ground shows.
 */
const contrasts = (img: Uint8Array, changed: Uint8Array, w: number, h: number): { outline: number; ground: number } => {
  let os = 0, on = 0, gs = 0, gn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = changed[y * w + x];
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h || changed[Y * w + X]) continue;
        const d = pixDiff(img, img, (y * w + x) * 3, (Y * w + X) * 3);
        if (inside) { os += d; on++; } else { gs += d; gn++; }
      }
    }
  }
  return { outline: on ? os / on : 0, ground: gn ? gs / gn : 0 };
};

/**
 * Appear, disappear or change: the element is where the rest states differ. Where it is present its outline stands
 * out against what is around it; where it is absent the same outline runs through the ground and shows no more than
 * any other line through it. An appear has the outline only after, a disappear only before, a change both times.
 */
const kindOf = (first: Uint8Array, last: Uint8Array, w: number, h: number, thr: number): MotionEvent['kind'] => {
  const changed = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) changed[p] = pixDiff(first, last, p * 3) > thr ? 1 : 0;
  // the outline's contrast above the ground's own
  const c0 = contrasts(first, changed, w, h), c1 = contrasts(last, changed, w, h);
  const e0 = Math.max(0, c0.outline - c0.ground), e1 = Math.max(0, c1.outline - c1.ground);
  if (e1 > 1.5 * e0 + 5) return 'appear';
  if (e0 > 1.5 * e1 + 5) return 'disappear';
  return 'change';
};

const colourIn = (img: Uint8Array, other: Uint8Array, thr: number): string | undefined => {
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < img.length; i += 3) if (pixDiff(img, other, i) > thr) for (let c = 0; c < 3; c++) (ch[c] as number[]).push(img[i + c] as number);
  return (ch[0] as number[]).length ? toHex(ch.map(median)) : undefined;
};

export { meanDiff, shapeOf, kindOf, colourIn };

interface Moves { how: Profile['how']; direction?: Direction; overshoot?: number; q: number[] }

/** Wipe: one edge stays where it ends while the opposite one moves out (the other axis is full from the start). */
const asWipe = (vis: Shape[], F: Shape): Moves | undefined => {
  const f = vis[0] as Shape;
  const wr = (f.x1 - f.x0 + 1) / (F.x1 - F.x0 + 1), hr = (f.y1 - f.y0 + 1) / (F.y1 - F.y0 + 1);
  const grows = (r: number, other: number): boolean => r < 0.7 && other >= 0.85;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  let direction: Direction | undefined;
  if (grows(wr, hr) && near(f.x0, F.x0) && !near(f.x1, F.x1)) direction = 'right';
  else if (grows(wr, hr) && near(f.x1, F.x1) && !near(f.x0, F.x0)) direction = 'left';
  else if (grows(hr, wr) && near(f.y0, F.y0) && !near(f.y1, F.y1)) direction = 'down';
  else if (grows(hr, wr) && near(f.y1, F.y1) && !near(f.y0, F.y0)) direction = 'up';
  if (!direction) return undefined;
  const horizontal = direction === 'left' || direction === 'right';
  return { how: 'wipe', direction, q: vis.map((s) => clamp(horizontal ? (s.x1 - s.x0 + 1) / (F.x1 - F.x0 + 1) : (s.y1 - s.y0 + 1) / (F.y1 - F.y0 + 1), 0, 1)) };
};

/** Slide: the whole element travels to its place, at close to its final size. */
const asSlide = (vis: Shape[], F: Shape): Moves | undefined => {
  const fw = F.x1 - F.x0 + 1, fh = F.y1 - F.y0 + 1;
  const f = vis[0] as Shape;
  const dx = F.cx - f.cx, dy = F.cy - f.cy;
  const horizontal = Math.abs(dx) / fw >= Math.abs(dy) / fh;
  const travel = horizontal ? Math.abs(dx) : Math.abs(dy);
  const size = horizontal ? (f.x1 - f.x0 + 1) / fw : (f.y1 - f.y0 + 1) / fh;
  if (travel < Math.max(1.5, 0.12 * (horizontal ? fw : fh)) || size < 0.6) return undefined;
  const direction: Direction = horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  return { how: 'slide', direction, q: vis.map((s) => clamp(1 - Math.hypot(F.cx - s.cx, F.cy - s.cy) / Math.hypot(dx, dy), 0, 1)) };
};

/** Scale: the element grows about a fixed centre; overshoot when it grows past its final size and comes back. */
const asScale = (vis: Shape[], F: Shape): Moves | undefined => {
  const fw = F.x1 - F.x0 + 1, fh = F.y1 - F.y0 + 1;
  const ratio = (s: Shape): number => Math.max((s.x1 - s.x0 + 1) / fw, (s.y1 - s.y0 + 1) / fh);
  const f = vis[0] as Shape;
  const still = vis.every((s) => Math.abs(F.cx - s.cx) < 0.15 * fw && Math.abs(F.cy - s.cy) < 0.15 * fh);
  const peak = Math.max(...vis.map(ratio));
  // grows into place, or (a pop that is still faint while small) goes past its final size and comes back
  if (!still || (ratio(f) > 0.8 && peak < 1.05)) return undefined;
  return { how: 'scale', ...(peak > 1.03 ? { overshoot: Math.round((peak - 1) * 100) / 100 } : {}), q: vis.map((s) => clamp(ratio(s), 0, 1)) };
};

const directionFlip: Record<Direction, Direction> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/** Profiles the change between the first and the last crop. */
export const profileCrop = (c: Crop): Profile | undefined => {
  const n = c.frames.length;
  if (n < 2) return undefined;
  const first = c.frames[0] as Uint8Array, last = c.frames[n - 1] as Uint8Array;
  const total = meanDiff(first, last);
  if (total < 0.5) return undefined;
  const kind = kindOf(first, last, c.w, c.h, 12);
  const seq = kind === 'disappear' ? [...c.frames].reverse() : [...c.frames];
  const ref = seq[0] as Uint8Array, target = seq[n - 1] as Uint8Array;
  // 2% of the change: an eased curve spends its last frames very close to the end state
  const tol = Math.max(0.7, 0.02 * total);
  let s = 1;
  while (s < n - 1 && meanDiff(seq[s] as Uint8Array, ref) <= tol) s++;
  let e = n - 1;
  while (e - 1 >= s && meanDiff(seq[e - 1] as Uint8Array, target) <= tol) e--;
  const diffs: number[] = [];
  for (let i = 0; i < ref.length; i += 3) { const d = pixDiff(ref, target, i); if (d > 12) diffs.push(d); }
  const contrast = diffs.length ? median(diffs) : total;
  const shapes = seq.slice(s - 1, e + 1).map((f) => shapeOf(f, ref, target, c.w, c.h, 0.5 * contrast));
  const F = shapes[shapes.length - 1] as Shape;
  const vis = shapes.filter((sh) => sh.mass >= 0.15 * F.mass && sh.mass > 0);
  const alpha = shapes.map((sh) => clamp(sh.alpha, 0, 1));
  const moves: Moves = e === s || F.mass === 0 || vis.length < 2
    ? { how: e === s ? 'instant' : 'fade', q: alpha }
    : asWipe(vis, F) ?? asSlide(vis, F) ?? asScale(vis, F) ?? { how: 'fade', q: alpha };
  const q = moves.how === 'fade' || moves.how === 'instant' ? alpha : [0, ...moves.q];
  const box: Profile['box'] = F.mass ? [F.x0 / c.w, F.y0 / c.h, (F.x1 - F.x0 + 1) / c.w, (F.y1 - F.y0 + 1) / c.h] : [0, 0, 1, 1];
  // time order: an appear runs on s .. e; a disappear was read backwards
  const [start, end] = kind === 'disappear' ? [n - e, n - s + 1] : [s, e + 1];
  const direction = moves.direction && kind === 'disappear' ? directionFlip[moves.direction] : moves.direction;
  const colour = colourIn(target, ref, 12);
  // progress of the change in time order: how far an exit has gone is 1 - how present the element still is
  const progress = kind === 'disappear' ? q.map((x) => 1 - x).reverse() : q;
  return {
    kind, start, end, how: moves.how, ...(direction ? { direction } : {}), ease: moves.how === 'instant' ? 'instant' : easeOf(progress),
    ...(moves.overshoot ? { overshoot: moves.overshoot } : {}), ...(colour ? { colour } : {}), box, progress, contrast,
  };
};
