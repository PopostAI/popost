/**
 * Pictures for a model that reads them: one frame of a video, or a PNG the renderer drew, as a small JPEG data URL.
 * Frames go to the model inside the request; nothing is uploaded anywhere else. The scene writer and the plan step
 * (plan/see.ts, which re-exports them) both use these.
 */
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from '../media/ffmpeg';

/** Times inside a shot to look at: spread evenly, away from its two ends (where a transition may still show). */
export const lookTimes = (start: number, end: number, n: number): number[] =>
  Array.from({ length: n }, (_x, k) => start + ((end - start) * (k + 1)) / (n + 1));

/** ffmpeg's scale filter that makes the longer side maxSide pixels, keeping the proportions (even sizes). */
const longerSide = (maxSide: number): string => "scale='if(gt(iw,ih)," + maxSide + ",-2)':'if(gt(iw,ih),-2," + maxSide + ")'";

const jpegUrl = (bytes: Uint8Array): string => 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');

/** One frame of a video, or a picture file (seconds undefined), as a JPEG data URL whose longer side is maxSide. */
export const pictureUrl = async (rt: Runtime, file: string, maxSide: number, seconds?: number): Promise<string> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', ...(seconds === undefined ? [] : ['-ss', seconds.toFixed(3)]), '-i', file, '-frames:v', '1', '-vf', longerSide(maxSide), '-q:v', '6', '-f', 'mjpeg', 'pipe:1']);
  if (!r.stdout.length) throw new Error('No picture could be read from ' + file + (seconds === undefined ? '' : ' at ' + seconds.toFixed(2) + ' s') + '.');
  return jpegUrl(r.stdout);
};

/** A PNG in memory (a frame the renderer drew) as a small JPEG data URL. */
export const pngUrl = async (rt: Runtime, png: Uint8Array, maxSide: number): Promise<string> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', longerSide(maxSide), '-q:v', '6', '-f', 'mjpeg', 'pipe:1'], png);
  return jpegUrl(r.stdout);
};
