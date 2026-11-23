/**
 * Decoding a video into raw thumbnails with ffmpeg: every frame (or every k-th, or at a set rate) scaled to a small
 * width, as gray8 or rgb24 bytes, one Uint8Array per frame. The measurement works on these; nothing else decodes video.
 */
import type { Runtime } from '../../runtime';
import type { Probe } from '../types';
import { FfmpegError, probe, runFfmpeg, runFfmpegOk } from './ffmpeg';
import type { FootageColour } from './footage';
import { colourOf } from './footage';

/** Refuse to decode more than this many bytes of frames: about 600 MB. */
export const MAX_DECODE_BYTES = 600 * 1024 * 1024;

export interface DecodeOptions {
  /** Width of the decoded frames in pixels; the height keeps the proportions, rounded to an even number. */
  width: number;
  /** true: one byte per pixel (gray8). false: three (rgb24). */
  gray: boolean;
  /** Resample to this rate with ffmpeg's fps filter. Absent: every source frame is kept (or every 'every'-th). */
  fps?: number;
  /** Keep only every k-th source frame (counted from startFrame), so decoded frame i is source frame startFrame + i * k. */
  every?: number;
  /** First source frame to decode (0-based). */
  startFrame?: number;
  /** How many source frames to read from startFrame (before 'every' or 'fps' thins them out). */
  frameCount?: number;
  /** The file's probe, when the caller already has it (saves one pass over the file). */
  probe?: Probe;
  /** Override of MAX_DECODE_BYTES. */
  maxBytes?: number;
  /** How to read the source's YUV (matrix and range), when the caller already knows it (readColour). */
  colour?: FootageColour;
}

export interface Decoded {
  width: number;
  height: number;
  /** Rate of the decoded frames: the source rate, the source rate divided by 'every', or 'fps'. */
  fps: number;
  frames: Uint8Array[];
}

/** Output size for a source size and a requested width: the height in proportion, both rounded to even numbers. */
export const thumbSize = (srcW: number, srcH: number, width: number): { width: number; height: number } => {
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round((srcH * w) / srcW / 2) * 2);
  return { width: w, height: h };
};

const filterChain = (o: DecodeOptions, size: { width: number; height: number }): string => {
  const parts: string[] = [];
  const start = o.startFrame ?? 0;
  if (start > 0 || o.frameCount !== undefined) {
    parts.push('trim=start_frame=' + start + (o.frameCount !== undefined ? ':end_frame=' + (start + o.frameCount) : ''), 'setpts=PTS-STARTPTS');
  }
  if (o.every !== undefined && o.every > 1) parts.push("select='not(mod(n," + o.every + "))'");
  if (o.fps !== undefined) parts.push('fps=' + o.fps);
  // Area averaging: every source pixel counts once, so a thumbnail does not alias fine detail into false motion. The
  // YUV is read with the source's own matrix and range (ffmpeg alone reads every untagged source as BT.601, about 20
  // levels off on saturated colours of HD footage), with exact rounding. Full chroma interpolation would bring flat
  // colours from 4 levels to 1, but it softens the colour edges of small elements and moves the overshoot read from a
  // pop (read-motion: 0.01 -> 0.06 off), so it is left out until that reading stops depending on the chroma edges.
  const colour = o.colour ? ':in_color_matrix=' + o.colour.matrix + ':in_range=' + o.colour.range : '';
  parts.push('scale=' + size.width + ':' + size.height + colour + ':flags=area+accurate_rnd', 'format=' + (o.gray ? 'gray' : 'rgb24'));
  return parts.join(',');
};

/** The matrix and range to read a video's YUV with: its colour tags, or BT.709 for an untagged HD source (colourOf). */
export const readColour = async (rt: Runtime, file: string, p: Probe): Promise<FootageColour> => colourOf((await runFfmpeg(rt, ['-i', file])).stderr, p.width, p.height);

/** Source frame count: probe's count, or duration x rate when probe could not count (ffmpeg 7 prints no frame= line for a stream copy). */
export const sourceFrames = (p: Probe): number => (p.frames > 0 ? p.frames : Math.ceil(p.duration * p.fps));

const expectedFrames = (o: DecodeOptions, p: Probe): number => {
  const start = o.startFrame ?? 0;
  const total = sourceFrames(p);
  const count = Math.max(0, Math.min(o.frameCount ?? total - start, total - start));
  if (o.fps !== undefined) return Math.ceil((count / (p.fps || 1)) * o.fps) + 1;
  return Math.ceil(count / Math.max(1, o.every ?? 1));
};

/** Reads ffmpeg's stdout straight into one Uint8Array per frame, so memory holds the frames and nothing else. */
const readFrames = async (rt: Runtime, args: string[], frameBytes: number, maxFrames: number): Promise<Uint8Array[]> => {
  const frames: Uint8Array[] = [];
  let current = new Uint8Array(frameBytes);
  let filled = 0;
  const r = await runFfmpeg(rt, ['-loglevel', 'error', ...args], undefined, (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameBytes - filled, chunk.length - off);
      current.set(chunk.subarray(off, off + n), filled);
      filled += n;
      off += n;
      if (filled === frameBytes) {
        if (frames.length < maxFrames) frames.push(current);
        current = new Uint8Array(frameBytes);
        filled = 0;
      }
    }
  });
  if (r.code !== 0) throw new FfmpegError('ffmpeg exited with ' + r.code + ' while decoding: ' + r.stderr.trim().split('\n').slice(-3).join(' | '), r.stderr);
  return frames;
};

/**
 * Decodes a video to raw thumbnails. Every source frame is kept unless 'every' or 'fps' is given (-fps_mode
 * passthrough, so no frame is duplicated or dropped to make a constant rate). Throws before decoding when the frames
 * would take more than about 600 MB.
 */
export const decodeFrames = async (rt: Runtime, file: string, opts: DecodeOptions): Promise<Decoded> => {
  if (!(opts.width >= 2)) throw new Error('decodeFrames: width must be at least 2 pixels (got ' + opts.width + '). Pass a thumbnail width such as 96.');
  const p = opts.probe ?? (await probe(rt, file));
  const colour = opts.colour ?? (await readColour(rt, file, p));
  const size = thumbSize(p.width, p.height, opts.width);
  const frameBytes = size.width * size.height * (opts.gray ? 1 : 3);
  const expected = expectedFrames(opts, p);
  const limit = opts.maxBytes ?? MAX_DECODE_BYTES;
  if (expected * frameBytes > limit) {
    const mb = Math.round((expected * frameBytes) / 1048576);
    throw new Error('decodeFrames(' + file + '): ' + expected + ' frames of ' + size.width + 'x' + size.height + ' would take about ' + mb
      + ' MB, more than the limit of ' + Math.round(limit / 1048576) + ' MB. Lower width, set gray: true, or decode a part with frameCount (or a lower fps / a larger every).');
  }
  const args = ['-i', file, '-map', '0:v:0', '-an', '-sn', '-vf', filterChain({ ...opts, colour }, size), '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
  const frames = await readFrames(rt, args, frameBytes, Math.max(expected * 2, 1));
  const fps = opts.fps ?? p.fps / Math.max(1, opts.every ?? 1);
  return { width: size.width, height: size.height, fps, frames };
};

/** Writes source frame 'frame' (0-based) of a video as a PNG or JPEG (by the extension of 'out'), optionally scaled to a width. */
export const extractFrame = async (rt: Runtime, file: string, frame: number, out: string, width?: number): Promise<void> => {
  const ext = out.toLowerCase().split('.').pop() ?? '';
  if (!['png', 'jpg', 'jpeg'].includes(ext)) throw new Error('extractFrame: unsupported output type ".' + ext + '" for ' + out + '. Allowed: .png, .jpg, .jpeg. Change the file name.');
  if (!Number.isInteger(frame) || frame < 0) throw new Error('extractFrame: frame must be a whole number >= 0 (got ' + frame + ').');
  const vf = ["select='eq(n," + frame + ")'", ...(width ? ['scale=' + Math.max(2, Math.round(width / 2) * 2) + ':-2:flags=area'] : [])].join(',');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vf', vf, '-fps_mode', 'passthrough', '-frames:v', '1',
    ...(ext === 'png' ? [] : ['-q:v', '2']), out]);
};
