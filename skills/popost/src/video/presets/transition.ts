/**
 * Transitions between two segment layers: a pure function from progress to the state of the old and the new layer.
 * Shared by the page runtime and the tests. No randomness: glitch and shake derive their pattern from the frame index.
 * A one-sided transition (side 'after' or 'before') shows one layer under an effect of amount 0..1 (header of
 * types.ts); "strength" scales the amount of every kind that has one.
 */
import type { Direction, Ease, ResolvedTransition, TransitionKind, WipeDirection } from '../types';
import { clamp01, ease, hash01 } from './easing';
import { CLIP_SIDE, DIRECTION_VECTOR } from './motion';

/** [top, right, bottom, left] hidden fractions of the layer, or a centred circle (radius: fraction of the half diagonal). */
export type LayerClip = [number, number, number, number] | { radius: number };

export interface LayerState {
  opacity: number;
  /** Offset as fractions of the canvas width and height. */
  translate: [number, number];
  /** Around the centre of the canvas. */
  scale: number;
  /** Degrees, clockwise. */
  rotate: number;
  /** Gaussian blur radius as a fraction of the canvas' smaller side. */
  blur: number;
  /** Directional blur (standard deviation along x and y) as fractions of the smaller side; [0, 0] = none. */
  smear: [number, number];
  clip: LayerClip;
  /** Of the two layers, the one with the larger z is drawn on top. */
  z: number;
}

export interface TransitionState {
  old: LayerState;
  next: LayerState;
  /** A flat colour drawn over both layers (below the items). */
  overlay?: { color: string; opacity: number };
}

export type TransitionName = Exclude<TransitionKind, 'cut'>;

export interface TransitionDefault {
  /** Length at 30 fps; transitionFrames() scales it to the project's frame rate. */
  frames: number;
  direction: WipeDirection;
  mode: 'push' | 'cover' | 'reveal';
  via: 'black' | 'white';
  ease: Ease;
}

/** Every default of every transition. Frames are at 30 fps. */
export const TRANSITION_DEFAULTS: Readonly<Record<TransitionName, TransitionDefault>> = {
  fade: { frames: 12, direction: 'left', mode: 'push', via: 'black', ease: 'linear' },
  flash: { frames: 6, direction: 'left', mode: 'push', via: 'white', ease: 'linear' },
  dissolve: { frames: 12, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  wipe: { frames: 10, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  slide: { frames: 10, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  zoom: { frames: 10, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  spin: { frames: 12, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  blur: { frames: 10, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
  glitch: { frames: 8, direction: 'left', mode: 'push', via: 'black', ease: 'linear' },
  shake: { frames: 10, direction: 'left', mode: 'push', via: 'black', ease: 'linear' },
  whip: { frames: 8, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' },
};

/** Kinds whose direction is a Direction (the way the pictures travel); wipe also takes center-out and edges-in. */
export const DIRECTED_TRANSITIONS: readonly TransitionName[] = ['slide', 'whip'];

/** Kinds that can be one-sided, and whose amount "strength" scales. The others mix two pictures and have no amount. */
export const ONE_SIDED_TRANSITIONS: readonly TransitionName[] = ['blur', 'zoom', 'shake', 'flash', 'whip', 'glitch', 'fade', 'spin'];

export const transitionFrames = (kind: TransitionName, fps: number): number =>
  Math.max(1, Math.round((TRANSITION_DEFAULTS[kind].frames * fps) / 30));

export const IDENTITY_LAYER: LayerState = { opacity: 1, translate: [0, 0], scale: 1, rotate: 0, blur: 0, smear: [0, 0], clip: [0, 0, 0, 0], z: 0 };

const layer = (over: Partial<LayerState> = {}): LayerState => ({ ...IDENTITY_LAYER, ...over });
const hidden = (): LayerState => layer({ opacity: 0 });

interface Canvas2 { width: number; height: number }
type Kind = (tr: ResolvedTransition, e: number, p: number, canvas: Canvas2) => TransitionState;

const VIA_COLOR = { black: '#000000', white: '#ffffff' } as const;
/** flash: the overlay is 1.5 times the triangle, clipped at 1, so it holds full white around the middle. */
const FLASH_GAIN = 1.5;
/** blur: peak radius at the switch, 6% of the smaller side. */
const BLUR_PEAK = 0.06;
/** zoom: how far the old picture grows while it fades, and how large the new one starts. */
const ZOOM_OLD = 0.5;
const ZOOM_NEW = 0.25;
/** glitch: peak horizontal offset, 8% of the width. shake: peak offset, 5% of each side. whip: peak smear, 8%. */
const GLITCH_OFFSET = 0.08;
const SHAKE_OFFSET = 0.05;
const WHIP_SMEAR = 0.08;
/** whip, one-sided: how far the picture travels while it settles (or leaves), 15% of the canvas. */
const WHIP_TRAVEL = 0.15;
/** spin: the angle at the switch (both sides) or at full amount (one side). */
const SPIN_ANGLE = 90;

const strengthOf = (tr: ResolvedTransition): number => tr.strength ?? 1;

const triangle = (e: number): number => 1 - Math.abs(2 * e - 1);
/** Progress within the first (e < 0.5) or the second half. */
const half = (e: number): number => (e < 0.5 ? e / 0.5 : (e - 0.5) / 0.5);
const vector = (d: WipeDirection): [number, number] => DIRECTION_VECTOR[(d in DIRECTION_VECTOR ? d : 'left') as Direction];

/** Smallest scale at which a copy of the canvas rotated by deg degrees still covers the canvas. */
export const coverScale = (deg: number, canvas: Canvas2): number => {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return Math.max((canvas.width * c + canvas.height * s) / canvas.width, (canvas.width * s + canvas.height * c) / canvas.height);
};

/** Index 0..F-1 of the frame inside the span, recovered from p = (i + 1) / (F + 1). */
const frameIndex = (p: number, frames: number): number => Math.min(frames - 1, Math.max(0, Math.round(p * (frames + 1)) - 1));

const flatThrough = (color: string, opacity: number, e: number): TransitionState => ({
  old: e < 0.5 ? layer() : hidden(),
  next: layer({ opacity: e < 0.5 ? 0 : 1, z: 1 }),
  overlay: { color, opacity },
});

const wipe: Kind = (tr, e) => {
  if (tr.direction === 'center-out') return { old: layer(), next: layer({ clip: { radius: e }, z: 1 }) };
  if (tr.direction === 'edges-in') return { old: layer({ clip: { radius: 1 - e }, z: 1 }), next: layer() };
  // The edge travels in 'direction'; the part of the new picture still hidden lies on that side.
  const clip: [number, number, number, number] = [0, 0, 0, 0];
  clip[CLIP_SIDE[tr.direction]] = 1 - e;
  return { old: layer(), next: layer({ clip, z: 1 }) };
};

const slide: Kind = (tr, e) => {
  const [dx, dy] = vector(tr.direction);
  const out: [number, number] = [dx * e, dy * e];
  const inn: [number, number] = [dx * (e - 1), dy * (e - 1)];
  if (tr.mode === 'cover') return { old: layer(), next: layer({ translate: inn, z: 1 }) };
  if (tr.mode === 'reveal') return { old: layer({ translate: out, z: 1 }), next: layer() };
  return { old: layer({ translate: out }), next: layer({ translate: inn, z: 1 }) };
};

const spin: Kind = (tr, e, _p, canvas) => {
  const q = ease('in-out', half(e));
  const a = SPIN_ANGLE * strengthOf(tr);
  const deg = e < 0.5 ? a * q : -a * (1 - q);
  const state = layer({ rotate: deg, scale: coverScale(deg, canvas), z: 1 });
  return e < 0.5 ? { old: state, next: hidden() } : { old: hidden(), next: state };
};

const glitch: Kind = (tr, _e, p) => {
  const i = frameIndex(p, tr.frames);
  // New takes over frame by frame on a fixed pattern: frame i shows the new picture once its place in the span
  // passes a per-frame threshold between 0.3 and 0.7, so the first frames are old and the last are new.
  const useNew = (i + 0.5) / tr.frames > 0.3 + 0.4 * hash01(i);
  const dx = (hash01(i + 101) - 0.5) * 2 * GLITCH_OFFSET * strengthOf(tr) * triangle(clamp01(p));
  const state = layer({ translate: [dx, 0], scale: 1 + 2 * Math.abs(dx), z: 1 });
  return useNew ? { old: hidden(), next: state } : { old: state, next: hidden() };
};

const shake: Kind = (tr, e, p) => {
  const i = frameIndex(p, tr.frames);
  // Rises to the switch, then decays quadratically to rest.
  const amp = SHAKE_OFFSET * strengthOf(tr) * (e < 0.5 ? e / 0.5 : ((1 - e) / 0.5) ** 2);
  const sign = i % 2 === 0 ? 1 : -1;
  const dx = amp * sign * (0.6 + 0.4 * hash01(i));
  const dy = amp * (hash01(i + 7) - 0.5);
  const state = layer({ translate: [dx, dy], scale: 1 + 2 * amp, z: 1 });
  return e < 0.5 ? { old: state, next: hidden() } : { old: hidden(), next: state };
};

const whip: Kind = (tr, e) => {
  const [dx, dy] = vector(tr.direction);
  const s = WHIP_SMEAR * strengthOf(tr) * triangle(e);
  const smear: [number, number] = [Math.abs(dx) * s, Math.abs(dy) * s];
  return {
    old: layer({ translate: [dx * e, dy * e], smear }),
    next: layer({ translate: [dx * (e - 1), dy * (e - 1)], smear, z: 1 }),
  };
};

const KINDS: Readonly<Record<TransitionName, Kind>> = {
  fade: (tr, e) => flatThrough(VIA_COLOR[tr.via], clamp01(strengthOf(tr) * triangle(e)), e),
  flash: (tr, e) => flatThrough(VIA_COLOR.white, clamp01(FLASH_GAIN * strengthOf(tr) * triangle(e)), e),
  dissolve: (_tr, e) => ({ old: layer(), next: layer({ opacity: e, z: 1 }) }),
  wipe,
  slide,
  zoom: (tr, e) => ({
    old: layer({ scale: 1 + ZOOM_OLD * strengthOf(tr) * e, opacity: 1 - e, z: 1 }),
    next: layer({ scale: 1 + ZOOM_NEW * strengthOf(tr) * (1 - e) }),
  }),
  spin,
  blur: (tr, e) => {
    const b = BLUR_PEAK * strengthOf(tr) * (e < 0.5 ? half(e) : 1 - half(e));
    return e < 0.5 ? { old: layer({ blur: b, z: 1 }), next: hidden() } : { old: hidden(), next: layer({ blur: b, z: 1 }) };
  },
  glitch,
  shake,
  whip,
};

// ---------------------------------------------------------------------------------------------------------------------
// One side

type Side = 'after' | 'before';
/** The look of one picture under an effect of amount k (0 = none; 1 = full at strength 1; up to 2). i: frame in the span. */
type Effect = (tr: ResolvedTransition, k: number, i: number, side: Side, canvas: Canvas2) => { layer: Partial<LayerState>; overlay?: TransitionState['overlay'] };

const jolt = (amp: number, i: number): Partial<LayerState> => {
  const sign = i % 2 === 0 ? 1 : -1;
  return { translate: [amp * sign * (0.6 + 0.4 * hash01(i)), amp * (hash01(i + 7) - 0.5)], scale: 1 + 2 * amp };
};

const EFFECTS: Readonly<Record<TransitionName, Effect>> = {
  blur: (_tr, k) => ({ layer: { blur: BLUR_PEAK * k } }),
  // The old picture grows into the cut as far as a two-sided zoom takes it; the new one starts as large as there.
  zoom: (_tr, k, _i, side) => ({ layer: { scale: 1 + (side === 'before' ? ZOOM_OLD : ZOOM_NEW) * k } }),
  shake: (_tr, k, i) => ({ layer: jolt(SHAKE_OFFSET * k, i) }),
  glitch: (_tr, k, i) => {
    const dx = (hash01(i + 101) - 0.5) * 2 * GLITCH_OFFSET * k;
    return { layer: { translate: [dx, 0], scale: 1 + 2 * Math.abs(dx) } };
  },
  // 'after': the new picture arrives travelling in 'direction' and settles; 'before': the old one leaves that way.
  whip: (tr, k, _i, side) => {
    const [dx, dy] = vector(tr.direction);
    const travel = WHIP_TRAVEL * k * (side === 'after' ? -1 : 1);
    return { layer: { translate: [dx * travel, dy * travel], scale: 1 + 2 * Math.abs(travel), smear: [Math.abs(dx) * WHIP_SMEAR * k, Math.abs(dy) * WHIP_SMEAR * k] } };
  },
  spin: (_tr, k, _i, side, canvas) => {
    const deg = SPIN_ANGLE * k * (side === 'after' ? -1 : 1);
    return { layer: { rotate: deg, scale: coverScale(deg, canvas) } };
  },
  flash: (_tr, k) => ({ layer: {}, overlay: { color: VIA_COLOR.white, opacity: clamp01(FLASH_GAIN * k) } }),
  fade: (tr, k) => ({ layer: {}, overlay: { color: VIA_COLOR[tr.via], opacity: clamp01(k) } }),
  // Never reached: check refuses one-sided dissolves, wipes and slides. Shown plainly if a caller builds one anyway.
  dissolve: () => ({ layer: {} }),
  wipe: () => ({ layer: {} }),
  slide: () => ({ layer: {} }),
};

/** q: the one-sided progress of the header ('after': (n - a) / F, 'before': (n - a + 1) / F). */
const oneSided = (tr: ResolvedTransition, side: Side, q: number, canvas: Canvas2): TransitionState => {
  const amount = side === 'after' ? 1 - ease(tr.ease, q) : ease(tr.ease, q);
  const i = Math.min(tr.frames - 1, Math.max(0, Math.round(q * tr.frames) - (side === 'before' ? 1 : 0)));
  const fx = EFFECTS[tr.kind](tr, amount * strengthOf(tr), i, side, canvas);
  const shown = layer({ ...fx.layer, z: 1 });
  const state = side === 'after' ? { old: hidden(), next: shown } : { old: shown, next: hidden() };
  return fx.overlay && fx.overlay.opacity > 0 ? { ...state, overlay: fx.overlay } : state;
};

/**
 * State of both layers on a frame of the span. Both sides: p = (n - a + 1) / (F + 1), exclusive at both ends; the
 * transition's easing is applied to p first, and glitch and shake also use the frame index recovered from p. One side:
 * p is q of the header (frame.ts transitionProgress), and the layer that is not shown is hidden.
 */
export const transitionState = (tr: ResolvedTransition, p: number, canvas: Canvas2): TransitionState => {
  const side = tr.side ?? 'both';
  return side === 'both' ? KINDS[tr.kind](tr, ease(tr.ease, p), clamp01(p), canvas) : oneSided(tr, side, p, canvas);
};
