/**
 * Pictures of a video for whoever looks at them, now usually the agent that writes the fill and the scenes: three
 * frames of every shot and a sheet with the three side by side, or the frames at given moments. With a second video,
 * each picture is the first video's frame beside the other's frame at the same share of its length, labelled A and B,
 * so that a re-creation can be held against its reference although their lengths differ (or beside the other's frame
 * at a moment of its own, the matching moment compare names). Frames come from
 * extractFrame; ffmpeg joins them. Prints nothing: the caller reports the files.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { extractFrame, thumbSize } from '../media/decode';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { lookTimes } from '../scene/pictures';

export type Part = 'a' | 'b' | 'c';

/**
 * One frame to show: the file name it gets (without extension) and where it is in the first video; against: the
 * other video's frame to show beside it, when it is not the one at the same share of its length.
 */
export interface LookMoment { name: string; frame: number; shot?: number; part?: Part; against?: number }

export interface LookPicture {
  file: string;
  /** The frame of the first video, and its time in seconds. */
  frame: number;
  second: number;
  /** The shot (from 1) and which of its three frames, for a shot's pictures. */
  shot?: number;
  part?: Part;
  /** With a second video: its frame at the same share of its length (B, on the right). */
  against?: { frame: number; second: number };
}

export interface LookSheet { file: string; shot: number; pictures: string[] }

export interface LookResult { pictures: LookPicture[]; sheets: LookSheet[] }

export interface LookOptions {
  video: string;
  outDir: string;
  moments: LookMoment[];
  /** Shown beside every frame, at the same share of its length. */
  against?: string;
  /** Width of one frame in pixels. Default 480. */
  width?: number;
}

const two = (n: number): string => String(n).padStart(2, '0');
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Three moments of every shot (frames start .. end-1), at the times the plan step looks at: a quarter, a half and three
 * quarters of the way through, away from the transitions at its two ends. Named shot-NN-a, -b, -c (NN from 01).
 */
export const shotMoments = (shots: readonly { start: number; end: number }[]): LookMoment[] =>
  shots.flatMap((s, k) => lookTimes(s.start, s.end, 3).map((t, j): LookMoment => {
    const part = (['a', 'b', 'c'] as const)[j] ?? 'a';
    return { name: 'shot-' + two(k + 1) + '-' + part, frame: clamp(Math.round(t), s.start, Math.max(s.start, s.end - 1)), shot: k + 1, part };
  }));

/** The frames at these seconds of a video of `frames` frames at `fps`, named at-01, at-02 … in the order given. */
export const secondMoments = (seconds: readonly number[], fps: number, frames: number): LookMoment[] =>
  seconds.map((s, i) => ({ name: 'at-' + two(i + 1), frame: clamp(Math.round(s * fps), 0, Math.max(0, frames - 1)) }));

/** A letter of 5 x 7 cells, row by row. ffmpeg's drawtext needs a font library many builds lack; boxes need nothing. */
const GLYPHS: Record<'A' | 'B', string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
};

/** drawbox filters that write a white letter on a dark square in the top left corner of a picture `height` high. */
export const labelFilter = (letter: 'A' | 'B', height: number): string => {
  const s = Math.max(2, Math.round(height / 60));
  const box = (x: number, y: number, w: number, h: number, color: string): string => 'drawbox=x=' + x + ':y=' + y + ':w=' + w + ':h=' + h + ':color=' + color + ':t=fill';
  const cells = GLYPHS[letter].flatMap((row, y) => [...row.matchAll(/#+/g)].map((m) => box(2 * s + (m.index ?? 0) * s, 2 * s + y * s, m[0].length * s, s, 'white')));
  return [box(s, s, 7 * s, 9 * s, 'black@0.6'), ...cells].join(',');
};

const JPEG = ['-q:v', '3'];

/** The first video's frame beside the other's, both `height` high, labelled A and B. */
const pair = async (rt: Runtime, a: string, b: string, height: number, out: string): Promise<void> => {
  const side = (i: number, letter: 'A' | 'B'): string => '[' + i + ':v]scale=-2:' + height + ',' + labelFilter(letter, height) + '[' + letter + ']';
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', a, '-i', b, '-filter_complex', side(0, 'A') + ';' + side(1, 'B') + ';[A][B]hstack=inputs=2', '-frames:v', '1', ...JPEG, out]);
};

/** The pictures of one shot side by side. */
const sheet = async (rt: Runtime, files: string[], out: string): Promise<void> => {
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', files.map((_f, i) => '[' + i + ':v]').join('') + 'hstack=inputs=' + files.length, '-frames:v', '1', ...JPEG, out]);
};

/** Writes one JPEG per moment into outDir (a pair with `against`), and a sheet for every shot that has all three frames. */
export const lookAt = async (rt: Runtime, o: LookOptions): Promise<LookResult> => {
  const width = o.width ?? 480;
  const a = await probe(rt, o.video);
  const b = o.against === undefined ? undefined : await probe(rt, o.against);
  // A pair is as high as the first video's frame; the other's frame is scaled to that height.
  const { height } = thumbSize(a.width, a.height, width);
  const against = o.against;
  await rt.fs.mkdir(o.outDir);
  const pictures: LookPicture[] = [];
  for (const m of o.moments) {
    const file = rt.path.join(o.outDir, m.name + '.jpg');
    const where = { ...(m.shot === undefined ? {} : { shot: m.shot }), ...(m.part ? { part: m.part } : {}) };
    if (!b || against === undefined) {
      await extractFrame(rt, o.video, m.frame, file, width);
      pictures.push({ file, frame: m.frame, second: r3(m.frame / a.fps), ...where });
      continue;
    }
    const other = clamp(m.against ?? Math.round((m.frame / Math.max(1, a.frames)) * b.frames), 0, Math.max(0, b.frames - 1));
    await withTempDir(rt, 'popost-video-look-', async (dir) => {
      const left = rt.path.join(dir, 'a.jpg'), right = rt.path.join(dir, 'b.jpg');
      await extractFrame(rt, o.video, m.frame, left, width);
      await extractFrame(rt, against, other, right, width);
      await pair(rt, left, right, height, file);
    });
    pictures.push({ file, frame: m.frame, second: r3(m.frame / a.fps), ...where, against: { frame: other, second: r3(other / b.fps) } });
  }
  const shots = [...new Set(pictures.flatMap((p) => (p.shot === undefined ? [] : [p.shot])))];
  const sheets: LookSheet[] = [];
  for (const shot of shots) {
    const mine = pictures.filter((p) => p.shot === shot).map((p) => p.file);
    if (mine.length !== 3) continue;
    const file = rt.path.join(o.outDir, 'shot-' + two(shot) + '.jpg');
    await sheet(rt, mine, file);
    sheets.push({ file, shot, pictures: mine });
  }
  return { pictures, sheets };
};
