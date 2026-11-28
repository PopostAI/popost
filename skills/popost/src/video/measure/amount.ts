/**
 * The motion amount: how much the picture changes between frames about 1/15 s apart, as the mean absolute difference
 * of the gray thumbnails in levels of 255, scaled to exactly 1/15 s. 0 is a still picture. It rises with everything
 * that moves the picture: the camera, the subject, footage played faster. It is a measurement of the picture, never a
 * verdict on how the footage was made, and it is only compared between videos measured the same way (two measurements
 * of this program: the thumbnails have the same area whatever the source's size).
 *
 * The curve holds one value every 'step' frames. A value whose two frames lie on either side of a change of shot, or
 * inside a transition, measures the change and not the motion: amountIn leaves it out.
 */
import type { Measure } from '../types';
import { meanAbs, round } from './pixels';

/** The rate the amount is stated at; the frames compared are the nearest whole number of source frames apart. */
export const AMOUNT_FPS = 15;

export type MotionCurve = NonNullable<Measure['motion']>;

export const amountStep = (fps: number): number => Math.max(1, Math.round(fps / AMOUNT_FPS));

export const measureAmount = (gray: readonly Uint8Array[], fps: number): MotionCurve => {
  const step = amountStep(fps);
  // Frames step / fps seconds apart, stated per 1 / AMOUNT_FPS seconds: a small change grows with the time between frames.
  const scale = fps / (AMOUNT_FPS * step);
  const amount: number[] = [];
  for (let k = 0; (k + 1) * step < gray.length; k++) amount.push(round(meanAbs(gray[k * step] as Uint8Array, gray[(k + 1) * step] as Uint8Array) * scale, 2));
  return { step, amount };
};

/**
 * The mean amount on frames from .. to (to excluded) of a measurement, over the values that lie wholly inside and do
 * not touch a change of shot; undefined when the measurement has no curve or the span holds no such value.
 */
export const amountIn = (m: Pick<Measure, 'motion' | 'boundaries'>, from: number, to: number): number | undefined => {
  const c = m.motion;
  if (!c) return undefined;
  let sum = 0, n = 0;
  c.amount.forEach((v, k) => {
    const a = k * c.step, b = a + c.step;
    if (a < from || b > to - 1) return;
    // A cut lies between frame - 1 and frame; a transition mixes on start + 1 .. end - 1.
    if (m.boundaries.some((x) => a < x.end && b > x.start)) return;
    sum += v;
    n++;
  });
  return n ? round(sum / n, 2) : undefined;
};

/** The amount of shot i (from 0): its frames clear of the changes into and out of it. */
export const shotAmount = (m: Pick<Measure, 'motion' | 'boundaries' | 'shots'>, i: number): number | undefined => {
  const s = m.shots[i];
  return s ? amountIn(m, s.start, s.end) : undefined;
};

/** The amount of the whole video, the changes of shot left out. */
export const videoAmount = (m: Pick<Measure, 'motion' | 'boundaries' | 'source'>): number | undefined => amountIn(m, 0, m.source.frames);

/**
 * A pair of frames whose amount is at or above this moves; below it the picture reads as still (an encoder alone
 * moves a still picture by a few tenths of a level).
 */
export const MOVING_FLOOR = 0.4;
/** A shot moves throughout when this share of its frame pairs moves. */
export const THROUGHOUT_SHARE = 0.6;
/** Under this share a shot is still. */
export const STILL_SHARE = 0.1;

export type ActivityKind = 'moves throughout' | 'enters then holds' | 'moves in parts' | 'still';

/**
 * When a stretch of a video moves: the share of its frame pairs above MOVING_FLOOR, and how that is spread.
 * - moves throughout: THROUGHOUT_SHARE of the pairs or more move;
 * - enters then holds: three quarters or more of the moving pairs lie in the first 40% of the stretch (things come in,
 *   then the picture stands);
 * - still: under STILL_SHARE; moves in parts: all else.
 * stillFrom: seconds from the start of the stretch after which no pair moves (absent when the last pair moves).
 */
export interface Activity { kind: ActivityKind; moving: number; pairs: number; stillFrom?: number }

export const activityIn = (m: Pick<Measure, 'motion' | 'boundaries' | 'source'>, from: number, to: number): Activity | undefined => {
  const c = m.motion;
  if (!c) return undefined;
  const values: { at: number; v: number }[] = [];
  c.amount.forEach((v, k) => {
    const a = k * c.step, b = a + c.step;
    if (a < from || b > to - 1 || m.boundaries.some((x) => a < x.end && b > x.start)) return;
    values.push({ at: a, v });
  });
  if (values.length < 3) return undefined;
  const moving = values.filter((x) => x.v >= MOVING_FLOOR);
  const share = moving.length / values.length;
  const early = moving.filter((x) => x.at - from < 0.4 * (to - from)).length;
  const kind: ActivityKind = share >= THROUGHOUT_SHARE ? 'moves throughout' : share < STILL_SHARE ? 'still' : early >= 0.75 * moving.length ? 'enters then holds' : 'moves in parts';
  const last = moving[moving.length - 1];
  const holds = last !== undefined && last !== values[values.length - 1];
  return { kind, moving: round(share, 2), pairs: values.length, ...(holds || !last ? { stillFrom: round(((last ? last.at + c.step : from) - from) / m.source.fps, 2) } : {}) };
};

/** The activity of shot i (from 0), clear of the changes into and out of it. */
export const shotActivity = (m: Pick<Measure, 'motion' | 'boundaries' | 'shots' | 'source'>, i: number): Activity | undefined => {
  const s = m.shots[i];
  return s ? activityIn(m, s.start, s.end) : undefined;
};
