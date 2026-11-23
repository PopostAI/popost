/**
 * Test media for the read-* tests, generated at test time with ffmpeg (nothing binary is stored):
 * - lavfi pictures decoded to raw rgb frames,
 * - clips whose shots are joined by ffmpeg's xfade (independent of our code; a hard cut is an xfade of one frame),
 * - clips encoded from raw frames that the scene renderer (read-scene.ts) draws.
 * Frame conventions are those of types.ts: a transition of F frames into a shot starting at S mixes frames
 * a .. a+F-1 with a = S - floor(F / 2). xfade does exactly that with duration (F + 1) / fps and offset (a - 1) / fps
 * (checked by rendering: frame a - 1 is purely old, a + F purely new, progress (n - a + 1) / (F + 1) in between).
 */
import type { Runtime } from '../../src/runtime';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Boundary, Direction, WipeDirection } from '../../src/video/types';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

export const FPS = 30;
export const W = 160;
export const H = 284;

/** True when ffmpeg can be run; asked when a test file loads, with a runtime of its own (the tests skip without it). */
export const ffmpegReady = async (): Promise<boolean> => {
  const rt = await createDiskRuntime();
  try {
    return await hasFfmpeg(rt);
  } finally {
    await rt.cleanup();
  }
};

/** Runs f over items with at most 'limit' at a time; results in input order. */
export const pool = async <T, R>(items: readonly T[], limit: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i] as T, i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** A lavfi source description without size, rate or duration, e.g. "testsrc2", "color=c=0x3366cc", "mandelbrot". */
export type Source = string;

/** No duration: not every source has one (mandelbrot, cellauto, life); a trim or -frames:v ends the stream instead. */
const withSize = (src: Source, w: number, h: number, fps: number): string => src + (src.includes('=') ? ':' : '=') + 's=' + w + 'x' + h + ':r=' + fps;

/** Filter that makes exactly 'frames' frames at 'fps' from input k: the first picture held (still) or the source moving. */
const chainFor = (k: number, frames: number, still: boolean, fps: number, label: string): string =>
  '[' + k + ':v]' + (still ? 'trim=end_frame=1,loop=loop=' + (frames - 1) + ':size=1' : 'trim=end_frame=' + frames)
  + ',setpts=N/' + fps + '/TB,fps=' + fps + ',format=yuv420p[' + label + ']';

/** Raw rgb frames of a lavfi source at w x h (one frame when still). */
export const sourceFrames = async (rt: Runtime, src: Source, frames: number, w: number, h: number, still = false, fps = FPS): Promise<Uint8Array[]> => {
  const n = still ? 1 : frames;
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', withSize(src, w, h, fps), '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const size = w * h * 3;
  return Array.from({ length: Math.floor(r.stdout.length / size) }, (_, i) => new Uint8Array(r.stdout.subarray(i * size, (i + 1) * size)));
};

/** Encodes raw rgb frames to an H.264 mp4 (yuv420p). */
export const encode = async (rt: Runtime, frames: readonly Uint8Array[], w: number, h: number, out: string, fps = FPS, crf = 18): Promise<void> => {
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', w + 'x' + h, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', out], Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))));
};

export interface XShot { src: Source; frames: number; still?: boolean }
/** An xfade transition by name ('cut' for a hard cut) and its mixed frames F. */
export interface XJoin { name: string; frames: number }

/** What a perfect measurement says about an xfade transition. */
export const XFADE_TRUTH: Readonly<Record<string, Pick<Boundary, 'kind' | 'direction' | 'mode' | 'via'>>> = {
  cut: { kind: 'cut' },
  fade: { kind: 'dissolve' },
  dissolve: { kind: 'dissolve' },
  fadeblack: { kind: 'fade', via: 'black' },
  fadewhite: { kind: 'fade', via: 'white' },
  ...Object.fromEntries((['left', 'right', 'up', 'down'] as Direction[]).flatMap((d) => [
    ['wipe' + d, { kind: 'wipe', direction: d as WipeDirection }],
    ['slide' + d, { kind: 'slide', direction: d as WipeDirection, mode: 'push' }],
    ['cover' + d, { kind: 'slide', direction: d as WipeDirection, mode: 'cover' }],
    ['reveal' + d, { kind: 'slide', direction: d as WipeDirection, mode: 'reveal' }],
  ])),
  circleopen: { kind: 'wipe', direction: 'center-out' },
  zoomin: { kind: 'zoom' },
  circleclose: { kind: 'wipe', direction: 'edges-in' },
};

/**
 * xfade's circleopen / circleclose keep the whole frame on one picture for the first and last sixth of the
 * transition (its mixing term is (progress - 0.5) x 3 plus the distance from the centre, clamped to 0..1), so the
 * visible span is shorter than the nominal one by floor((F + 1) / 6) frames on each side.
 */
export const XFADE_DEAD = new Set(['circleopen', 'circleclose']);

/** Boundaries of a timeline of shot lengths and transitions, in the convention of types.ts. */
export const truthOf = (lengths: readonly number[], joins: ReadonlyArray<{ frames: number } & Pick<Boundary, 'kind' | 'direction' | 'mode' | 'via'>>): Boundary[] => {
  let S = 0;
  return joins.map((j, k) => {
    S += lengths[k] as number;
    if (j.kind === 'cut' || j.frames === 0) return { frame: S, kind: 'cut', start: S - 1, end: S, confidence: 1 };
    const a = S - Math.floor(j.frames / 2);
    return { frame: S, kind: j.kind, start: a - 1, end: a + j.frames, ...(j.direction ? { direction: j.direction } : {}), ...(j.mode ? { mode: j.mode } : {}), ...(j.via ? { via: j.via } : {}), confidence: 1 };
  });
};

/**
 * Renders shots joined by xfade transitions into 'out'. Returns the true boundaries. Shot k's own frames run from
 * S_k; its source starts one frame before the mixing of the transition into it and runs until the next one ends.
 */
export const xfadeClip = async (rt: Runtime, out: string, shots: readonly XShot[], joins: readonly XJoin[], w = W, h = H, fps = FPS): Promise<Boundary[]> => {
  const lengths = shots.map((s) => s.frames);
  const S = lengths.map((_, k) => lengths.slice(0, k).reduce((x, y) => x + y, 0));
  const total = lengths.reduce((x, y) => x + y, 0);
  const a = joins.map((j, k) => (S[k + 1] as number) - Math.floor(j.frames / 2));
  const from = shots.map((_, k) => (k === 0 ? 0 : (a[k - 1] as number) - 1));
  const to = shots.map((_, k) => (k + 1 < shots.length ? (a[k] as number) + (joins[k] as XJoin).frames + 2 : total));
  const inputs = shots.flatMap((s) => ['-f', 'lavfi', '-i', withSize(s.src, w, h, fps)]);
  const chains = shots.map((s, k) => chainFor(k, (to[k] as number) - (from[k] as number), s.still ?? false, fps, 's' + k));
  let last = 's0';
  joins.forEach((j, k) => {
    const name = j.frames === 0 || j.name === 'cut' ? 'fade' : j.name;
    const dur = ((j.frames === 0 || j.name === 'cut' ? 0 : j.frames) + 1) / fps;
    chains.push('[' + last + '][s' + (k + 1) + ']xfade=transition=' + name + ':duration=' + dur.toFixed(6) + ':offset=' + (((a[k] as number) - 1) / fps).toFixed(6) + '[x' + k + ']');
    last = 'x' + k;
  });
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', chains.join(';'), '-map', '[' + last + ']', '-r', String(fps), '-frames:v', String(total),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
  const truth = truthOf(lengths, joins.map((j) => ({ frames: j.name === 'cut' ? 0 : j.frames, ...(XFADE_TRUTH[j.name] ?? { kind: 'cut' }) })));
  return truth.map((b, k) => {
    const j = joins[k] as XJoin;
    const dead = XFADE_DEAD.has(j.name) ? Math.floor((j.frames + 1) / 6) : 0;
    return dead ? { ...b, start: b.start + dead, end: b.end - dead } : b;
  });
};
