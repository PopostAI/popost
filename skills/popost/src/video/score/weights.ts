/**
 * The tables the scorer is tuned by: dimension weights (equal by default) and how much a confusion of two transition
 * kinds counts. Changing either is a change to the scorer: review it like one (design section 13.6).
 */
import type { Dimension, TransitionKind } from '../types';
import { DIMENSIONS } from '../types';

export const DEFAULT_WEIGHTS: Readonly<Record<Dimension, number>> = Object.fromEntries(DIMENSIONS.map((d) => [d, 1])) as Record<Dimension, number>;

/** Pairs of kinds that look alike on screen and count as half right. Order does not matter. */
const HALF: ReadonlyArray<readonly [TransitionKind, TransitionKind]> = [
  ['fade', 'dissolve'], ['fade', 'flash'], ['flash', 'dissolve'], ['wipe', 'slide'], ['slide', 'whip'],
  ['zoom', 'dissolve'], ['blur', 'dissolve'], ['glitch', 'shake'], ['shake', 'whip'], ['spin', 'zoom'], ['cut', 'glitch'],
];

/** 1 for the same kind, 0.5 for a confusion listed above, 0 otherwise. */
export const kindCredit = (a: TransitionKind, b: TransitionKind): number => {
  if (a === b) return 1;
  return HALF.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) ? 0.5 : 0;
};

/** Ease classes that are close: one step apart counts half. */
export const easeCredit = (a: string | undefined, b: string | undefined): number => {
  if (a === b) return 1;
  const near = new Set(['linear|in-out', 'in-out|linear', 'out|in-out', 'in-out|out', 'in|in-out', 'in-out|in', 'instant|out', 'out|instant']);
  return near.has(a + '|' + b) ? 0.5 : 0;
};

/** Scales of the per-item scores: a difference of this size scores about 1/e. */
export const SCALES = {
  /** Camera: zoom and pan per second (CameraSpec units). */
  camera: 0.03,
  /** Colour: CIE76 ΔE. */
  colour: 20,
  /** Motion: start time difference, seconds. */
  motionTime: 0.2,
} as const;
