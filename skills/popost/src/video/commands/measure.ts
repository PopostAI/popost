/**
 * `popost video measure curve`: the curve of one moving thing of a video in numbers (measure/move.ts): start, end,
 * duration, distance, peak speed, overshoot, turns and bounces, settle time, squash and stretch, and the closest named
 * easing with the error of the fit; as JSON, one sentence, and what to paste into a scene.
 */
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { decodeFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { curvesOf, movePaste, moveSentence } from '../measure/move';
import type { Trajectory } from '../types';
import { command, userPath, VideoCommandError, type Commands } from './shared';

/** Frames decoded at most: a move is a second or two. */
const MAX_FRAMES = 600;

const numbers = (text: string, n: number, flag: string): number[] => {
  const v = text.split(',').map((x) => Number(x.trim()));
  if (v.length !== n || v.some((x) => !Number.isFinite(x))) throw new VideoCommandError(flag + ' takes ' + n + ' numbers separated by commas; got "' + text + '".');
  return v;
};

/** The region and the seconds of a path of tracks.json: the box round its samples with room, from a little before it to a little after. */
const ofTrack = async (rt: Runtime, dir: string, id: string, fps: number): Promise<{ roi: number[]; from: number; to: number }> => {
  const file = rt.path.join(dir, 'tracks.json');
  const tracks = await rt.fs.readText(file).then((t) => (JSON.parse(t) as { tracks?: Trajectory[] }).tracks ?? [], () => { throw new VideoCommandError('There is no ' + file + '. Run popost video describe <video> --out <dir> first, or give --roi, --from and --to.'); });
  const t = tracks.find((x) => x.id === id);
  if (!t) throw new VideoCommandError('tracks.json has no path "' + id + '". It has: ' + (tracks.map((x) => x.id).join(', ') || 'none') + '.');
  const xs = t.samples.flatMap((s) => [s.centre[0] - s.size[0] / 2, s.centre[0] + s.size[0] / 2]), ys = t.samples.flatMap((s) => [s.centre[1] - s.size[1] / 2, s.centre[1] + s.size[1] / 2]);
  const x0 = Math.max(0, Math.min(...xs) - 0.05), y0 = Math.max(0, Math.min(...ys) - 0.05), x1 = Math.min(1, Math.max(...xs) + 0.05), y1 = Math.min(1, Math.max(...ys) + 0.05);
  return { roi: [x0, y0, x1 - x0, y1 - y0], from: Math.max(0, (t.start - 3) / fps), to: (t.end + Math.round(0.5 * fps)) / fps };
};

const curve = command(
  'the curve of one moving thing: inside a region (--roi) between two moments (--from, --to), its start, end, duration, distance, peak speed, overshoot, bounces, settle time, squash and stretch, and the closest easing (linear, power1-4 in/out/inOut, sine, expo, circ, back with its overshoot, elastic, bounce, spring with damping and stiffness) with the error of the fit; prints JSON, a sentence for each move and what to paste (the Skill\'s motion helper and GSAP)',
  {
    positionals: [{ name: 'video', help: 'the video file' }],
    options: [
      { flag: '--from', kind: 'number', help: 'seconds: a moment before the move starts' },
      { flag: '--to', kind: 'number', help: 'seconds: a moment after it has come to rest' },
      { flag: '--roi', metavar: 'X,Y,W,H', help: 'the region that holds the thing\'s whole path, as fractions of the frame (0.1,0.2,0.5,0.6) or in pixels of the video; default: the whole frame' },
      { flag: '--track', metavar: 'ID', help: 'instead of --roi, --from and --to: a path of tracks.json (popost video describe), by its id' },
      { flag: '--reference-dir', metavar: 'DIR', help: 'with --track: the directory describe wrote' },
      { flag: '--threshold', kind: 'int', default: 24, help: 'how far a pixel must be from the ground to belong to the thing, in levels of 255' },
      { flag: '--width', kind: 'int', default: 480, help: 'the width the frames are decoded at' },
    ],
  },
  async (args, rt) => {
    const video = userPath(rt, args.req('video'));
    const p = await probe(rt, video);
    const track = args.string('track');
    const given = track ? await ofTrack(rt, userPath(rt, args.string('reference-dir') ?? '.'), track, p.fps) : undefined;
    const from = args.number('from') ?? given?.from ?? 0, to = args.number('to') ?? given?.to ?? p.duration;
    if (!(to > from)) throw new VideoCommandError('--to (' + to + ') must be after --from (' + from + '): give a moment before the move and one after it has come to rest.');
    const startFrame = Math.max(0, Math.round(from * p.fps)), count = Math.round((to - from) * p.fps) + 1;
    if (count > MAX_FRAMES) throw new VideoCommandError('That is ' + count + ' frames; a move is measured on ' + MAX_FRAMES + ' at most. Give --from and --to closer round the move.');
    const d = await decodeFrames(rt, video, { width: Math.min(args.number('width') ?? 480, p.width), gray: false, startFrame, frameCount: count, probe: p });
    if (d.frames.length < 4) throw new VideoCommandError('The video has no frames between ' + from + ' s and ' + to + ' s. Pick moments inside its ' + p.duration.toFixed(2) + ' s.');
    const typed = args.string('roi'), r = typed ? numbers(typed, 4, '--roi') : given?.roi ?? [0, 0, 1, 1];
    // Fractions of the frame, or pixels of the video when any number is above 1.
    const inPixels = r.some((v) => v > 1);
    const [fx, fy, fw, fh] = inPixels ? [(r[0] as number) / p.width, (r[1] as number) / p.height, (r[2] as number) / p.width, (r[3] as number) / p.height] : (r as [number, number, number, number]);
    const x = Math.max(0, Math.floor(fx * d.width)), y = Math.max(0, Math.floor(fy * d.height));
    const roi = { x, y, w: Math.min(d.width - x, Math.max(8, Math.ceil(fw * d.width))), h: Math.min(d.height - y, Math.max(8, Math.ceil(fh * d.height))) };
    const c = curvesOf({ ...d, fps: p.fps }, roi, { startFrame, threshold: args.number('threshold') ?? 24 });
    const moves = c.moves.map((m) => ({ ...m, sentence: moveSentence(m), paste: movePaste(m) }));
    printJson(rt, {
      ok: true, video, seconds: [from, to], roi: c.roi, fps: c.fps, framesSeen: c.rows, moves, pulses: c.pulses,
      sentence: moves.length ? moves[0]?.sentence : 'Nothing in the region moved or appeared between ' + from + ' s and ' + to + ' s: widen --roi, move --from earlier, or lower --threshold for a thing close to its ground in colour.',
      next: 'write the scene from these numbers: the first move is the largest; "paste.helper" is for a scene that draws with render(seconds) (popost video scene library <project> --name motion), "paste.gsap" for a GSAP timeline; then measure the same region of your render and hold the two against each other (references/video-motion.md, "Measure, do not guess")',
    });
    return 0;
  },
);

export const measureCommands: Commands = { curve };
