// Parts of this file are adapted from rea-video (https://github.com/JuneYaooo/rea-video), rea_video/transitions.py,
// Copyright 2026 JuneYaooo, licensed under the Apache License 2.0; rewritten in TypeScript, with changes. See NOTICE.
/**
 * What kind of transition a span holds. The models of fits.ts and a few measures of movement and sharpness are
 * computed for the in-between frames, then a fixed order of rules picks the kind. When nothing fits well the best
 * guess is returned with a low confidence; a dissolve is not the fallback.
 */
import type { Direction, TransitionKind, WipeDirection } from '../types';
import type { Thumbs } from './pixels';
import { clamp, median, resample } from './pixels';
import type { Signals } from './signals';
import { detail, dist, viaOf } from './signals';
import type { BlendFit, EdgeFit, Img, RegionFit, VeilFit } from './fits';
import { edgeShape, fitBlend, fitEdge, fitRegion, fitScaledBlend, fitVeil } from './fits';
import { align } from './align';
import { rotationBetween } from './orientation';
import { GLITCH_VERTICAL, oneSidedKind, readSwitch, switchKind, type SwitchReading } from './switch';
import { isFlatSideZoom } from './unmix';

export interface Classified {
  kind: TransitionKind;
  direction?: WipeDirection;
  mode?: 'push' | 'cover' | 'reveal';
  via?: 'black' | 'white';
  confidence: number;
  /** Where the new shot takes over, when the kind says (fade: after the flat frame; wipe: half the frame new). */
  takeover?: number;
  /** No model explained the span: the kind is the closest model's, at a low confidence. */
  guessed?: boolean;
  /**
   * What the kind's model leaves unexplained of the in-between frames, 0..1, relative to the change across the span
   * (fits.ts), or the share of frames no reading of the switch explains (switch.ts). Absent for a cut.
   */
  residual?: number;
  /** A moving edge only: how far apart the edge stands across its travel, as a share of the frame (edgeShape). */
  bend?: number;
}

export interface Features {
  inner: number[];
  veil: VeilFit;
  blend: BlendFit;
  edge?: EdgeFit;
  region?: RegionFit;
  /** Largest turn of an in-between frame against the nearer end, degrees. */
  rotation: number;
  /** Largest |ln scale| of an in-between frame against the nearer end. */
  zoom: number;
  /** Camera-like travel over the span from consecutive frames, as shares of the frame. */
  path: number;
  net: number;
  heading: Direction;
  /** Least detail across (x) and down (y) inside the span, relative to the two ends. */
  rx: number;
  ry: number;
  softBoth: boolean;
  backSwings: number;
  jumps: number;
  /** Some in-between frame is a mix of both pictures (blend weight between 0.15 and 0.85), not one picture moved. */
  mixed: boolean;
  /** Scaled-blend fit (zoom): residual relative to the plain blend, the largest scale it used, and its own residual. */
  zoomFit: { gain: number; scale: number; residual: number };
  /** Summed |shift| across and down between consecutive frames, shares of the frame. */
  pathX: number;
  pathY: number;
  /** The straight edge's residual found to the pixel, and how far apart the edge stands across its travel (edgeShape). */
  edgeShape?: { refined: number; bend: number };
}

/** Up to n frames of a list, spread evenly. */
const spread = (all: number[], n: number): number[] =>
  all.length <= n ? all : [...new Set(Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / (n - 1))] as number))];

/**
 * In-between frames used for fitting: those where the two pictures share the frame (progress by distance between
 * 0.08 and 0.92). The frames near either end fit every model, so they would only blur the comparison. At least the
 * two frames nearest the middle are kept.
 */
const pickInner = (sg: Signals, start: number, end: number): number[] => {
  const all: number[] = [];
  for (let m = start + 1; m < end; m++) all.push(m);
  const u = (m: number): number => { const a = dist(sg, m, start), b = dist(sg, m, end); return a / (a + b + 1e-6); };
  const central = all.filter((m) => u(m) > 0.08 && u(m) < 0.92);
  if (central.length >= 2 || all.length < 2) return spread(central.length ? central : all, 9);
  return [...all].sort((x, y) => Math.abs(u(x) - 0.5) - Math.abs(u(y) - 0.5) || x - y).slice(0, 2).sort((x, y) => x - y);
};

const allInner = (start: number, end: number): number[] => Array.from({ length: Math.max(0, end - start - 1) }, (_, i) => start + 1 + i);

const fitImg = (t: Thumbs, m: number): Img => {
  const w = Math.max(8, t.width >> 1), h = Math.max(8, t.height >> 1);
  return { w, h, data: resample(t.rgb[m] as Uint8Array, t.width, t.height, 3, w, h) };
};

const travel = (t: Thumbs, start: number, end: number): { path: number; net: number; heading: Direction; pathX: number; pathY: number } => {
  let path = 0, nx = 0, ny = 0, pathX = 0, pathY = 0;
  for (let m = start; m < end; m++) {
    const a = align(t.gray[m] as Uint8Array, t.gray[m + 1] as Uint8Array, t.width, t.height, { search: true });
    if (a.coverage < 0.4 || a.texture < 1.5 || !(a.residual < 0.6 * a.before) || Math.abs(Math.log(a.scale)) > 0.05) continue;
    const dx = a.tx / t.width, dy = a.ty / t.height;
    path += Math.hypot(dx, dy);
    pathX += Math.abs(dx);
    pathY += Math.abs(dy);
    nx += dx;
    ny += dy;
  }
  const heading: Direction = Math.abs(nx) >= Math.abs(ny) ? (nx < 0 ? 'left' : 'right') : ny < 0 ? 'up' : 'down';
  return { path, net: Math.hypot(nx, ny), heading, pathX, pathY };
};

/** Smallest scale at which a copy of a w x h picture turned by deg degrees still covers the frame. */
const coverScale = (deg: number, w: number, h: number): number => {
  const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
};

/**
 * Turn of frame m against frame ref in degrees, confirmed by a rotating fit that explains the picture (the
 * orientation histogram alone is fooled by a blend of two pictures with different edges). 0 when not confirmed.
 */
const confirmedTurn = (t: Thumbs, sg: Signals, ref: number, m: number): number => {
  const a = t.gray[ref] as Uint8Array, b = t.gray[m] as Uint8Array;
  // turning keeps a picture sharp (the cover scale softens it a little); a smeared or flat frame is something else
  if (detail(sg, m) < 0.3 * detail(sg, ref) || detail(sg, ref) < 2) return 0;
  const guess = rotationBetween(a, b, t.width, t.height);
  if (Math.abs(guess) < 12) return 0;
  let best = 0;
  for (const deg of [guess, -guess]) {
    const fit = align(a, b, t.width, t.height, { rotation: true, init: { scale: coverScale(deg, t.width, t.height), angle: (deg * Math.PI) / 180, tx: 0, ty: 0 } });
    const turn = Math.abs((fit.angle * 180) / Math.PI);
    if (fit.coverage > 0.3 && fit.residual < 0.45 * fit.before && turn >= 12 && fit.scale > 0.7 && fit.scale < 2.5) best = Math.max(best, turn);
  }
  return best;
};

/** Scale and turn of each in-between frame against the nearer end (old before the takeover, new after). */
const warps = (t: Thumbs, sg: Signals, start: number, end: number, inner: number[]): { zoom: number; rotation: number } => {
  let zoom = 0, rotation = 0;
  for (const m of inner) {
    const ref = dist(sg, m, start) <= dist(sg, m, end) ? start : end;
    rotation = Math.max(rotation, confirmedTurn(t, sg, ref, m));
    // a scale is only believed between two textured frames and within a plausible range (a flat frame fits anything)
    if (detail(sg, m) < 0.3 * detail(sg, ref) || detail(sg, ref) < 2) continue;
    const a = align(t.gray[ref] as Uint8Array, t.gray[m] as Uint8Array, t.width, t.height, { search: true });
    if (a.coverage > 0.3 && a.residual < 0.6 * a.before && a.scale > 0.6 && a.scale < 1.8) zoom = Math.max(zoom, Math.abs(Math.log(a.scale)));
  }
  return { zoom, rotation };
};

/**
 * Detail of the in-between frames against the detail a plain mix of the two ends would have at the same progress
 * (a frame 30% of the way is expected to be as sharp as 0.7 A + 0.3 B). rx: across (x), ry: down (y). softBoth: the
 * frames lose detail on both sides of the switch (out of focus and back), not only running into it.
 */
const softness = (sg: Signals, start: number, end: number, inner: number[]): { rx: number; ry: number; softBoth: boolean } => {
  const expect = (arr: Float32Array, m: number): number => {
    const da = dist(sg, m, start), db = dist(sg, m, end), u = da / (da + db + 1e-6);
    return (1 - u) * (arr[start] as number) + u * (arr[end] as number) + 1e-6;
  };
  const ratio = (m: number): number => ((sg.dx[m] as number) + (sg.dy[m] as number)) / (expect(sg.dx, m) + expect(sg.dy, m));
  const rx = Math.min(...inner.map((m) => (sg.dx[m] as number) / expect(sg.dx, m)));
  const ry = Math.min(...inner.map((m) => (sg.dy[m] as number) / expect(sg.dy, m)));
  const oldSide = inner.filter((m) => dist(sg, m, start) <= dist(sg, m, end)), newSide = inner.filter((m) => dist(sg, m, start) > dist(sg, m, end));
  const soft = (ms: number[]): boolean => ms.length > 0 && Math.min(...ms.map(ratio)) < 0.6;
  const textured = (sg.dx[start] as number) + (sg.dy[start] as number) > 2 && (sg.dx[end] as number) + (sg.dy[end] as number) > 2;
  return { rx, ry, softBoth: textured && soft(oldSide) && soft(newSide) };
};

const swings = (sg: Signals, start: number, end: number): { backSwings: number; jumps: number } => {
  const D = dist(sg, start, end) + 1e-6;
  let backSwings = 0, jumps = 0, prev = 0;
  for (let m = start + 1; m <= end; m++) {
    const da = dist(sg, m, start), db = dist(sg, m, end);
    const u = da / (da + db + 1e-6);
    if (u < prev - 0.25) backSwings++;
    if (dist(sg, m, m - 1) > 0.5 * D) jumps++;
    prev = u;
  }
  return { backSwings, jumps };
};

export const features = (t: Thumbs, sg: Signals, start: number, end: number): Features => {
  const f = rawFeatures(t, sg, start, end);
  return { ...f, mixed: f.blend.alpha.some((a) => a > 0.15 && a < 0.85) && f.blend.residual < 0.5 };
};

const rawFeatures = (t: Thumbs, sg: Signals, start: number, end: number): Features => {
  const inner = pickInner(sg, start, end);
  const every = spread(allInner(start, end), 12);
  const blocks = (m: number): Float32Array => sg.small[m] as Float32Array;
  const A = blocks(start), B = blocks(end), mids = inner.map(blocks);
  const fa = fitImg(t, start), fb = fitImg(t, end), fm = inner.map((m) => fitImg(t, m));
  const edge = fitEdge(fa, fb, fm);
  return {
    inner,
    veil: fitVeil(A, B, mids),
    blend: fitBlend(A, B, mids),
    edge,
    region: fitRegion(A, B, mids, sg.sw, sg.sh),
    ...warps(t, sg, start, end, every),
    ...travel(t, start, end),
    ...softness(sg, start, end, every),
    ...swings(sg, start, end),
    mixed: false,
    zoomFit: fitScaledBlend(fa, fb, fm),
    ...(edge ? { edgeShape: edgeShape(fa, fb, fm, edge) } : {}),
  };
};

/** The new picture takes over at the first in-between frame where the given progress reaches one half. */
const takeoverAt = (inner: number[], progress: number[], end: number): number => {
  const i = progress.findIndex((p) => p >= 0.5);
  return i < 0 ? end : (inner[i] as number);
};

const isVia = (sg: Signals, m: number, via: 'black' | 'white'): boolean => viaOf(sg, m) === via;

/**
 * A veil of black takes the picture darker than both of its ends, and a veil of white lighter: a dissolve from a light
 * shot to a dark one passes through every level in between but never below the dark end. The margin is a quarter of
 * the room left below the darker end (above the lighter one), at least 2 levels.
 */
const beyondEnds = (sg: Signals, start: number, end: number, via: 'black' | 'white'): boolean => {
  let lo = Infinity, hi = -Infinity;
  for (let m = start + 1; m < end; m++) { lo = Math.min(lo, sg.luma[m] as number); hi = Math.max(hi, sg.luma[m] as number); }
  const a = sg.luma[start] as number, b = sg.luma[end] as number;
  if (via === 'black') return Math.min(a, b) - lo >= Math.max(2, 0.25 * Math.min(a, b));
  return hi - Math.max(a, b) >= Math.max(2, 0.25 * (255 - Math.max(a, b)));
};

const veilKind = (f: Features, sg: Signals, start: number, end: number): Classified | undefined => {
  const { veil } = f;
  if (veil.residual > 0.2 || Math.max(...veil.opacity) < 0.6 || isVia(sg, start, veil.via) || isVia(sg, end, veil.via)) return undefined;
  if (!beyondEnds(sg, start, end, veil.via)) return undefined;
  const i = veil.isNew.findIndex(Boolean);
  const takeover = i < 0 ? end : (f.inner[i] as number);
  const confidence = clamp(1 - veil.residual / 0.3, 0.3, 1);
  // A flash holds full white around the switch for about a third of its span: its veil is 1.5 times the triangle of a
  // fade, clipped at 1 (presets/transition.ts). A fade through white reaches full white on one frame at most, and on
  // none when its length is even (its peak is F / (F + 1)): a veil that stays under full white is a fade.
  const opaque = veil.opacity.flatMap((o, k) => (o >= 0.95 ? [k] : []));
  const plateau = opaque.length;
  // no picture shows through full white, so which side a white frame is on cannot be read: a flash is symmetric about
  // its switch, which is the middle of its white plateau
  const middle = plateau >= 2 ? (f.inner[(opaque[0] as number) + Math.ceil(((opaque[plateau - 1] as number) - (opaque[0] as number)) / 2)] as number) : takeover;
  if (veil.via === 'white' && plateau >= 2 && plateau >= 0.2 * veil.opacity.length) return { kind: 'flash', confidence, takeover: middle, residual: veil.residual };
  return { kind: 'fade', via: veil.via, confidence, takeover, residual: veil.residual };
};

/** How well the straight edge fits, found to the pixel, and how bent the edge is (edgeShape). */
const edgeFit = (f: Features): { residual: number; bend?: number } =>
  f.edgeShape ? { residual: f.edgeShape.refined, bend: f.edgeShape.bend } : { residual: f.edge?.residual ?? 1 };

const edgeKind = (f: Features): Classified | undefined => {
  const { edge, blend } = f;
  if (!edge || edge.residual > 0.25 || edge.residual > 0.7 * blend.residual) return undefined;
  const takeover = takeoverAt(f.inner, edge.position, f.inner[f.inner.length - 1] as number);
  const confidence = clamp(1 - edge.residual / 0.35, 0.3, 1);
  // 0.8: blurring the composed frame along the travel must explain a fifth of the error (compression noise does not)
  const fit = edgeFit(f);
  if (edge.mode !== 'wipe' && edge.smear < 0.8) return { kind: 'whip', direction: edge.direction, confidence, takeover, ...fit };
  if (edge.mode === 'wipe') return { kind: 'wipe', direction: edge.direction, confidence, takeover, ...fit };
  return { kind: 'slide', direction: edge.direction, mode: edge.mode, confidence, takeover, ...fit };
};

const movingKind = (f: Features): Classified | undefined => {
  if (f.rotation >= 20) return { kind: 'spin', confidence: clamp(f.rotation / 45, 0.4, 0.9) };
  // a zoom transition mixes the pictures while they scale (a scaled blend fits far better than a plain one); one
  // picture jolted and scaled is a shake or a glitch
  const residual = f.zoomFit.residual;
  if (f.mixed && f.zoomFit.gain < 0.7 && f.zoomFit.scale > 1.05) return { kind: 'zoom', confidence: clamp(1.3 - f.zoomFit.gain, 0.4, 0.9), residual };
  // a punch-in: the old picture blown up far past any shake before the new one shows (it looks soft, but grows)
  if (f.zoom >= 0.3 && f.zoomFit.gain < 0.8 && f.backSwings === 0) return { kind: 'zoom', confidence: 0.6, residual };
  if (f.mixed && (f.zoom >= 0.15 || (f.zoom >= 0.08 && f.path < 0.3)) && f.zoomFit.gain < 0.85) return { kind: 'zoom', confidence: clamp(f.zoom / 0.2, 0.4, 0.9), residual };
  return undefined;
};

/** Detail lost along the travel axis and much less across it: a directional (motion) blur. */
const smeared = (f: Features, horizontal: boolean): boolean => {
  const along = horizontal ? f.rx : f.ry, across = horizontal ? f.ry : f.rx;
  return along < 0.5 && along < 0.7 * across;
};

const lateKind = (f: Features): Classified | undefined => {
  if (f.net >= 0.3 && smeared(f, f.heading === 'left' || f.heading === 'right')) return { kind: 'whip', direction: f.heading, confidence: 0.6 };
  // jolts back and forth around one switch: a shake moves the picture up and down as well, a glitch only sideways
  // (see GLITCH_VERTICAL in switch.ts)
  if (f.path >= 0.06 && f.path > 3 * f.net) return { kind: f.pathY <= GLITCH_VERTICAL * f.pathX ? 'glitch' : 'shake', confidence: clamp(f.path / 0.2, 0.4, 0.8) };
  if (f.softBoth && Math.max(f.rx, f.ry) < 0.7) return { kind: 'blur', confidence: clamp(1 - Math.max(f.rx, f.ry), 0.4, 0.8) };
  return undefined;
};

/** The best guess when no rule matched: the model with the smallest residual, at a low confidence. */
const bestGuess = (f: Features): Classified => {
  const options: Array<{ r: number; c: Classified }> = [
    { r: f.blend.residual, c: { kind: 'dissolve', confidence: 0 } },
    { r: f.veil.residual, c: { kind: 'fade', via: f.veil.via, confidence: 0 } },
    ...(f.edge ? [{ r: f.edge.residual, c: { ...(f.edge.mode === 'wipe' ? { kind: 'wipe' as const, direction: f.edge.direction } : { kind: 'slide' as const, direction: f.edge.direction, mode: f.edge.mode }), confidence: 0, ...edgeFit(f) } }] : []),
    ...(f.region ? [{ r: 1 - f.region.purity, c: { kind: 'wipe' as const, ...(f.region.direction ? { direction: f.region.direction } : {}), confidence: 0, residual: f.region.residual } }] : []),
  ];
  const best = options.reduce((a, b) => (b.r < a.r ? b : a));
  return { residual: best.r, ...best.c, confidence: clamp(0.35 * (1 - best.r), 0.05, 0.35), guessed: true };
};

/** lo and hi: the neighbouring boundaries, so that reading a side does not run into the next transition. */
export const classifySpan = (t: Thumbs, sg: Signals, start: number, end: number, lo = 0, hi = sg.n - 1): Classified => {
  if (end - start <= 1) return { kind: 'cut', confidence: 1 };
  const f = features(t, sg, start, end);
  // the picture swings back to the old shot at least once after switching: a glitch (two cuts in a row never go back)
  if ((f.backSwings >= 2 || (f.backSwings >= 1 && f.jumps >= 2)) && f.rotation < 20) return { kind: 'glitch', confidence: 0.6 };
  // one picture at rest on one side of a switch and under an effect on the other (types.ts: side 'before' or 'after')
  // is read before the models of two pictures: a blurred or veiled flat colour also fits a circle wipe or a fade
  const sr = readSwitch(t, sg, start, end, lo, hi) ?? null;
  const one = sr ? oneSidedKind(sr) : undefined;
  const found = one ?? veilKind(f, sg, start, end) ?? movingKindFirst(f) ?? edgeKind(f) ?? regionKind(f) ?? switchKind(t, sg, start, end, lo, hi, sr) ?? movingKind(f) ?? flatZoomKind(t, start, end, f) ?? blurKind(f) ?? blendKind(f) ?? lateKind(f);
  // one in-between frame that no model explains is an odd frame at a hard cut (a partly updated or badly encoded
  // frame), not a transition of one frame
  return withFit(found ?? (end - start === 2 ? { kind: 'cut', confidence: 0.5 } : bestGuess(f)), sr);
};

/**
 * A kind read from the switch (one-sided, spin, shake, glitch, blur) has no model of the whole frame: how well it
 * fits is the share of the span's frames that no reading explains. A cut has no fit.
 */
const withFit = (k: Classified, sr: SwitchReading | null): Classified => {
  if (k.kind === 'cut' || k.residual !== undefined || !sr || !sr.frames.length) return k;
  return { ...k, residual: sr.other / sr.frames.length };
};

/** A mix of a picture and a flat colour in which the picture grows or shrinks (unmix.ts). */
const flatZoomKind = (t: Thumbs, start: number, end: number, f: Features): Classified | undefined =>
  f.mixed && isFlatSideZoom(t, start, end, f.inner) ? { kind: 'zoom', confidence: 0.6 } : undefined;

/** Out of focus and back: detail well under what a mix would keep (a dissolve of two sharp pictures keeps about 0.7). */
const blurKind = (f: Features): Classified | undefined =>
  f.softBoth && Math.max(f.rx, f.ry) < 0.5 ? { kind: 'blur', confidence: clamp(1 - Math.max(f.rx, f.ry), 0.4, 0.8) } : undefined;

/** A spin turns the picture; check it before the edge models, which a turning picture can fool. */
const movingKindFirst = (f: Features): Classified | undefined => (f.rotation >= 20 ? movingKind(f) : undefined);

const regionKind = (f: Features): Classified | undefined => {
  if (!f.region?.direction) return undefined;
  const confidence = clamp(f.region.purity, 0.3, 0.95);
  return { kind: 'wipe', direction: f.region.direction, confidence, takeover: takeoverAt(f.inner, f.region.share, f.inner[f.inner.length - 1] as number), residual: f.region.residual };
};

/**
 * A dissolve mixes the two pictures: some in-between frame is A + alpha (B - A) with alpha well inside 0..1 (f.mixed).
 * A span whose in-between frames each show one picture or the other (a shake, a glitch, an encoder's partial frame at
 * a cut) sits close to a blend with alpha near 0 or 1, but nothing in it is mixed.
 */
const blendKind = (f: Features): Classified | undefined => {
  if (f.blend.residual > 0.25 || !f.blend.rising || !f.mixed) return undefined;
  return { kind: 'dissolve', confidence: clamp(1 - f.blend.residual / 0.35, 0.3, 1), takeover: takeoverAt(f.inner, f.blend.alpha, f.inner[f.inner.length - 1] as number), residual: f.blend.residual };
};

/** Middle of a span: the frame types.ts puts the boundary on for a transition of end - start - 1 frames. */
export const midFrame = (start: number, end: number): number => start + Math.ceil((end - start) / 2);

export { median };