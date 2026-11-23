/**
 * The change curve: how much of the picture changes between frames sampled every 'step' frames (share of pixels
 * whose colour moves by more than 12 levels in some channel), about ten values per second.
 */
import type { Measure } from '../types';
import { round } from './pixels';

export const rhythmStep = (fps: number): number => Math.max(1, Math.round(fps / 10));

const changedShare = (a: Uint8Array, b: Uint8Array): number => {
  let hit = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.max(Math.abs((a[i] as number) - (b[i] as number)), Math.abs((a[i + 1] as number) - (b[i + 1] as number)), Math.abs((a[i + 2] as number) - (b[i + 2] as number))) > 12) hit++;
  }
  return hit / (a.length / 3);
};

export const measureRhythm = (rgb: readonly Uint8Array[], fps: number): Measure['rhythm'] => {
  const step = rhythmStep(fps);
  const change: number[] = [];
  for (let k = 0; (k + 1) * step < rgb.length; k++) change.push(round(changedShare(rgb[k * step] as Uint8Array, rgb[(k + 1) * step] as Uint8Array), 3));
  return { step, change };
};
