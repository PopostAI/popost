/**
 * Video footage on disk: what a video file is (probe() plus its colour tags), and its frames extracted as lossless PNG
 * pictures, colour-true, into a cache directory. The page shows footage as these pictures, one per source frame.
 */
import type { Runtime } from '../../runtime';
import type { FootageFacts } from '../types';
import { FRAME_DIGITS, framePath } from '../timeline/footage';
import { probe, runFfmpeg, runFfmpegOk } from './ffmpeg';

/** How the source's YUV values are to be read: the matrix and the range of its colour tags. */
export interface FootageColour { matrix: 'bt709' | 'bt601' | 'bt2020'; range: 'tv' | 'pc' }

const MATRICES: Readonly<Record<string, FootageColour['matrix']>> = {
  bt709: 'bt709', bt470bg: 'bt601', smpte170m: 'bt601', bt601: 'bt601', bt2020nc: 'bt2020', bt2020c: 'bt2020',
};

/**
 * The colour matrix and range of the first video stream, from ffmpeg's description of it, e.g.
 * "yuv420p(tv, bt709, progressive)" or "yuvj420p(pc, bt470bg/unknown/unknown)". An untagged source is read as BT.709
 * when it is HD (either side at least 720 pixels) and as BT.601 below, as players do; ffmpeg alone would read every
 * untagged source as BT.601, which moves saturated colours of HD footage by up to about 20 levels.
 */
export const colourOf = (stderr: string, width: number, height: number): FootageColour => {
  const m = stderr.match(/Stream #0:\d+[^\n]*: Video: [^\n]*?, (\w+)\(([^)]*)\)/);
  const pixFmt = m?.[1] ?? '';
  const tags = (m?.[2] ?? '').split(',').map((s) => s.trim());
  const space = tags.map((t) => t.split('/')[0] ?? '').find((t) => MATRICES[t] !== undefined);
  const range = tags.includes('pc') || pixFmt.startsWith('yuvj') ? 'pc' : 'tv';
  return { matrix: space ? (MATRICES[space] ?? 'bt709') : Math.max(width, height) >= 720 ? 'bt709' : 'bt601', range };
};

/** Size, rate, exact frame count, sound and colour of a video file. Throws an FfmpegError when it is not a video ffmpeg reads. */
export const readFootage = async (rt: Runtime, file: string): Promise<{ facts: FootageFacts; colour: FootageColour }> => {
  const [p, header] = await Promise.all([probe(rt, file), runFfmpeg(rt, ['-i', file])]);
  if (!(p.frames > 0) || !(p.fps > 0)) throw new Error('no video frames were found in ' + rt.path.basename(file));
  return { facts: { width: p.width, height: p.height, fps: p.fps, frames: p.frames, hasAudio: p.hasAudio }, colour: colourOf(header.stderr, p.width, p.height) };
};

/** Bumped whenever the pictures an extraction writes would change, so that old caches are not reused. */
export const EXTRACT_VERSION = 2;

export interface ExtractJob {
  /** Absolute path of the video. */
  file: string;
  /** Absolute cache directory of this file at this size. */
  dir: string;
  /** Source frames needed, ascending. */
  frames: readonly number[];
  width: number;
  height: number;
  colour: FootageColour;
}

/**
 * Read the source YUV with its own matrix and range into RGB, then keep those RGB values losslessly. A second
 * RGB-to-JPEG conversion introduced cumulative colour drift before the final video encode, even at maximum quality.
 */
const filterChain = (job: ExtractJob, lo: number, hi: number): string => [
  'trim=start_frame=' + lo + ':end_frame=' + (hi + 1),
  'setpts=PTS-STARTPTS',
  'scale=' + job.width + ':' + job.height + ':in_color_matrix=' + job.colour.matrix + ':in_range=' + job.colour.range + ':flags=lanczos+accurate_rnd+full_chroma_int',
  'format=rgb24',
].join(',');

/** The file name of a source frame's picture inside a cache directory. */
const frameName = (frame: number): string => framePath('', frame).slice(1);

/**
 * Writes the pictures of the needed frames that the cache directory does not have yet: one ffmpeg pass over the range
 * of the missing frames, decoded in order (frame numbers are the source's own, 0-based). Pictures are written to a
 * temporary directory and moved into place, so a picture in the cache is always complete.
 */
export const extractFrames = async (rt: Runtime, job: ExtractJob): Promise<{ extracted: number; reused: number }> => {
  const { fs, path } = rt;
  await fs.mkdir(job.dir);
  const have = new Set(await fs.readdir(job.dir));
  const missing = job.frames.filter((f) => !have.has(frameName(f)));
  if (missing.length === 0) return { extracted: 0, reused: job.frames.length };
  const lo = missing[0] ?? 0;
  const hi = missing[missing.length - 1] ?? 0;
  // Inside the cache directory, so that moving a picture into place is a rename on one disk.
  const tmp = path.join(job.dir, '.extract-' + rt.randomUUID());
  await fs.mkdir(tmp);
  try {
    await runFfmpegOk(rt, ['-loglevel', 'error', '-i', job.file, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filterChain(job, lo, hi), '-fps_mode', 'passthrough',
      '-c:v', 'png', '-compression_level', '1', '-start_number', '0', path.join(tmp, '%0' + FRAME_DIGITS + 'd.png')]);
    const written = new Set(await fs.readdir(tmp));
    const absent = missing.filter((f) => !written.has(frameName(f - lo)));
    if (absent.length > 0)
      throw new Error('Extracting frames ' + lo + '..' + hi + ' of ' + job.file + ' gave ' + written.size + ' pictures; frame ' + absent[0] + ' is missing. The file may be damaged or shorter than its header says; re-encode it with ffmpeg.');
    for (const f of missing) await fs.rename(path.join(tmp, frameName(f - lo)), path.join(job.dir, frameName(f)));
    return { extracted: missing.length, reused: job.frames.length - missing.length };
  } finally {
    await fs.rm(tmp);
  }
};
