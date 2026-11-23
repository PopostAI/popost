/**
 * Loops of track items: a pure function from j (the frames since the entrance ended, held during the exit; header of
 * types.ts) to a change of the element's state, composed with its entrance and exit by the timeline.
 */
import type { LoopPreset, ResolvedLoop } from '../types';

export interface LoopState {
  /** Multiplies the element's opacity and scale. */
  opacity: number;
  scale: number;
  /** Added to its offset (fractions of the canvas' smaller side) and its rotation (degrees). */
  translate: [number, number];
  rotate: number;
}

export const IDENTITY_LOOP: LoopState = { opacity: 1, scale: 1, translate: [0, 0], rotate: 0 };

/** Default amount of each loop (units in types.ts LoopSpec). */
export const LOOP_DEFAULTS: Readonly<Record<LoopPreset, number>> = { pulse: 0.06, float: 0.015, sway: 6, blink: 1, spin: 1 };

/** Allowed amounts: a pulse that shrinks to nothing, a float off the canvas or a blink brighter than full are refused. */
export const LOOP_AMOUNT_RANGE: Readonly<Record<LoopPreset, [number, number]>> = {
  pulse: [-0.5, 1], float: [-0.5, 0.5], sway: [-180, 180], blink: [0, 1], spin: [-10, 10],
};

/** Every loop is the identity at j = 0, so it starts where the entrance ends without a jump. */
export const loopState = (loop: ResolvedLoop, j: number): LoopState => {
  const turn = (2 * Math.PI * j) / loop.period;
  const a = loop.amount;
  switch (loop.preset) {
    case 'pulse':
      return { ...IDENTITY_LOOP, scale: 1 + (a * (1 - Math.cos(turn))) / 2 };
    case 'float': {
      // Upwards first (y grows downwards); written so that j = 0 gives 0, not -0.
      const rise = a * Math.sin(turn);
      return { ...IDENTITY_LOOP, translate: [0, rise === 0 ? 0 : -rise] };
    }
    case 'sway':
      return { ...IDENTITY_LOOP, rotate: a * Math.sin(turn) };
    case 'blink':
      return { ...IDENTITY_LOOP, opacity: j % loop.period < loop.period / 2 ? 1 : 1 - a };
    case 'spin':
      return { ...IDENTITY_LOOP, rotate: (360 * a * j) / loop.period };
  }
};
