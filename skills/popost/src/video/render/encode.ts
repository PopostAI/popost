/**
 * ffmpeg arguments of a render: screenshots on stdin -> H.264 (yuv420p, BT.709 matrix, limited range, tagged as such),
 * and the audio mix.
 */
import type { Duck, ResolvedAudio } from '../types';
import type { ImageFormat } from './session';

export interface EncodeJob {
  outputFps?: number;
  bitrate?: number;
  audioEnabled?: boolean;
  out: string;
  fps: number;
  /** Rendered range: frames from .. to-1 of the video. */
  from: number;
  to: number;
  image: ImageFormat;
  crf: number;
  /** The audio of the timeline, each src the file's absolute path. */
  audio: readonly ResolvedAudio[];
  /**
   * Threads of every input and of the encoder; absent: the CPU budget's (runFfmpeg). x264 writes other bytes for
   * another count, so a run whose output is compared across machines (the round trip) fixes it.
   */
  threads?: number;
}

const RATE = 48000;
const s6 = (v: number): string => String(Math.round(v * 1e6) / 1e6);

interface AudioInput { file: string; chain: string }

/**
 * The envelope of a sound that gives way to speech (timeline/mix.ts) as a volume filter, evaluated for every block of
 * samples: the gain in dB falls linearly from 0 to -db over the ramp before a span, holds through it and comes back
 * over the ramp after it. Times are seconds of the rendered range (offset: its first frame). '' when no span is heard
 * in the range.
 */
export const duckFilter = (duck: Duck | undefined, fps: number, offset = 0, duration = Infinity): string => {
  if (!duck) return '';
  /** The depth (0..1) of one lowering as an expression of t, or '' when none of its spans is heard in the range. */
  const depthOf = (spans: readonly (readonly [number, number])[], frames: number): string => {
    const ramp = frames / fps;
    const terms = spans
      .map(([start, end]) => [(start - offset) / fps, (end - offset) / fps] as const)
      .filter(([a, b]) => b + ramp > 0 && a - ramp < duration)
      .map(([a, b]) => 'min(clip((t-' + s6(a - ramp) + ')/' + s6(ramp) + ',0,1),clip((' + s6(b + ramp) + '-t)/' + s6(ramp) + ',0,1))');
    return terms.length ? terms.reduce((x, y) => 'max(' + x + ',' + y + ')') : '';
  };
  const under = depthOf(duck.spans, duck.ramp), away = duck.away ? depthOf(duck.away.spans, duck.away.ramp) : '';
  if (!under && !away) return '';
  // Without a span to give way on the expression is the one a sound under speech always had.
  if (!away) return ",volume=volume='pow(10,-" + s6(duck.db) + '/20*' + under + ")':eval=frame";
  const sum = [under ? s6(duck.db) + '*' + under : '', s6(duck.away?.db ?? 0) + '*' + away].filter(Boolean).join('+');
  return ",volume=volume='pow(10,-(" + sum + ")/20)':eval=frame";
};

/**
 * atempo filters that play a sound at a rate (pitch kept); one filter takes 0.5 to 2, so a rate outside that is two
 * in a row. '' for rate 1.
 */
export const tempoChain = (rate: number): string => {
  if (!(rate > 0) || rate === 1) return '';
  const steps = rate < 0.5 || rate > 2 ? [Math.sqrt(rate), Math.sqrt(rate)] : [rate];
  return steps.map((r) => ',atempo=' + s6(r)).join('');
};

/** Seconds of sound an item plays in the whole video, at the timeline's clock: from its start to its end, or the video's. */
export const heardSeconds = (a: ResolvedAudio, frames: number, fps: number): number => Math.max(0, ((a.end ?? frames) - a.start) / fps);

/**
 * One filter chain per audio item that sounds inside the range: trimmed, played at its rate, delayed to its start, gain
 * applied; an item with fadeOut fades to silence over its last seconds (at most half of what is heard of it).
 */
const audioInputs = (job: EncodeJob): AudioInput[] => {
  const duration = (job.to - job.from) / job.fps;
  return job.audio.flatMap((a) => {
    const start = (a.start - job.from) / job.fps;
    const end = a.end === undefined ? duration : Math.min(duration, (a.end - job.from) / job.fps);
    if (end <= Math.max(0, start) || start >= duration) return [];
    // Footage sound starts at its "in": source frame from.frame at the file's own rate.
    // A sound at another rate: the time before the range and the length heard are the timeline's, taken from the file at its rate.
    const rate = a.speed ?? 1;
    const skip = Math.max(0, -start) * rate + (a.from ? a.from.frame / a.from.fps : 0);
    const delay = Math.round(Math.max(0, start) * RATE);
    const length = end - Math.max(0, start);
    const chain = 'aresample=' + RATE + ',aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=' + s6(skip) + ':duration=' + s6(length * rate) +
      ',asetpts=PTS-STARTPTS' + tempoChain(rate) + ',adelay=delays=' + delay + 'S:all=1,volume=' + s6(a.gain) + 'dB' + duckFilter(a.duck, job.fps, job.from, duration);
    // The fade ends where the item ends in the video, which a part of the video being rendered may not reach.
    const whole = a.end === undefined ? end : (a.end - job.from) / job.fps;
    const fade = Math.min(a.fadeOut ?? 0, (a.end === undefined ? length : (a.end - a.start) / job.fps) / 2);
    return [{ file: a.src, chain: fade > 0 ? chain + ',afade=t=out:st=' + s6(Math.max(0, whole - fade)) + ':d=' + s6(fade) : chain }];
  });
};

/**
 * Mixed without normalisation (amix would otherwise lower every input), padded and cut to the video's length.
 * aresample=async=1:first_pts=0 writes the silence before a delayed sound as samples: without it, ffmpeg 7 sent the
 * silence of adelay only as a jump in timestamps when apad and atrim followed, and a plain decode of the file played
 * a sound placed at 1.0 s right at the start.
 */
const audioGraph = (inputs: readonly AudioInput[], duration: number): string => {
  const chains = inputs.map((x, i) => '[' + (i + 1) + ':a]' + x.chain + '[a' + i + ']');
  const labels = inputs.map((_x, i) => '[a' + i + ']').join('');
  const mix = inputs.length > 1 ? labels + 'amix=inputs=' + inputs.length + ':normalize=0:dropout_transition=0,' : labels;
  return [...chains, mix + 'aresample=async=1:first_pts=0,apad=whole_dur=' + s6(duration) + ',atrim=end=' + s6(duration) + '[aout]'].join(';');
};

/**
 * Screenshot -> YUV with an explicit matrix and range on both sides. PNG screenshots are sRGB RGB: converted with the
 * BT.709 matrix to limited range (flat colours come back within 1 level when decoded the same way). JPEG screenshots
 * are full-range BT.601 YUV: left to ffmpeg, they were read as limited range (mid grey came back 3 levels off), so
 * they go to RGB with their own matrix first. ffmpeg's own default for RGB -> YUV would be BT.601.
 */
export const colourFilter = (image: ImageFormat): string =>
  (image === 'jpeg' ? 'scale=in_color_matrix=bt601:in_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24,' : '') +
  'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';

export const encodeArgs = (job: EncodeJob): string[] => {
  const inputs = job.audioEnabled === false ? [] : audioInputs(job);
  const duration = (job.to - job.from) / job.fps;
  const audio = inputs.length === 0 ? ['-an'] : ['-filter_complex', audioGraph(inputs, duration), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE)];
  const threads = job.threads === undefined ? [] : ['-threads', String(Math.max(1, Math.floor(job.threads)))];
  return [
    '-y', '-loglevel', 'error',
    ...threads, '-f', 'image2pipe', '-framerate', String(job.fps), '-c:v', job.image === 'png' ? 'png' : 'mjpeg', '-i', 'pipe:0',
    ...inputs.flatMap((x) => [...threads, '-i', x.file]),
    '-map', '0:v',
    ...audio,
    '-vf', colourFilter(job.image) + (job.outputFps && job.outputFps !== job.fps ? ',fps=' + job.outputFps : ''),
    '-c:v', 'libx264', ...(job.bitrate ? ['-b:v', job.bitrate + 'M', '-maxrate', job.bitrate + 'M', '-bufsize', job.bitrate * 2 + 'M'] : ['-crf', String(job.crf)]), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(job.outputFps ?? job.fps), '-frames:v', String(Math.max(1, Math.round(duration * (job.outputFps ?? job.fps)))), '-movflags', '+faststart',
    ...threads, job.out,
  ];
};
