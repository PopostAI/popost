// Parts of this file are adapted from rea-video (https://github.com/JuneYaooo/rea-video), rea_video/transitions.py,
// Copyright 2026 JuneYaooo, licensed under the Apache License 2.0; rewritten in TypeScript, with changes. See NOTICE.
/**
 * Spans of boundaries: the last frame that is purely the old shot and the first that is purely the new one.
 * - activeSpan widens a hard cut over the frames around it that are not their shot's normal picture: changing much
 *   faster than the shot usually does (the travel of a spin, a shake), softer (a defocus into the cut) or flat (the
 *   colour a fade passes through).
 * - refineSpan tightens a rough span to the frames that are measurably mixed, against the noise of each shot.
 */
import type { Signals } from './signals';
import { detail, dist, viaOf } from './signals';
import { median } from './pixels';

export interface Span { start: number; end: number }

/** A frame is flat (a plain colour card or the black of a fade) below this per-channel standard deviation. */
export const FLAT = 6;

/** Flat black or white: what a fade passes through (a flat colour card in between is a shot). */
const isFlat = (s: Signals, m: number): boolean => viaOf(s, m) !== undefined;

/** Typical frame-to-frame change and detail of a shot over frames a..b (inclusive), or undefined when too few. */
const pace = (s: Signals, a: number, b: number): { change: number; detail: number } | undefined => {
  const ms: number[] = [];
  for (let m = Math.max(1, a); m <= b; m++) ms.push(m);
  if (ms.length < 3) return undefined;
  return { change: median(ms.map((m) => dist(s, m, m - 1))), detail: median(ms.map((m) => detail(s, m))) };
};

/**
 * Widens the cut at frame b ({b - 1, b}) within lo..hi (frames of the neighbouring boundaries). A cut inside a busy
 * stretch keeps its one frame: the shot is that busy everywhere.
 */
export const activeSpan = (s: Signals, b: number, lo: number, hi: number): Span => {
  const far = Math.max(2, Math.round(0.2 * s.fps)), reach = Math.max(4, Math.round(1.0 * s.fps));
  const flatReach = Math.max(2, Math.round(0.5 * s.fps));
  let start = b - 1, end = b;
  while (start - 1 > lo && b - 1 - start < flatReach && isFlat(s, start)) start--;
  while (end + 1 < hi && end - b < flatReach && isFlat(s, end)) end++;
  // flat as far as we look: a black or white card (a shot), not something a fade passes through
  if (b - 1 - start >= flatReach && isFlat(s, start)) start = b - 1;
  if (end - b >= flatReach && isFlat(s, end)) end = b;
  const old = pace(s, Math.max(lo + 1, start - reach), start - far);
  if (old) {
    const thr = Math.max(2.5 * old.change, old.change + 1.5);
    while (start - 1 > lo && b - 1 - start < reach && (dist(s, start, start - 1) > thr || detail(s, start) < 0.6 * old.detail)) start--;
  }
  const next = pace(s, end + far, Math.min(hi, end + reach));
  if (next) {
    const thr = Math.max(2.5 * next.change, next.change + 1.5);
    while (end + 1 < hi && end - b < reach && (dist(s, end + 1, end) > thr || detail(s, end) < 0.6 * next.detail)) end++;
  }
  return { start, end };
};

/** Median frame-to-frame change of the frames just before (side -1) or after (side +1) an anchor, within lo..hi. */
const noiseNear = (s: Signals, anchor: number, side: -1 | 1, lo: number, hi: number): number => {
  const ds: number[] = [];
  for (let k = 1; k <= 6; k++) {
    const m = anchor + side * k, prev = m - side;
    if (m < Math.max(lo, 0) || m > Math.min(hi, s.n - 1)) break;
    ds.push(dist(s, m, prev));
  }
  return ds.length ? median(ds) : 0;
};

/**
 * Moves rough ends outwards while the picture there is still changing faster than the shot's noise: a window found
 * on a grid of positions may end inside the tail of a ramp.
 */
const settle = (s: Signals, s0: number, e0: number, lo: number, hi: number): { s0: number; e0: number } => {
  const reach = Math.max(4, Math.round(0.5 * s.fps));
  const D = dist(s, s0, e0);
  const quietOld = Math.max(0.6, 2.5 * noiseNear(s, Math.max(lo, s0 - reach), -1, lo, hi)) + 0.01 * D;
  const quietNew = Math.max(0.6, 2.5 * noiseNear(s, Math.min(hi, e0 + reach), 1, lo, hi)) + 0.01 * D;
  let a = s0, b = e0;
  while (a - 1 > lo && s0 - a < reach && dist(s, a - 1, a) > quietOld) a--;
  while (b + 1 < hi && b - e0 < reach && dist(s, b, b + 1) > quietNew) b++;
  return { s0: a, e0: b };
};

/**
 * Tightens a rough span (s0 purely old, e0 purely new) to the frames that differ measurably from both ends: a frame
 * still counts as old while its distance to frame s0 stays under max(0.6, 2.5 x the old shot's frame-to-frame noise)
 * + 1.5% of the change across the span. The same from the other side. Also returns where the new picture takes over
 * (the first frame closer to the new end than to the old one).
 */
export const refineSpan = (s: Signals, s0In: number, e0In: number, lo: number, hi: number): Span & { takeover: number } => {
  if (e0In - s0In <= 1) return { start: s0In, end: e0In, takeover: e0In };
  const { s0, e0 } = settle(s, s0In, e0In, lo, hi);
  const D = dist(s, s0, e0);
  const tauA = Math.max(0.6, 2.5 * noiseNear(s, s0, -1, lo, hi)) + 0.015 * D;
  const tauB = Math.max(0.6, 2.5 * noiseNear(s, e0, 1, lo, hi)) + 0.015 * D;
  let takeover = e0;
  for (let m = s0 + 1; m <= e0; m++) if (dist(s, m, e0) < dist(s, m, s0)) { takeover = m; break; }
  let start = s0;
  for (let m = takeover - 1; m > s0; m--) if (dist(s, m, s0) <= tauA) { start = m; break; }
  let end = e0;
  for (let m = takeover; m < e0; m++) if (dist(s, m, e0) <= tauB) { end = m; break; }
  if (end <= start) return { start: takeover - 1, end: takeover, takeover };
  return { start, end, takeover: Math.min(Math.max(takeover, start + 1), end) };
};
