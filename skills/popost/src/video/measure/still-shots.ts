/**
 * A re-make that stands still where its reference keeps moving. For every shot of the reference that moves throughout
 * (amount.ts, activityIn), the matching part of the other video is looked at the same way: when it is still for more
 * than STILL_TOO_LONG of the shot, that is a problem with a name and a fix, not a number to note. It is the commonest
 * way a re-made motion graphic goes wrong: every element enters in the first third of a second and the shot is a
 * still picture from then on.
 */
import type { Measure } from '../types';
import { activityIn, type Activity } from './amount';

/** The share of a shot the re-make may be still when its reference shot moves throughout. */
export const STILL_TOO_LONG = 0.4;

export interface StillProblem {
  /** The reference's shot, from 1. */
  shot: number;
  name: 'still-while-reference-moves';
  /** The share of frame pairs that move, in both. */
  reference: { moving: number };
  other: { moving: number; still: number; stillFrom?: number };
  message: string;
  fix: string;
}

interface Span { from: number; to: number }
const pct = (v: number): string => Math.round(v * 100) + '%';

const problemOf = (shot: number, ref: Activity, mine: Activity): StillProblem => {
  const still = Math.round((1 - mine.moving) * 100) / 100;
  return {
    shot, name: 'still-while-reference-moves', reference: { moving: ref.moving }, other: { moving: mine.moving, still, ...(mine.stillFrom !== undefined ? { stillFrom: mine.stillFrom } : {}) },
    message: 'Shot ' + shot + ' stands still for ' + pct(still) + ' of its length' + (mine.stillFrom !== undefined ? ' (nothing moves after ' + mine.stillFrom + ' s into it)' : '') + ', while the reference shot moves throughout (motion on ' + pct(ref.moving) + ' of its frames).',
    fix: 'Re-write the scene so that something moves from its first frame to its last: open the reference\'s shots/' + String(shot).padStart(2, '0') + '-frames.jpg, give the shot a main move that lasts as long as the reference\'s, things that follow it (a trail, a shadow, a settle) and a ground that keeps going (a drift, a slow turn, moving light); titles land and then stay still. video-motion.md has the recipes. Then render and compare again: this is to be fixed, not noted.',
  };
};

/**
 * The shots of `ref` that move throughout whose part of `other` is still for more than STILL_TOO_LONG. shots: each
 * reference shot (from 1) with its seconds in both videos, as compareShots gives them.
 */
export const stillProblems = (ref: Measure, other: Measure, shots: readonly { shot: number; reference: Span; other: Span }[]): StillProblem[] =>
  shots.flatMap((s) => {
    const a = activityIn(ref, Math.round(s.reference.from * ref.source.fps), Math.round(s.reference.to * ref.source.fps));
    if (a?.kind !== 'moves throughout') return [];
    const b = activityIn(other, Math.round(s.other.from * other.source.fps), Math.round(s.other.to * other.source.fps));
    return b && 1 - b.moving > STILL_TOO_LONG ? [problemOf(s.shot, a, b)] : [];
  });
