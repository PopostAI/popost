/**
 * The one place that finds and runs ffmpeg. The engine needs ffmpeg only (no ffprobe): POPOST_FFMPEG, then PATH.
 */
import type { LocalPrograms, Runtime } from '../../runtime';
import { VideoUnavailableError, cpuBudgetOf, programsOf } from '../host';
import type { Probe } from '../types';

export class FfmpegError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'FfmpegError';
    this.stderr = stderr;
  }
}

export const ffmpegPath = (rt: Runtime): string => rt.env.POPOST_FFMPEG || 'ffmpeg';

export interface RunResult { code: number; stdout: Uint8Array; stderr: string }

/**
 * A run's arguments with its threads taken from the CPU budget, so that no ffmpeg sizes its pools by the machine:
 * `-threads` before every input (decoding) and before the output (the encoder, x264 in a render), and the global
 * `-filter_threads` and `-filter_complex_threads` for the filters. A run with no input (`-version`) is left alone,
 * and so is any of these options the caller set itself. Decoding and filtering give the same pictures with any number
 * of threads; an x264 encode does not promise the same bytes for a different count.
 */
export const withThreads = (args: readonly string[], cpus: number): string[] => {
  if (!args.includes('-i')) return [...args];
  const n = String(Math.max(1, Math.floor(cpus)));
  const globals = (['-filter_threads', '-filter_complex_threads'] as const).flatMap((o) => (args.includes(o) ? [] : [o, n]));
  if (args.includes('-threads')) return [...globals, ...args];
  const inputs = args.flatMap((a) => (a === '-i' ? ['-threads', n, '-i'] : [a]));
  // The last argument is the output, unless the run names an input only (to have ffmpeg describe it).
  const output = args.length >= 2 && args[args.length - 2] !== '-i' ? [...inputs.slice(0, -1), '-threads', n, ...inputs.slice(-1)] : inputs;
  return [...globals, ...output];
};

/**
 * Runs ffmpeg with -hide_banner, threads from the CPU budget (withThreads) and a priority below the CLI's. stdin:
 * bytes to pipe in. Resolves whatever the exit code; see runFfmpegOk.
 *
 * o.lowPriority false: an encoder that drains Chrome's frames (render, capture) runs at the priority of Chrome, which
 * the CLI cannot lower. Below it, the encoder waits whenever Chrome draws: on one processor a render of the showcase
 * took 218 s with the encoder lowered and 53 s with both at the same priority.
 */
export const runFfmpeg = async (rt: Runtime, args: string[], stdin?: Uint8Array | AsyncIterable<Uint8Array>, onStdout?: (chunk: Uint8Array) => void, o: { lowPriority?: boolean } = {}): Promise<RunResult> => {
  const programs = programsOf(rt);
  const argv = [ffmpegPath(rt), '-hide_banner', ...withThreads(args, cpuBudgetOf(rt).cpus)];
  try {
    return await programs.run(argv, { lowPriority: o.lowPriority ?? true, ...(stdin === undefined ? {} : { stdin }), ...(onStdout ? { onStdout } : {}) });
  } catch (e) {
    // Only a program that could not be started is ffmpeg's fault; an error thrown by the stdin iterable is the caller's.
    if (typeof (e as { code?: unknown } | null)?.code !== 'string') throw e;
    throw new VideoUnavailableError('ffmpeg could not be started (' + (e instanceof Error ? e.message : String(e)) + '). Install ffmpeg or set POPOST_FFMPEG.');
  }
};

export const runFfmpegOk = async (rt: Runtime, args: string[], stdin?: Uint8Array | AsyncIterable<Uint8Array>): Promise<RunResult> => {
  const r = await runFfmpeg(rt, args, stdin);
  if (r.code !== 0) throw new FfmpegError('ffmpeg exited with ' + r.code + ': ' + r.stderr.trim().split('\n').slice(-3).join(' | '), r.stderr);
  return r;
};

const available = new WeakMap<LocalPrograms, Map<string, Promise<boolean>>>();
/** True when ffmpeg can be run. Tests that need it skip when this is false. Asked once per runtime and ffmpeg path. */
export const hasFfmpeg = (rt: Runtime): Promise<boolean> => {
  if (!rt.programs) return Promise.resolve(false);
  const known = available.get(rt.programs) ?? new Map<string, Promise<boolean>>();
  available.set(rt.programs, known);
  const name = ffmpegPath(rt);
  const asked = known.get(name) ?? runFfmpeg(rt, ['-version']).then((r) => r.code === 0, () => false);
  known.set(name, asked);
  return asked;
};

const rational = (s: string): number => {
  const [a, b] = s.split('/').map(Number);
  return b ? (a ?? 0) / b : (a ?? 0);
};

/** Packet presentation time, not container/audio tail length or a variable stream's nominal frame rate. */
export const packetClock = (crc: string): { frames: number; duration?: number; fps?: number } => {
  const rows = crc.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  const tb = crc.match(/^#tb\s+0:\s*(\d+\/\d+)/m)?.[1];
  const ticks = tb ? rational(tb) : 0;
  let first = Infinity, end = -Infinity;
  for (const row of rows) {
    const parts = row.split(',').map(s => s.trim());
    const pts = Number(parts[2]), duration = Number(parts[3]);
    if (parts.length < 4 || !Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0) return { frames: rows.length };
    first = Math.min(first, pts); end = Math.max(end, pts + duration);
  }
  const duration = (end - first) * ticks;
  return duration > 0 && Number.isFinite(duration) ? { frames: rows.length, duration, fps: rows.length / duration } : { frames: rows.length };
};

/**
 * Size, frame rate, frame count and duration of a video file. The frame count is exact: the packets of the video
 * stream are listed without decoding (one line each from the framecrc muxer) and counted.
 */
export const probe = async (rt: Runtime, file: string): Promise<Probe> => {
  const r = await runFfmpeg(rt, ['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']);
  const video = r.stderr.match(/Stream #0:\d+[^\n]*: Video: [^\n]*/);
  if (!video) throw new FfmpegError('No video stream found in ' + file, r.stderr);
  const size = video[0].match(/, (\d{2,5})x(\d{2,5})[ ,[]/);
  const fpsText = video[0].match(/, ([\d.]+) fps/)?.[1] ?? video[0].match(/, ([\d.]+) tbr/)?.[1];
  const reportedAverage = video[0].match(/, ([\d.]+) fps/)?.[1];
  const rate = r.stderr.match(/r_frame_rate=(\d+\/\d+)/)?.[1];
  const clock = packetClock(new TextDecoder('latin1').decode(r.stdout));
  const frames = clock.frames;
  const d = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  if (!size || !fpsText) throw new FfmpegError('Could not read the size or frame rate of ' + file, r.stderr);
  // Presentation reordering/edit lists can leave terminal packet PTS beyond a stream's declared end. In that
  // case its reported average is preferable to the packet envelope (and never to the nominal tbr). Keep the
  // exact packet clock for CFR/fractional rates when the difference is only the header's printed precision.
  const precision = reportedAverage ? Math.min(.005, .5 / 10 ** (reportedAverage.split('.')[1]?.length ?? 0)) : Infinity;
  const edited = clock.fps !== undefined && reportedAverage !== undefined && Math.abs(clock.fps - Number(reportedAverage)) > precision + 1e-9;
  const fps = edited ? Number(reportedAverage) : clock.fps ?? (rate ? rational(rate) : Number(fpsText));
  return { width: Number(size[1]), height: Number(size[2]), fps, frames, duration: frames && fps ? frames / fps : duration, hasAudio: /Stream #0:\d+[^\n]*: Audio:/.test(r.stderr) };
};
