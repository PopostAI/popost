/**
 * Video footage as pictures: which source frame a use of a video material shows at project frame n, the file name of
 * that frame's picture, and every frame the timeline shows (what the build step extracts). DOM-free and pure: the
 * page runtime, the build step, check and the tests share it, so they agree on every frame.
 */
import type { Resolved, ResolvedFootage, ResolvedPlay } from '../types';
import { visibleRange } from './frame';

/** File names of lossless frame pictures: the source frame with at least this many digits, then ".png". */
export const FRAME_DIGITS = 6;

/**
 * The source frame shown at project frame n (the mapping in the header of types.ts): with i = n - play.start,
 * in + round(i * fps * speed / canvasFps), clamped to the source's last frame; "in" for i <= 0.
 */
export const sourceFrame = (play: Pick<ResolvedPlay, 'start' | 'in' | 'speed'>, source: Pick<ResolvedFootage, 'fps' | 'frames'>, canvasFps: number, n: number): number => {
  const last = Math.max(0, source.frames - 1);
  const i = n - play.start;
  if (i <= 0) return Math.min(play.in, last);
  return Math.min(last, play.in + Math.round((i * source.fps * play.speed) / canvasFps));
};

/** The picture of a source frame, relative to the project directory. */
export const framePath = (dir: string, frame: number): string => dir + '/' + String(frame).padStart(FRAME_DIGITS, '0') + '.png';

/** The URL of the picture a play shows at frame n, or undefined when its frames have not been extracted (no dir). */
export const frameUrl = (r: Resolved, play: ResolvedPlay, n: number): string | undefined => {
  const f = r.footage?.[play.material];
  return f?.dir === undefined ? undefined : framePath(f.dir, sourceFrame(play, f, r.canvas.fps, n));
};

/** Every play of the timeline with the frames on which it is visible: a base on its whole visible range, an item on start .. end-1. */
export const playsOf = (r: Resolved): { play: ResolvedPlay; first: number; last: number }[] => [
  ...r.segments.flatMap((s, k) => {
    if (s.base.kind !== 'video') return [];
    const [first, last] = visibleRange(r, k);
    return [{ play: s.base.play, first, last }];
  }),
  ...r.items.flatMap((it) => (it.play && it.end > it.start ? [{ play: it.play, first: it.start, last: it.end - 1 }] : [])),
];

/** The source frames each video material shows somewhere on the timeline, ascending: exactly what has to be extracted. */
export const usedFrames = (r: Resolved): Map<string, number[]> => {
  const sets = new Map<string, Set<number>>();
  for (const { play, first, last } of playsOf(r)) {
    const f = r.footage?.[play.material];
    if (!f) continue;
    const set = sets.get(play.material) ?? new Set<number>();
    for (let n = Math.max(0, first); n <= Math.min(last, r.frames - 1); n++) set.add(sourceFrame(play, f, r.canvas.fps, n));
    sets.set(play.material, set);
  }
  return new Map([...sets].map(([id, set]) => [id, [...set].sort((a, b) => a - b)] as const));
};
