/**
 * Checks an encoded file against what was rendered: frame count, size and frame rate.
 */
import type { Runtime } from '../../runtime';
import { probe, runFfmpegOk } from '../media/ffmpeg';

export interface Expected { frames: number; width: number; height: number; fps: number }

/**
 * Exact number of video packets (one per frame for H.264), read without decoding. Used when probe() reports 0:
 * the ffmpeg 7.0 build on the development machine prints no "frame=" count for a stream copy, which probe() parses.
 */
export const countPackets = async (rt: Runtime, file: string): Promise<number> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']);
  return new TextDecoder().decode(r.stdout).split('\n').filter((line) => line !== '' && !line.startsWith('#')).length;
};

export const verifyVideo = async (rt: Runtime, file: string, want: Expected): Promise<void> => {
  const got = await probe(rt, file);
  const frames = got.frames > 0 ? got.frames : await countPackets(rt, file);
  const ok = frames === want.frames && got.width === want.width && got.height === want.height && Math.abs(got.fps - want.fps) < 0.01;
  if (!ok)
    throw new Error('renderVideo: the encoded file has ' + frames + ' frames of ' + got.width + 'x' + got.height + ' at ' + got.fps + ' fps, but ' + want.frames +
      ' frames of ' + want.width + 'x' + want.height + ' at ' + want.fps + ' fps were rendered. The output was removed; report this with the project.');
};
