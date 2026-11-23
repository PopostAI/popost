/**
 * Entrance and exit presets of track items: a pure function from progress to the visual state of an element.
 * Shared by the page runtime (which turns the state into CSS) and by tests that compute the expected picture.
 */
import type { Direction, Ease, MotionPreset, ResolvedMotion } from '../types';
import { clamp01, ease, lerp } from './easing';

export interface ElementState {
  opacity: number;
  /** Offset from the item's box, as fractions of the canvas' smaller side. */
  translate: [number, number];
  /** Around the centre of the item's box. */
  scale: number;
  /** Degrees, clockwise, around the centre of the item's box (the item's own rotation and its loop). */
  rotate: number;
  /** Gaussian blur radius as a fraction of the canvas' smaller side. */
  blur: number;
  /** Fractions of the element's own box that are hidden: top, right, bottom, left. */
  clip: [number, number, number, number];
  /** Fraction of the text's characters shown, 0..1. */
  chars: number;
}

export const IDENTITY_ELEMENT: ElementState = { opacity: 1, translate: [0, 0], scale: 1, rotate: 0, blur: 0, clip: [0, 0, 0, 0], chars: 1 };

export interface MotionDefault {
  /** Length at 30 fps; motionFrames() scales it to the project's frame rate. */
  frames: number;
  /** Exit easing is applied to the exit's own progress: 'in' leaves slowly at first and then accelerates away. */
  ease: { enter: Ease; exit: Ease };
  overshoot: number;
  direction: Direction;
  distance: number;
}

/** Every default of every preset. Frames are at 30 fps. */
export const MOTION_DEFAULTS: Readonly<Record<MotionPreset, MotionDefault>> = {
  none: { frames: 0, ease: { enter: 'linear', exit: 'linear' }, overshoot: 0, direction: 'up', distance: 0 },
  fade: { frames: 6, ease: { enter: 'out', exit: 'in' }, overshoot: 0, direction: 'up', distance: 0 },
  pop: { frames: 8, ease: { enter: 'linear', exit: 'linear' }, overshoot: 0.12, direction: 'up', distance: 0 },
  'scale-in': { frames: 8, ease: { enter: 'out', exit: 'in' }, overshoot: 0, direction: 'up', distance: 0 },
  slide: { frames: 10, ease: { enter: 'out', exit: 'in' }, overshoot: 0, direction: 'up', distance: 0.25 },
  wipe: { frames: 10, ease: { enter: 'in-out', exit: 'in-out' }, overshoot: 0, direction: 'right', distance: 0 },
  type: { frames: 24, ease: { enter: 'linear', exit: 'linear' }, overshoot: 0, direction: 'right', distance: 0 },
  blur: { frames: 8, ease: { enter: 'out', exit: 'in' }, overshoot: 0, direction: 'up', distance: 0 },
};

/** Default length of a preset at a frame rate: the 30 fps value scaled, at least 1 frame (0 for 'none'). */
export const motionFrames = (preset: MotionPreset, fps: number): number => {
  const base = MOTION_DEFAULTS[preset].frames;
  return base === 0 ? 0 : Math.max(1, Math.round((base * fps) / 30));
};

/** Unit vector of a direction in screen coordinates (y grows downwards). */
export const DIRECTION_VECTOR: Readonly<Record<Direction, [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Index into a [top, right, bottom, left] clip of the side a direction points to. */
export const CLIP_SIDE: Readonly<Record<Direction, number>> = { up: 0, right: 1, down: 2, left: 3 };

const OPPOSITE: Readonly<Record<Direction, Direction>> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/** pop: the scale at which it starts, and the share of the progress at which it peaks at 1 + overshoot. */
const POP_START = 0.6;
const POP_PEAK_AT = 0.6;
/** pop reaches full opacity in the first quarter, before the overshoot. */
const POP_OPACITY_RAMP = 0.25;
/** blur: the starting radius, 4% of the smaller side (43 px on a 1080 px wide canvas). */
const BLUR_START = 0.04;

const popScale = (e: number, overshoot: number): number =>
  e < POP_PEAK_AT
    ? lerp(POP_START, 1 + overshoot, ease('out', e / POP_PEAK_AT))
    : lerp(1 + overshoot, 1, ease('in-out', (e - POP_PEAK_AT) / (1 - POP_PEAK_AT)));

/** The entrance state at eased progress e (0 = not yet entered, 1 = in place) for an element travelling in 'direction'. */
const entrance = (m: ResolvedMotion, direction: Direction, e: number): Partial<ElementState> => {
  switch (m.preset) {
    case 'none':
      return {};
    case 'fade':
      return { opacity: e };
    case 'pop':
      return { scale: popScale(e, m.overshoot), opacity: clamp01(e / POP_OPACITY_RAMP) };
    case 'scale-in':
      return { scale: e };
    case 'slide': {
      const [dx, dy] = DIRECTION_VECTOR[direction];
      return { translate: [-dx * m.distance * (1 - e), -dy * m.distance * (1 - e)], opacity: clamp01(e * 2) };
    }
    case 'wipe': {
      // The reveal edge travels in 'direction', so the part still hidden lies on that side.
      const clip: [number, number, number, number] = [0, 0, 0, 0];
      clip[CLIP_SIDE[direction]] = 1 - e;
      return { clip };
    }
    case 'type':
      return { chars: e };
    case 'blur':
      return { blur: BLUR_START * (1 - e), opacity: e };
  }
};

/**
 * State of an element during its entrance or exit. t is the progress 0..1 of that phase. An exit is the entrance
 * reversed: it ends where an entrance starts, and its direction is the way the element travels while leaving.
 * 'type' is always linear in t, whatever the easing says.
 */
export const motionState = (spec: ResolvedMotion, phase: 'enter' | 'exit', t: number): ElementState => {
  const eased = spec.preset === 'type' ? clamp01(t) : ease(spec.ease, t);
  const partial = phase === 'enter' ? entrance(spec, spec.direction, eased) : entrance(spec, OPPOSITE[spec.direction], 1 - eased);
  return { ...IDENTITY_ELEMENT, ...partial };
};
