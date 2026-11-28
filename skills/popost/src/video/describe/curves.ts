/**
 * The curve of the main moving element of the shots that move throughout (measure/move.ts), measured while a
 * reference is described so that the scene of such a shot is written from numbers: where the thing goes, how long it
 * takes, its overshoot, its bounces, its squash and stretch, and the closest easing, ready to paste.
 *
 * The cost is bounded: at most MOST_SHOTS shots (the ones that move most), at most MAX_SECONDS of each, decoded at
 * WIDTH pixels. A shot in which no single thing can be followed (the camera moves, several things move, footage) gets
 * a line that says so and how to measure one element by hand.
 */
import type { Runtime } from '../../runtime';
import { decodeFrames, readColour } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { shotActivity, shotAmount } from '../measure/amount';
import { curvesOf, movePaste, moveSentence } from '../measure/move';
import type { Measure, ShotCurves } from '../types';

export const MOST_SHOTS = 6;
export const MAX_SECONDS = 4;
export const WIDTH = 320;
/** The moving thing's box may cover this share of the frame at most, or it is not one thing. */
const ONE_THING = 0.4;

/** The shots (from 0) to measure: those that move throughout with a still camera, the liveliest first. */
export const curveShots = (m: Measure): number[] =>
  m.shots.flatMap((s, k) => (shotActivity(m, k)?.kind === 'moves throughout' && s.camera.kind !== 'move' ? [k] : []))
    .sort((a, b) => (shotAmount(m, b) ?? 0) - (shotAmount(m, a) ?? 0) || a - b).slice(0, MOST_SHOTS).sort((a, b) => a - b);

/** The curves of one shot's main moving thing from its decoded frames. */
export const curvesOfShot = (frames: { width: number; height: number; fps: number; frames: readonly Uint8Array[] }, shot: number, startFrame: number): ShotCurves => {
  const c = curvesOf(frames, { x: 0, y: 0, w: frames.width, h: frames.height }, { startFrame });
  const moves = c.moves.filter((x) => x.prop === 'path' || x.prop === 'x' || x.prop === 'y').slice(0, 2);
  if (c.box > ONE_THING) return { shot, moves: [], note: 'what moves covers ' + Math.round(c.box * 100) + '% of the frame: several things move, or the whole picture does' };
  if (!moves.length || c.rows < 0.5 * frames.frames.length) return { shot, moves: [], note: 'no single moving element could be followed' };
  return { shot, moves };
};

/** The curves of the shots that move throughout; [] when none does. Never fails a describe: a shot that cannot be decoded is left out. */
export const shotCurves = async (rt: Runtime, video: string, m: Measure): Promise<ShotCurves[]> => {
  const shots = curveShots(m);
  if (!shots.length) return [];
  const p = await probe(rt, video);
  const colour = await readColour(rt, video, p);
  const out: ShotCurves[] = [];
  for (const k of shots) {
    const s = m.shots[k];
    if (!s) continue;
    // Clear of the changes into and out of the shot.
    const into = m.boundaries[k - 1], after = m.boundaries[k];
    const from = Math.max(s.start, (into?.end ?? s.start)) + 1, to = Math.min(s.end, after?.start ?? s.end) - 1;
    const count = Math.min(to - from, Math.round(MAX_SECONDS * m.source.fps));
    if (count < 8) continue;
    try {
      const d = await decodeFrames(rt, video, { width: Math.min(WIDTH, p.width), gray: false, startFrame: from, frameCount: count, probe: p, colour });
      out.push(curvesOfShot({ ...d, fps: m.source.fps }, k + 1, from));
    } catch { /* a shot that cannot be decoded has no curve */ }
  }
  return out;
};

/** The lines of shots/NN.md under "Motion events" for a shot's curves. */
export const curveLines = (c: ShotCurves): string[] => {
  if (!c.moves.length) return ['- Main moving element: ' + (c.note ?? 'not measured') + '. Measure one element yourself: popost video measure curve <video> --from S --to S --roi x,y,w,h (the region that holds its whole path).'];
  return c.moves.flatMap((m, i) => {
    const paste = movePaste(m);
    return ['- ' + (i === 0 ? 'Main moving element' : 'Then') + ' (measured curve): ' + moveSentence(m), '  - paste: helper ' + paste.helper + ' | GSAP ' + paste.gsap];
  });
};
