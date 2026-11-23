/**
 * Renders a project directory: a video (frames piped from Chrome into one ffmpeg process, audio mixed in the same
 * process), one frame as PNG, or a session that keeps a page open for many frames.
 */
import type { Runtime } from '../../runtime';
import { cpuBudgetOf } from '../host';
import { FfmpegError, runFfmpeg } from '../media/ffmpeg';
import { encodeArgs } from './encode';
import { verifyVideo } from './verify';
import { openSession, type ImageFormat, type Session } from './session';

export { checkLayout } from './layout';

export interface RenderVideoOptions {
  /** The project directory and the output file, as the user typed them (against rt.cwd). */
  projectDir: string;
  out: string;
  scale?: number;
  /** First frame (default 0) and end frame, exclusive (default: the video's length). */
  from?: number;
  to?: number;
  crf?: number;
  /** Threads of the encoder (and of ffmpeg's inputs); absent: the CPU budget's. See EncodeJob.threads. */
  encoderThreads?: number;
  onProgress?: (frame: number, total: number) => void;
  /**
   * Screenshot format piped to ffmpeg. Default png: measured as fast as JPEG at quality 92 (3.9 vs 3.7 ms per frame at
   * 180x320, 18.2 vs 18.8 at 540x960) and lossless, where the JPEG route lost 39.5 dB / 42.7 dB PSNR against it.
   */
  image?: ImageFormat;
  /**
   * Pages (each its own Chrome) that draw frames side by side. A frame is a pure function of its number, so the
   * video is the same for any count. Default: POPOST_RENDER_PAGES, or by the size of the job (pagesFor).
   */
  pages?: number;
  /** false: a screenshot of every frame, also where the picture does not change (to check the reuse against). */
  reuse?: boolean;
}

export interface RenderVideoResult {
  frames: number; width: number; height: number; fps: number; ms: number;
  /** Pages that drew, and how many frames were a screenshot returned again because the picture had not changed. */
  pages: number;
  reused: number;
}

const JPEG_QUALITY = 92;

/** A frame or a range that the video does not have: the caller asked for it, so the message says what it has. */
export class RenderRangeError extends Error {
  override name = 'RenderRangeError';
}

const range = (opts: RenderVideoOptions, frames: number): [number, number] => {
  const from = opts.from ?? 0;
  const to = opts.to ?? frames;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > frames || from >= to)
    throw new RenderRangeError('renderVideo: from ' + from + ' / to ' + to + ' is not a range of this video, which has frames 0..' + (frames - 1) + '. Use whole numbers with 0 <= from < to <= ' + frames + '.');
  return [from, to];
};

export const MAX_PAGES = 4;
/** Pixels times frames that are worth one more page: below it, starting another Chrome costs more than it saves. */
const WORK_PER_PAGE = 150e6;

/**
 * How many pages draw a job of this size. Asked for (opts.pages or POPOST_RENDER_PAGES): that many, at most 8 and at
 * most one per frame. Otherwise one page per WORK_PER_PAGE, at most MAX_PAGES and a quarter of the CPU budget (one
 * page below eight processors): a page is a whole Chrome that draws in software, and the encoder needs processors too. Measured on 8 busy cores at
 * 1280x720 with video bases: 52 ms per frame with one page, 34 with two, 40 with four.
 */
export const pagesFor = (rt: Runtime, job: { frames: number; width: number; height: number; pages?: number }): number => {
  const asked = job.pages ?? (Number(rt.env.POPOST_RENDER_PAGES) || undefined);
  if (asked !== undefined) return Math.max(1, Math.min(8, job.frames, Math.floor(asked)));
  const limit = Math.min(MAX_PAGES, Math.max(1, Math.floor(cpuBudgetOf(rt).cpus / 4)));
  return Math.max(1, Math.min(limit, Math.ceil((job.frames * job.width * job.height) / WORK_PER_PAGE)));
};

/**
 * The screenshots of frames from .. to-1, in order. Frame n is drawn by page (n - from) modulo the page count, and
 * every page is asked a few frames ahead, so the pages draw side by side while the frames leave in order. A failure
 * ends the stream (so ffmpeg sees its input end) and is kept in box.
 */
async function* screenshots(sessions: Session[], from: number, to: number, image: ImageFormat, box: { error?: unknown }, onProgress?: (f: number, t: number) => void): AsyncGenerator<Buffer> {
  const ahead = sessions.length * 2;
  const waiting: Promise<Buffer>[] = [];
  let asked = from;
  const ask = (upTo: number): void => {
    for (; asked < Math.min(to, upTo); asked++) {
      const shot = (sessions[(asked - from) % sessions.length] as Session).frame(asked, image, JPEG_QUALITY);
      shot.catch(() => undefined);
      waiting.push(shot);
    }
  };
  try {
    for (let n = from; n < to; n++) {
      ask(n + 1 + ahead);
      yield await (waiting.shift() as Promise<Buffer>);
      onProgress?.(n - from + 1, to - from);
    }
  } catch (e) {
    box.error = e;
  }
}

export const renderVideo = async (rt: Runtime, opts: RenderVideoOptions): Promise<RenderVideoResult> => {
  const t0 = performance.now();
  const sessionOptions = { scale: opts.scale, ...(opts.reuse === false ? { reuse: false } : {}) };
  // The first page also fills the project's cache (frames of video materials); the others open once it is there.
  const session = await openSession(rt, opts.projectDir, sessionOptions);
  const sessions = [session];
  const out = rt.path.resolve(rt.cwd, opts.out);
  const partial = out + '.partial' + (rt.path.extname(out) || '.mp4');
  try {
    const r = session.resolved;
    const [from, to] = range(opts, r.frames);
    const pages = pagesFor(rt, { frames: to - from, width: session.width, height: session.height, ...(opts.pages === undefined ? {} : { pages: opts.pages }) });
    for (const s of await Promise.allSettled(Array.from({ length: pages - 1 }, () => openSession(rt, opts.projectDir, sessionOptions)))) {
      if (s.status === 'fulfilled') sessions.push(s.value);
    }
    if (sessions.length < pages) throw new Error('renderVideo: only ' + sessions.length + ' of ' + pages + ' pages could be opened. Render with fewer pages (pages, or POPOST_RENDER_PAGES=1).');
    const image = opts.image ?? 'png';
    await rt.fs.mkdir(rt.path.dirname(out));
    const root = rt.path.resolve(rt.cwd, opts.projectDir);
    const audio = r.audio.map((a) => ({ ...a, src: rt.path.resolve(root, a.src) }));
    const args = encodeArgs({ out: partial, fps: r.canvas.fps, from, to, image, crf: opts.crf ?? 18, audio, ...(opts.encoderThreads === undefined ? {} : { threads: opts.encoderThreads }) });
    const box: { error?: unknown } = {};
    // At Chrome's priority: the encoder drains the pages (runFfmpeg).
    const result = await runFfmpeg(rt, args, screenshots(sessions, from, to, image, box, opts.onProgress), undefined, { lowPriority: false });
    if (box.error) throw box.error;
    if (result.code !== 0) throw new FfmpegError('renderVideo: ffmpeg exited with ' + result.code + ': ' + result.stderr.trim().split('\n').slice(-3).join(' | '), result.stderr);
    const want = { frames: to - from, width: session.width, height: session.height, fps: r.canvas.fps };
    await verifyVideo(rt, partial, want);
    await rt.fs.rename(partial, out);
    return { ...want, ms: Math.round(performance.now() - t0), pages, reused: sessions.reduce((n, s) => n + s.counts().reused, 0) };
  } catch (e) {
    await rt.fs.rm(partial);
    throw e;
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
};

export interface Renderer {
  width: number;
  height: number;
  frames: number;
  /** PNG of frame n. */
  frame(n: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Keeps one page open for many frames. Every frame is a screenshot of its own unless opts.reuse is true. */
export const openRenderer = async (rt: Runtime, projectDir: string, opts: { scale?: number; reuse?: boolean } = {}): Promise<Renderer> => {
  const session = await openSession(rt, projectDir, { scale: opts.scale, reuse: opts.reuse === true });
  return { width: session.width, height: session.height, frames: session.resolved.frames, frame: (n) => session.frame(n, 'png'), close: () => session.close() };
};

/** Writes one frame as PNG. projectDir and out: as the user typed them (against rt.cwd). */
export const renderFrame = async (rt: Runtime, opts: { projectDir: string; frame: number; out: string; scale?: number }): Promise<{ width: number; height: number }> => {
  const renderer = await openRenderer(rt, opts.projectDir, { scale: opts.scale });
  try {
    if (!Number.isInteger(opts.frame) || opts.frame < 0 || opts.frame >= renderer.frames)
      throw new RenderRangeError('renderFrame: frame ' + opts.frame + ' is outside the video, which has frames 0..' + (renderer.frames - 1) + '.');
    await rt.fs.writeFile(rt.path.resolve(rt.cwd, opts.out), await renderer.frame(opts.frame));
    return { width: renderer.width, height: renderer.height };
  } finally {
    await renderer.close();
  }
};
