/**
 * Whether a shot keeps moving or comes in and then stands (measure/amount.ts, activityIn), said where the scene of
 * the shot is written: a shot that moves throughout cannot be re-made by entrances that finish early and a hold, and
 * its frames have to be looked at before its scene is written.
 */
import { shotActivity, type Activity } from '../measure/amount';
import type { Measure } from '../types';
import { shotSheetFile } from './frames';

const pct = (v: number): string => Math.round(v * 100) + '%';
const two = (n: number): string => String(n).padStart(2, '0');

/** In a few words, for a line of timeline.md. */
export const movementBrief = (a: Activity): string => (a.kind === 'moves throughout' ? 'MOVES THROUGHOUT (' + pct(a.moving) + ' of its frames)' : a.kind);

/** The line of shots/NN.md. n: the shot from 1; written: its frame strip exists. */
export const movementLine = (a: Activity, n: number, written: boolean): string => {
  const share = 'motion on ' + pct(a.moving) + ' of its frames';
  const strip = written ? shotSheetFile(n) : 'its frames';
  if (a.kind === 'moves throughout')
    return '- Movement: moves throughout (' + share + '). Open ' + strip + ' before writing this scene, and read video-motion.md: something has to move in every part of the shot (a main move, what follows it, a ground that keeps going). A scene whose entrances finish early and then hold does not re-make it.';
  if (a.kind === 'enters then holds')
    return '- Movement: enters then holds (' + share + (a.stillFrom !== undefined ? '; still from ' + a.stillFrom + ' s into the shot' : '') + '). Entrances early, then the picture stands.';
  if (a.kind === 'still') return '- Movement: still (' + share + ').';
  return '- Movement: moves in parts (' + share + '). Open ' + strip + ' to see when.';
};

/** The activity of every shot (undefined where it could not be told). */
export const activities = (m: Measure): (Activity | undefined)[] => m.shots.map((_s, k) => shotActivity(m, k));

/** The shots (from 1) that move throughout. */
export const movingShots = (acts: readonly (Activity | undefined)[]): number[] => acts.flatMap((a, k) => (a?.kind === 'moves throughout' ? [k + 1] : []));

/** The line of REFERENCE.md that names the shots whose frame strips must be opened; undefined when none moves throughout. */
export const movementCardLine = (acts: readonly (Activity | undefined)[], written: boolean): string | undefined => {
  const moving = movingShots(acts), known = acts.filter((a) => a !== undefined).length;
  if (!moving.length) return undefined;
  const which = moving.map((n) => '#' + two(n)).join(', ');
  return '- Movement: ' + moving.length + ' of ' + known + ' shots move throughout (' + which + '); the others enter then hold, move in parts or stand still (shots/NN.md says which). Before writing the scene of a shot that moves throughout, open '
    + (written ? 'its shots/NN-frames.jpg' : 'its frames') + ' and read video-motion.md: it is re-made with motion from its first frame to its last, never with a still picture after an entrance';
};
