/**
 * Easing curves shared by the page runtime, the timeline and the tests. Pure and DOM-free.
 */
import type { Ease } from '../types';

/** Clamps to 0..1; NaN becomes 0. */
export const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Cubic easing of a progress t (clamped to 0..1). 'in' starts slowly, 'out' ends slowly. */
export const ease = (kind: Ease, t: number): number => {
  const x = clamp01(t);
  switch (kind) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'in-out':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
};

/** A deterministic pseudo-random value in 0..1 for an integer (used by glitch and shake; no randomness at run time). */
export const hash01 = (i: number): number => {
  let h = (Math.imul(i | 0, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
};
