/**
 * The core of small letters. In a small or soft video (letters 30 to 45 pixels tall, enlarged or compressed hard) a
 * stroke is three or four pixels wide and most of its pixels are edge pixels: a blend of the fill with what is around
 * it. The most frequent colour of the strokes is then a grey, not the fill, and a one-pixel outline is seen as a mid
 * grey, not as its colour. Every blended pixel lies between two true colours, so the true colour is at the far end:
 * - the fill is the end of the strokes' colours away from what surrounds them (coreOf): from the measured colour the
 *   strokes are taken again and again around the tenth of them farthest from the surround, until it stops moving;
 * - an outline's colour is the end of the colours just past the strokes away from the fill (farEnd), as long as a
 *   sixth of them or more are there (a few darker pixels of the picture are not the outline);
 * - the weight: how wide a stroke is at half its contrast, against the height of the line (weightOf). Half contrast
 *   keeps the width under a blur.
 */
import { deltaE } from '../measure/colour';
import { labMedian, median, r2, rgbMedian, type Frame, type Lab, type Rect, type Rgb, type Seen } from './frame';
import { strokeMax, strokesOf } from './letters';

const sub = (a: Lab, b: Lab): Lab => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Lab, b: Lab): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rounds of moving to the far end, at most. */
const ROUNDS = 6;
/** The share of the strokes taken as their far end. */
const FAR = 0.1;

/** One line: the colour of its strokes' far end from `away`, starting at `lab`; undefined with too few stroke pixels. */
const coreOnLine = (f: Frame, box: Rect, lab: Lab, away: Lab): Seen | undefined => {
  let at = lab, rgb: Rgb | undefined;
  for (let round = 0; round < ROUNDS; round++) {
    const px = strokesOf(f, box, at, strokeMax(box));
    if (px.length < 12) break;
    const axis = sub(at, away), len = Math.hypot(...axis) || 1;
    const far = px.map((i) => ({ i, t: dot(sub([f.lab[3 * i] ?? 0, f.lab[3 * i + 1] ?? 0, f.lab[3 * i + 2] ?? 0], away), axis) / len }))
      .sort((a, b) => b.t - a.t || a.i - b.i).slice(0, Math.max(6, Math.round(FAR * px.length)));
    const next = labMedian(far.map((x) => [f.lab[3 * x.i] ?? 0, f.lab[3 * x.i + 1] ?? 0, f.lab[3 * x.i + 2] ?? 0]));
    rgb = rgbMedian(far.map((x) => [f.rgb[3 * x.i] ?? 0, f.rgb[3 * x.i + 1] ?? 0, f.rgb[3 * x.i + 2] ?? 0]));
    const moved = deltaE(next, at);
    at = next;
    if (moved < 1.5) break;
  }
  return rgb ? { lab: at, rgb } : undefined;
};

/**
 * The fill's core over the lines it was found on: the colour most lines agree on (within ΔE 10 of the median), and
 * the share of lines that do. at[k] is the measured fill on line k; away is what surrounds the strokes.
 */
export const coreOf = (frames: Frame[], boxes: Rect[], at: (Lab | undefined)[], away: Lab): { rgb: Rgb; lab: Lab; share: number } | undefined => {
  const cores = frames.flatMap((f, k) => {
    const lab = at[k], box = boxes[k];
    const core = lab && box ? coreOnLine(f, box, lab, away) : undefined;
    return core ? [core] : [];
  });
  if (cores.length < 2) return undefined;
  const mid = labMedian(cores.map((c) => c.lab));
  const alike = cores.filter((c) => deltaE(c.lab, mid) <= 10);
  if (alike.length < 2) return undefined;
  return { rgb: rgbMedian(alike.map((c) => c.rgb)), lab: labMedian(alike.map((c) => c.lab)), share: r2(alike.length / cores.length) };
};

/**
 * The far end of some seen colours from `away`: the median is moved to the quarter farthest from `away` among the
 * colours near it, while a sixth of all of them or more are still near it.
 */
export const farEnd = (seen: Seen[], away: Lab): Seen | undefined => {
  if (seen.length < 20) return undefined;
  let at = labMedian(seen.map((x) => x.lab)), rgb: Rgb = rgbMedian(seen.map((x) => x.rgb));
  for (let round = 0; round < ROUNDS; round++) {
    const axis = sub(at, away), len = Math.hypot(...axis) || 1;
    const near = seen.filter((x) => deltaE(x.lab, at) <= 20).map((x) => ({ x, t: dot(sub(x.lab, away), axis) / len })).sort((a, b) => b.t - a.t);
    const far = near.slice(0, Math.max(5, Math.round(near.length / 4))).map((n) => n.x);
    const next = labMedian(far.map((x) => x.lab));
    if (seen.filter((x) => deltaE(x.lab, next) <= 14).length < seen.length / 6) break;
    const moved = deltaE(next, at);
    at = next; rgb = rgbMedian(far.map((x) => x.rgb));
    if (moved < 1.5) break;
  }
  return { lab: at, rgb };
};

/** A stroke this wide or wider, as a share of the reader's box height, is heavy (bold or heavier); thinner is regular. */
export const HEAVY_STROKE = 0.085;

/**
 * How wide the strokes are: runs of pixels nearer the core than the surround (half contrast), across and down, no
 * longer than a stroke can be; the median run of the thinner direction, over the lines, as a share of the box height.
 */
export const weightOf = (frames: Frame[], boxes: Rect[], core: Lab, away: Lab, lines?: number[]): { stroke: number; weight: 'heavy' | 'regular' } | undefined => {
  const axis = sub(core, away), len2 = dot(axis, axis) || 1;
  const shares: number[] = [];
  frames.forEach((f, k) => {
    const box = boxes[k];
    if (!box || (lines && !lines.includes(k))) return;
    const x0 = Math.max(0, Math.round(box.x0)), x1 = Math.min(f.w, Math.round(box.x1)), y0 = Math.max(0, Math.round(box.y0)), y1 = Math.min(f.h, Math.round(box.y1));
    const max = strokeMax(box), runs: { across: number[]; down: number[] } = { across: [], down: [] };
    const ink = (x: number, y: number): boolean => {
      const i = 3 * (y * f.w + x);
      const t = dot(sub([f.lab[i] ?? 0, f.lab[i + 1] ?? 0, f.lab[i + 2] ?? 0], away), axis) / len2;
      return t >= 0.5 && t <= 1.5;
    };
    const scan = (outer: [number, number], inner: [number, number], at: (o: number, i: number) => boolean, into: number[]): void => {
      for (let o = outer[0]; o < outer[1]; o++) {
        let run = 0;
        for (let i = inner[0]; i <= inner[1]; i++) {
          if (i < inner[1] && at(o, i)) { run++; continue; }
          if (run > 0 && run <= max) into.push(run);
          run = 0;
        }
      }
    };
    scan([y0, y1], [x0, x1], (y, x) => ink(x, y), runs.across);
    scan([x0, x1], [y0, y1], (x, y) => ink(x, y), runs.down);
    if (runs.across.length < 8 || runs.down.length < 8) return;
    shares.push(Math.min(median(runs.across), median(runs.down)) / Math.max(1, box.y1 - box.y0));
  });
  if (shares.length < 2) return undefined;
  const stroke = r2(median(shares));
  return { stroke, weight: stroke >= HEAVY_STROKE ? 'heavy' : 'regular' };
};
