/**
 * A voice for new lines: each line is spoken into its own clip, the clips' lengths give the timing, and the clips are
 * laid on one track at the frames the timing says. Speaking needs a model, which does not live in this package: a
 * Speaker is the interface, and POPOST_TTS_CMD names a command that implements it, called as
 *   <command> <text.txt> <out.wav> [voice] [speed]
 * skills/popost/tools/video/tts-sherpa-kokoro is one such command for the development loop.
 */
import type { Runtime } from '../../runtime';
import { toolCommand, withTempDir } from '../host';
import { runFfmpeg, runFfmpegOk } from '../media/ffmpeg';
import { runTool } from '../tool';

export interface Speaker {
  /** Speaks text into a WAV file at out. voice and speed are passed on as given. */
  speak(text: string, out: string, opts?: { voice?: string; speed?: number }): Promise<void>;
}

const VARIABLE = 'POPOST_TTS_CMD';

/** The speaker behind POPOST_TTS_CMD, or undefined when it is not set. It runs its command through `rt`. */
export const commandSpeaker = (rt: Runtime): Speaker | undefined => {
  if (!toolCommand(rt, VARIABLE)) return undefined;
  return {
    speak: (text, out, opts = {}) =>
      withTempDir(rt, 'popost-video-tts-', async (dir) => {
        const file = rt.path.join(dir, 'text.txt');
        await rt.fs.writeFile(file, text);
        await runTool(rt, VARIABLE, 'The speaker', [file, out, opts.voice ?? '', String(opts.speed ?? 1)]);
      }),
  };
};

/** Length of an audio file in seconds, by decoding it to nothing and reading the last time ffmpeg reports. */
export const audioSeconds = async (rt: Runtime, file: string): Promise<number> => {
  const r = await runFfmpeg(rt, ['-i', file, '-vn', '-f', 'null', '-']);
  const times = [...r.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times[times.length - 1];
  if (r.code !== 0 || !last) throw new Error('Could not read the length of ' + file + '.');
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
};

export interface VoiceLine {
  text: string;
  /** The clip of this line, or undefined for an empty line. */
  file?: string;
  /** Length of the clip in frames, silence at both ends removed; 0 for an empty line. */
  frames: number;
  /**
   * The words of the clip with their times in seconds from its first sound, when the speaker gave them (it wrote
   * <out.wav>.words.json: { "words": [{ "text", "start", "end" }] }, seconds from the start of the file it wrote).
   */
  words?: SpokenTime[];
}

export interface SpokenTime { text: string; start: number; end: number }

/** The word times a speaker left beside its clip, moved so that the first word starts at 0 (the clip is trimmed to its first sound). */
const wordsBeside = async (rt: Runtime, clip: string): Promise<SpokenTime[] | undefined> => {
  const file = clip + '.words.json';
  const raw = await rt.fs.readText(file).then((t) => JSON.parse(t) as { words?: unknown }, () => undefined);
  await rt.fs.rm(file);
  const list = Array.isArray(raw?.words) ? (raw.words as Partial<SpokenTime>[]).filter((w): w is SpokenTime => typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number') : [];
  const first = list[0];
  if (!first) return undefined;
  return list.map((w) => ({ text: w.text, start: Math.max(0, w.start - first.start), end: Math.max(0, w.end - first.start) }));
};

/** Silence at the start and at the end of a clip is cut off, so that a line starts on its first sound. */
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse';

/** Speaks every non-empty line into dir/line-NN.wav (48 kHz mono, trimmed) and measures it. */
export const speakLines = async (rt: Runtime, o: { lines: string[]; dir: string; speaker: Speaker; fps: number; voice?: string; speed?: number }): Promise<VoiceLine[]> => {
  await rt.fs.mkdir(o.dir);
  const out: VoiceLine[] = [];
  for (const [i, raw] of o.lines.entries()) {
    const text = raw.trim();
    if (!text) { out.push({ text, frames: 0 }); continue; }
    const rawFile = rt.path.join(o.dir, 'raw-' + String(i + 1).padStart(2, '0') + '.wav');
    const file = rt.path.join(o.dir, 'line-' + String(i + 1).padStart(2, '0') + '.wav');
    await o.speaker.speak(text, rawFile, { ...(o.voice ? { voice: o.voice } : {}), ...(o.speed ? { speed: o.speed } : {}) });
    const words = await wordsBeside(rt, rawFile);
    await runFfmpegOk(rt, ['-y', '-i', rawFile, '-af', TRIM, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
    await rt.fs.rm(rawFile);
    out.push({ text, file, frames: Math.max(1, Math.ceil((await audioSeconds(rt, file)) * o.fps)), ...(words ? { words } : {}) });
  }
  return out;
};

/** Lays the clips on one track: clip i starts at frame starts[i]. Writes AAC (or WAV, by the extension of out). */
export const mixLines = async (rt: Runtime, o: { lines: VoiceLine[]; starts: number[]; fps: number; totalFrames: number; out: string }): Promise<void> => {
  const clips = o.lines.flatMap((l, i) => (l.file ? [{ file: l.file, start: o.starts[i] ?? 0 }] : []));
  if (!clips.length) throw new Error('There is no spoken line to mix.');
  await rt.fs.mkdir(rt.path.dirname(o.out));
  const chains = clips.map((c, i) => '[' + i + ':a]aresample=48000,adelay=delays=' + Math.round((c.start / o.fps) * 48000) + 'S:all=1[a' + i + ']');
  const mix = clips.map((_c, i) => '[a' + i + ']').join('') + (clips.length > 1 ? 'amix=inputs=' + clips.length + ':normalize=0:dropout_transition=0,' : '') +
    'aresample=async=1:first_pts=0,apad=whole_dur=' + (o.totalFrames / o.fps).toFixed(6) + ',atrim=end=' + (o.totalFrames / o.fps).toFixed(6) + '[out]';
  const codec = o.out.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '160k'];
  await runFfmpegOk(rt, ['-y', ...clips.flatMap((c) => ['-i', c.file]), '-filter_complex', [...chains, mix].join(';'), '-map', '[out]', ...codec, o.out]);
};
