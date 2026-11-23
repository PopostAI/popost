// Parts of this file are adapted from rea-video (https://github.com/JuneYaooo/rea-video), rea_video/motion.py,
// Copyright 2026 JuneYaooo, licensed under the Apache License 2.0; rewritten in TypeScript, with changes. See NOTICE.
/**
 * Motion events of a shot: elements that appear, disappear or change while the background holds. Frames sampled at
 * up to 15 per second are divided into 4 x 4 pixel cells; each cell's bursts of change are stamped with when they
 * start and stop, grouped by start time and then by place. Each group is then followed on every native frame of the
 * small thumbnails (profile.ts) for its exact start and end, how it enters, its direction, ease and colour.
 * Whole-frame changes (a camera move, a transition, a flash) are steps where more than half of the cells change,
 * and are skipped; cells that change through most of the shot are a moving layer, not events.
 */
import type { MotionEvent } from '../types';
import { profileCrop } from './profile';
import { clamp, grayOf, round } from './pixels';
import { align } from './align';
import { gaussBlur } from './robust';

export interface MotionInput {
  /** Samples of the shot's clean interior at up to 15 fps: rgb, w x h, and the native frame of each. */
  w: number;
  h: number;
  rgb: readonly Uint8Array[];
  frames: readonly number[];
  /** Every native frame of the video as small rgb thumbnails (for timing and the profile of each event). */
  tw: number;
  th: number;
  thumbs: readonly Uint8Array[];
  fps: number;
  /** The camera moves: compare each sample with the next one carried back by the global motion between them. */
  moving?: boolean;
}

const CELL = 4;
/** A pixel changes when a channel moves by more than this; a cell is active when more than 15% of its pixels do. */
const DIFF = 12;
const ACTIVE = 0.15;
/** A step with more than half of the cells active is a whole-frame change. */
const GLOBAL = 0.5;
/** A cell active in more than 70% of the steps belongs to a moving layer. */
const LAYER = 0.7;
/** Events smaller than this share of the frame are dropped. */
const MIN_AREA = 0.002;
/**
 * An event must change its pixels by more than an encoder does to a still picture: a key frame or a lower bitrate
 * moves the fine areas of a frame by 12 to 25 levels at once (crf 32 at half size), which reads as faint, instant
 * changes in small boxes. The confidence below (0.3 + contrast / 100, times 0.7 for fewer than four cells) is under
 * 0.55 for a contrast under 25 levels, or under 49 on fewer than four cells.
 */
const MIN_CONFIDENCE = 0.55;
export const MAX_EVENTS = 24;

interface Burst { cell: number; b0: number; b1: number }

/** Frame b resampled at the places where frame a's pixels went (nearest pixel), so a camera move cancels out. */
const carryBack = (a: Uint8Array, b: Uint8Array, w: number, h: number): Uint8Array => {
  const g = align(grayOf(a), grayOf(b), w, h, {});
  if (!(g.residual < 0.8 * g.before)) return b;
  const out = new Uint8Array(b.length);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, c = g.scale * Math.cos(g.angle), s = g.scale * Math.sin(g.angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = Math.round(cx + c * (x - cx) - s * (y - cy) + g.tx), qy = Math.round(cy + s * (x - cx) + c * (y - cy) + g.ty);
      const src = qx >= 0 && qy >= 0 && qx < w && qy < h ? (qy * w + qx) * 3 : (y * w + x) * 3;
      const from = qx >= 0 && qy >= 0 && qx < w && qy < h ? b : a;
      out[(y * w + x) * 3] = from[src] as number; out[(y * w + x) * 3 + 1] = from[src + 1] as number; out[(y * w + x) * 3 + 2] = from[src + 2] as number;
    }
  }
  return out;
};

/** Log2 gain bins: -1 .. 1 in steps of 0.01. */
const GAIN_BINS = 201;

/**
 * Per-channel gain from a to b over most of the picture (the median ratio over pixels brighter than 40, from a
 * histogram), so light that dims or brightens the whole shot is not an element changing. 1 when within 2%.
 */
const gainsOf = (a: Uint8Array, b: Uint8Array): number[] =>
  [0, 1, 2].map((c) => {
    const hist = new Uint32Array(GAIN_BINS);
    let n = 0;
    for (let i = c; i < a.length; i += 3) {
      const x = a[i] as number;
      if (x < 40) continue;
      const r = Math.log2(((b[i] as number) + 1) / (x + 1));
      const k = Math.round((clamp(r, -1, 1) + 1) * 100);
      hist[k] = (hist[k] as number) + 1;
      n++;
    }
    if (n < a.length / 15) return 1;
    let acc = 0, k = 0;
    while (k < GAIN_BINS - 1 && acc + (hist[k] as number) < n / 2) acc += hist[k++] as number;
    const g = 2 ** (k / 100 - 1);
    return Math.abs(g - 1) <= 0.02 ? 1 : g;
  });

/**
 * How far pixel i of the carried-back frame b falls outside the range of frame a's 3 x 3 neighbourhood around it
 * (largest channel): resampling half a pixel off on a sharp edge stays inside that range.
 */
const outsideNeighbours = (a: Uint8Array, b: Uint8Array, w: number, h: number, x: number, y: number): number => {
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    let lo = 255, hi = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -1; dx <= 1; dx++) {
        const v = a[(yy * w + Math.min(w - 1, Math.max(0, x + dx))) * 3 + c] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const v = b[(y * w + x) * 3 + c] as number;
    worst = Math.max(worst, v - hi, lo - v);
  }
  return worst;
};

/**
 * Whether each pixel of the step a -> b changed. With a moving camera a pixel must change both on screen and after
 * the camera move is taken out: the background only moves, and a title that holds still on screen only moves
 * against the background.
 */
const changedPixels = (m: MotionInput, a: Uint8Array, raw: Uint8Array): (x: number, y: number) => boolean => {
  const [g0, g1, g2] = gainsOf(a, raw) as [number, number, number];
  const onScreen = (i: number): number =>
    Math.max(Math.abs(g0 * (a[i] as number) - (raw[i] as number)), Math.abs(g1 * (a[i + 1] as number) - (raw[i + 1] as number)), Math.abs(g2 * (a[i + 2] as number) - (raw[i + 2] as number)));
  if (!m.moving) return (x, y) => onScreen((y * m.w + x) * 3) > DIFF;
  const carried = carryBack(a, raw, m.w, m.h);
  return (x, y) => onScreen((y * m.w + x) * 3) > DIFF && outsideNeighbours(a, carried, m.w, m.h, x, y) > DIFF;
};

/**
 * Each sample softened by a Gaussian of SOFTEN pixels before frames are compared: compression noise (blocking, ringing,
 * the jump of quality at a key frame) is fine detail that a lower bitrate or a smaller size changes from frame to frame,
 * while an element is many pixels across. A re-encode of the same video then changes the same cells.
 */
const SOFTEN = 1;

const soften = (rgb: Uint8Array, w: number, h: number): Uint8Array => {
  const out = new Uint8Array(rgb.length);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = rgb[i * 3 + c] as number;
    const g = gaussBlur(plane, w, h, SOFTEN, false);
    for (let i = 0; i < w * h; i++) out[i * 3 + c] = Math.round(g[i] as number);
  }
  return out;
};

const activity = (m: MotionInput, gw: number, gh: number): Uint8Array[] => {
  const steps: Uint8Array[] = [];
  const soft = m.rgb.map((f) => soften(f, m.w, m.h));
  for (let t = 0; t + 1 < m.rgb.length; t++) {
    const changed = changedPixels({ ...m, rgb: soft }, soft[t] as Uint8Array, soft[t + 1] as Uint8Array);
    const hits = new Uint16Array(gw * gh);
    for (let y = 0; y < gh * CELL; y++) {
      for (let x = 0; x < gw * CELL; x++) {
        if (changed(x, y)) { const c = Math.floor(y / CELL) * gw + Math.floor(x / CELL); hits[c] = (hits[c] as number) + 1; }
      }
    }
    steps.push(Uint8Array.from(hits, (v) => (v > ACTIVE * CELL * CELL ? 1 : 0)));
  }
  return steps;
};

/** Runs of activity per cell (gaps of up to 'gap' steps joined), skipping whole-frame steps and layer cells. */
const bursts = (act: Uint8Array[], cells: number, gap: number): Burst[] => {
  const global = act.map((s) => s.reduce((x, y) => x + y, 0) > GLOBAL * cells);
  const usable = global.filter((g) => !g).length;
  const out: Burst[] = [];
  for (let c = 0; c < cells; c++) {
    const on: number[] = [];
    act.forEach((s, t) => { if (!global[t] && s[c]) on.push(t); });
    if (!on.length || on.length > LAYER * usable) continue;
    let b0 = on[0] as number, b1 = b0;
    for (const t of on.slice(1)) {
      if (t - b1 > gap + 1) { out.push({ cell: c, b0, b1 }); b0 = t; }
      b1 = t;
    }
    out.push({ cell: c, b0, b1 });
  }
  return out.sort((a, b) => a.b0 - b.b0 || a.cell - b.cell);
};

/** Bursts that start together (a chain of starts at most 'gap' steps apart) and touch in space (8 neighbours, one cell of slack). */
const groups = (bs: Burst[], gw: number, gap: number): Burst[][] => {
  const timeGroups: Burst[][] = [];
  for (const b of bs) {
    const g = timeGroups[timeGroups.length - 1];
    if (g && b.b0 - (g[g.length - 1] as Burst).b0 <= gap) g.push(b);
    else timeGroups.push([b]);
  }
  return timeGroups.flatMap((g) => {
    const left = new Map(g.map((b) => [b.cell, b]));
    const out: Burst[][] = [];
    for (const seed of g) {
      if (!left.has(seed.cell)) continue;
      const comp: Burst[] = [];
      const queue = [seed.cell];
      left.delete(seed.cell);
      while (queue.length) {
        const c = queue.pop() as number;
        comp.push(g.find((b) => b.cell === c) as Burst);
        const cx = c % gw, cy = Math.floor(c / gw);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const k = (cy + dy) * gw + (cx + dx);
          if (cx + dx >= 0 && cx + dx < gw && left.has(k)) { left.delete(k); queue.push(k); }
        }
      }
      out.push(comp);
    }
    return out;
  });
};

const cropThumbs = (m: MotionInput, box: [number, number, number, number], from: number, to: number): { w: number; h: number; frames: Uint8Array[]; x0: number; y0: number } => {
  const x0 = clamp(Math.floor(box[0] * m.tw), 0, m.tw - 1), y0 = clamp(Math.floor(box[1] * m.th), 0, m.th - 1);
  const x1 = clamp(Math.ceil((box[0] + box[2]) * m.tw), x0 + 1, m.tw), y1 = clamp(Math.ceil((box[1] + box[3]) * m.th), y0 + 1, m.th);
  const w = x1 - x0, h = y1 - y0;
  const frames: Uint8Array[] = [];
  for (let f = from; f <= to; f++) {
    const src = m.thumbs[f] as Uint8Array, out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * m.tw + x0) * 3, ((y0 + y) * m.tw + x1) * 3), y * w * 3);
    frames.push(out);
  }
  return { w, h, frames, x0, y0 };
};

const toEvent = (m: MotionInput, comp: Burst[], gw: number, gh: number): (MotionEvent & { rank: number }) | undefined => {
  const cx = comp.map((b) => b.cell % gw), cy = comp.map((b) => Math.floor(b.cell / gw));
  const pad = 0.02;
  const box: [number, number, number, number] = [Math.max(0, Math.min(...cx) / gw - pad), Math.max(0, Math.min(...cy) / gh - pad), 0, 0];
  box[2] = Math.min(1, (Math.max(...cx) + 1) / gw + pad) - box[0];
  box[3] = Math.min(1, (Math.max(...cy) + 1) / gh + pad) - box[1];
  const t0 = Math.min(...comp.map((b) => b.b0)), t1 = Math.max(...comp.map((b) => b.b1));
  const from = m.frames[t0] as number, to = m.frames[Math.min(m.frames.length - 1, t1 + 1)] as number;
  const crop = cropThumbs(m, box, from, to);
  const p = profileCrop(crop);
  if (!p) return undefined;
  const fb: [number, number, number, number] = [
    (crop.x0 + p.box[0] * crop.w) / m.tw, (crop.y0 + p.box[1] * crop.h) / m.th, (p.box[2] * crop.w) / m.tw, (p.box[3] * crop.h) / m.th,
  ];
  if (fb[2] * fb[3] < MIN_AREA || (p.kind === 'change' && fb[2] * fb[3] > 0.5)) return undefined;
  // a change that runs through most of the shot, any change over a moving camera, or anything over a moving camera
  // that takes half the shot, is the background drifting
  const shotLength = (m.frames[m.frames.length - 1] as number) - (m.frames[0] as number) + 1;
  if (p.kind === 'change' && (m.moving || p.end - p.start > 0.6 * shotLength)) return undefined;
  if (m.moving && p.end - p.start > 0.5 * shotLength) return undefined;
  const confidence = clamp(0.3 + p.contrast / 100, 0.3, 0.95) * (comp.length >= 4 ? 1 : 0.7);
  if (confidence < MIN_CONFIDENCE) return undefined;
  return {
    start: from + p.start, end: from + p.end, box: [round(fb[0], 3), round(fb[1], 3), round(fb[2], 3), round(fb[3], 3)], kind: p.kind, how: p.how,
    ...(p.direction ? { direction: p.direction } : {}), ease: p.ease, ...(p.overshoot ? { overshoot: p.overshoot } : {}), ...(p.colour ? { colour: p.colour } : {}),
    confidence: round(confidence, 3), rank: fb[2] * fb[3] * (p.end - p.start + 1),
  };
};

/**
 * Lines of one element: events of the same kind and manner that start and end on the same frames (within one), stacked
 * in one column (their spans across overlap by half the narrower) with a gap under the taller one's height between
 * them. A title that wraps onto three lines enters as one element, not three.
 */
const sameElement = (a: MotionEvent, b: MotionEvent): boolean => {
  if (a.kind !== b.kind || a.how !== b.how || Math.abs(a.start - b.start) > 1 || Math.abs(a.end - b.end) > 1) return false;
  const across = Math.min(a.box[0] + a.box[2], b.box[0] + b.box[2]) - Math.max(a.box[0], b.box[0]);
  const gap = Math.max(a.box[1], b.box[1]) - Math.min(a.box[1] + a.box[3], b.box[1] + b.box[3]);
  return across >= 0.5 * Math.min(a.box[2], b.box[2]) && gap <= Math.max(a.box[3], b.box[3]);
};

const union = (a: MotionEvent & { rank: number }, b: MotionEvent & { rank: number }): MotionEvent & { rank: number } => {
  const x0 = Math.min(a.box[0], b.box[0]), y0 = Math.min(a.box[1], b.box[1]);
  const x1 = Math.max(a.box[0] + a.box[2], b.box[0] + b.box[2]), y1 = Math.max(a.box[1] + a.box[3], b.box[1] + b.box[3]);
  const big = a.box[2] * a.box[3] >= b.box[2] * b.box[3] ? a : b;
  return { ...big, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), box: [round(x0, 3), round(y0, 3), round(x1 - x0, 3), round(y1 - y0, 3)], rank: a.rank + b.rank };
};

/** Joins the lines of one element (sameElement) until no two can be joined. */
const joinLines = (events: Array<MotionEvent & { rank: number }>): Array<MotionEvent & { rank: number }> => {
  const out = [...events];
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (!sameElement(out[i] as MotionEvent, out[j] as MotionEvent)) continue;
      out[i] = union(out[i] as MotionEvent & { rank: number }, out[j] as MotionEvent & { rank: number });
      out.splice(j, 1);
      j = i;
    }
  }
  return out;
};

/** Motion events of one shot, the largest MAX_EVENTS kept, in order of start. */
export const measureEvents = (m: MotionInput): MotionEvent[] => {
  if (m.rgb.length < 3) return [];
  const gw = Math.floor(m.w / CELL), gh = Math.floor(m.h / CELL);
  const fps2 = m.fps / Math.max(1, (m.frames[1] as number) - (m.frames[0] as number));
  const gap = Math.max(1, Math.round(0.15 * fps2));
  const bs = bursts(activity(m, gw, gh), gw * gh, gap);
  const events = joinLines(groups(bs, gw, Math.max(2, Math.round(0.2 * fps2)))
    .filter((g) => g.length >= 2 && g.length >= MIN_AREA * gw * gh)
    .map((g) => toEvent(m, g, gw, gh))
    .filter((e): e is MotionEvent & { rank: number } => e !== undefined));
  return events
    .sort((a, b) => b.rank - a.rank || a.start - b.start)
    .slice(0, MAX_EVENTS)
    .sort((a, b) => a.start - b.start || a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map(({ rank: _rank, ...e }) => e);
};
