/**
 * What lies right around the letters' shapes. Two colours that enclose each other inside the lines' boxes can be
 * letters with an outline, or the outline seen as letters; a colour that fills the box around the letters can be a
 * plate, or a light page behind the line. Their shapes tell them apart where their colours cannot:
 * - an outline is a thin ring that hugs each glyph's own shape: wherever the fill's strokes end, the outline's colour
 *   lies within a few pixels, on every line, whatever the picture is. The outline's own strokes end on the fill on
 *   their inner side and on the picture on their outer side, so on the lines where the picture is another colour than
 *   the fill only about half their ends meet it. Over a page of the fill's colour (white letters with a dark outline
 *   on a white page) each colour encloses the other there, and the other lines decide (hugOf);
 * - a plate is a filled region that reaches past the letters on all four sides with a margin and ends in an edge of
 *   its own, within about a line height of them; a page or a wall behind the line goes on past that (plateAround).
 */
import { inside, labOf, seenAt, type Frame, type Lab, type Rect, type Seen } from './frame';
import { NEAR } from './strokes';

const sub = (a: Lab, b: Lab): Lab => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Lab, b: Lab): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;

/**
 * Where `c` lies on the way from `from` to `to`: t is 0 at from and 1 at to (more past it), off how far it is from
 * that way, with hue and saturation at 0.4 as dEdge weighs them (video keeps colour at half the resolution).
 */
export const along = (from: Lab, to: Lab, c: Lab): { t: number; off: number } => {
  const axis = sub(to, from), d = sub(c, from), len2 = dot(axis, axis) || 1;
  const t = dot(d, axis) / len2;
  const off = sub(d, [axis[0] * t, axis[1] * t, axis[2] * t]);
  return { t, off: Math.hypot(off[0], 0.4 * off[1], 0.4 * off[2]) };
};

/** A pixel this far towards the partner (or past it), and this near the way to it, is the partner or its blend. */
const TOWARDS = 0.75;
const OFF = 15;

/**
 * On one line: of the places where a colour's strokes end (a stroke pixel whose neighbour is not of its colour), the
 * share where the partner colour lies within `reach` pixels on that side. Undefined with fewer than 20 ends.
 */
export const hugOn = (f: Frame, px: number[], lab: Lab, partner: Lab, reach: number): number | undefined => {
  if (dot(sub(partner, lab), sub(partner, lab)) < 400) return undefined;
  let ends = 0, met = 0;
  for (let j = 0; j < px.length; j += 2) {
    const i = px[j] ?? 0, x0 = i % f.w, y0 = Math.floor(i / f.w);
    for (const [dx, dy] of DIRS) {
      if (!inside(f, x0 + dx, y0 + dy)) continue;
      const first = labOf(f, (y0 + dy) * f.w + x0 + dx);
      if (dot(sub(first, lab), sub(first, lab)) <= NEAR * NEAR) continue;
      ends++;
      for (let k = 1; k <= reach && inside(f, x0 + dx * k, y0 + dy * k); k++) {
        const a = along(lab, partner, labOf(f, (y0 + dy * k) * f.w + x0 + dx * k));
        if (a.t >= TOWARDS && a.off <= OFF) { met++; break; }
      }
    }
  }
  return ends >= 20 ? met / ends : undefined;
};

/**
 * How closely a partner colour hugs a candidate's strokes over the lines it was found on: the lower quartile of
 * hugOn, so that it holds on nearly every line (0 when fewer than two lines tell).
 */
export const hugOf = (frames: Frame[], boxes: Rect[], px: number[][], at: (Lab | undefined)[], partner: Lab): number => {
  const shares = frames.flatMap((f, k) => {
    const lab = at[k], box = boxes[k];
    if (!lab || !box) return [];
    const s = hugOn(f, px[k] ?? [], lab, partner, Math.max(2, Math.round(0.1 * (box.y1 - box.y0))));
    return s === undefined ? [] : [s];
  }).sort((a, b) => a - b);
  return shares.length >= 2 ? (shares[Math.floor(shares.length / 4)] ?? 0) : 0;
};

/** A plate ends within this many line heights of its letters, on every side. */
const PLATE_REACH = 1.5;
/** A row (or column) at least this much of the plate's colour is inside the plate; under PAST, past its edge. */
const WITHIN = 0.7;
const PAST = 0.3;

/**
 * Where the letters are: the rows where their strokes are dense (a fifth of the fullest row or more, the run of them
 * around it), then the columns of the strokes in those rows (the first and the last hundredth). Strokes of the
 * picture's own colour around the line, which a loose box takes in, are sparse and left out.
 */
const inkOf = (f: Frame, px: number[]): Rect | undefined => {
  if (px.length < 20) return undefined;
  const rows = new Map<number, number>();
  for (const i of px) { const y = Math.floor(i / f.w); rows.set(y, (rows.get(y) ?? 0) + 1); }
  const peak = [...rows.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
  const dense = (y: number): boolean => (rows.get(y) ?? 0) >= 0.2 * peak[1];
  let y0 = peak[0], y1 = peak[0];
  while (dense(y0 - 1)) y0--;
  while (dense(y1 + 1)) y1++;
  const xs = px.filter((i) => { const y = Math.floor(i / f.w); return y >= y0 && y <= y1; }).map((i) => i % f.w).sort((a, b) => a - b);
  const q = (p: number): number => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
  return { x0: q(0.01), x1: q(0.99), y0, y1 };
};

/**
 * On one line: the plate around letters whose strokes are `px`, if `lab` makes one (h: the line's height). On each of
 * the four sides, outwards from the letters' extent, rows (or columns, away from the corners) mostly of that colour
 * start within a third of a line height, and a row that mostly is not follows within PLATE_REACH line heights. The
 * plate's pixels in those rows, which give its colour without the blends at the letters' edges; undefined when a side
 * does not end so.
 */
export const plateAround = (f: Frame, px: number[], lab: Lab, h: number): Seen[] | undefined => {
  const ink = inkOf(f, px);
  if (!ink) return undefined;
  const { x0, x1, y0, y1 } = ink, w = x1 - x0, tall = y1 - y0;
  const near = (x: number, y: number): boolean => { const d = sub(labOf(f, y * f.w + x), lab); return dot(d, d) <= NEAR * NEAR; };
  const span = (from: number, to: number): number[] => Array.from({ length: Math.max(0, Math.round(to) - Math.round(from)) }, (_v, j) => Math.round(from) + j);
  const across = span(x0 + 0.1 * w, x1 - 0.1 * w), down = span(y0 + 0.15 * tall, y1 - 0.15 * tall);
  const bands: ((d: number) => [number, number][])[] = [
    (d) => across.map((x) => [x, y0 - d]), (d) => across.map((x) => [x, y1 + d]),
    (d) => down.map((y) => [x0 - d, y]), (d) => down.map((y) => [x1 + d, y]),
  ];
  const seen: Seen[] = [];
  const ends = (band: (d: number) => [number, number][]): boolean => {
    let within = false;
    for (let d = 1; d <= Math.round(PLATE_REACH * h); d++) {
      const pts = band(d).filter(([x, y]) => inside(f, x, y));
      if (pts.length < 4) return false;
      const mine = pts.filter(([x, y]) => near(x, y)), s = mine.length / pts.length;
      if (within && s < PAST) return true;
      if (s >= WITHIN) { within = true; seen.push(...mine.map(([x, y]) => seenAt(f, y * f.w + x))); }
      else if (!within && d > h / 3) return false;
    }
    return false;
  };
  return bands.every(ends) ? seen : undefined;
};
