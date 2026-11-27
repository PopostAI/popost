/**
 * Running readback on a render, fast enough that an agent waits for it. The text reader reads the frames
 * readback-frames.ts chooses, each text item and each shot twice where it stands whole and at most two frames a
 * second, not the five a second that describe reads a reference with: readback knows from the project when every text
 * is on screen. The transcript is kept beside readback.json with a hash of the render's sound and used again while the
 * sound is the same (a render after a scene was fixed). A line on stderr says first what will be done and how long it
 * takes, then how far it is.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { cpuBudgetOf, partsSideBySide, withTempDir } from '../host';
import { probe } from '../media/ffmpeg';
import { speechWav } from '../media/wav';
import { watchProgress, type OnStage, type Progress } from '../progress';
import { toFrames } from '../speech/index';
import type { Transcriber, Transcript } from '../speech/types';
import { cuesOf } from '../text/index';
import { readbackFrames, readFrames, readingSpan } from './readback-frames';
import { measureContrast, type CaptionContrast } from './contrast';
import type { TextReader, TextTrack } from '../text/types';
import type { Resolved } from '../types';

/** Where the transcript of the last readback is kept, in the project. */
export const TRANSCRIPT_CACHE = 'readback.transcript.json';
const CACHE_FORMAT = 'popost-video-readback-transcript';

/** Frames read first, spread over the video, to see how much text a frame holds before the rest is read. */
export const FIRST_LOOK = 8;
/**
 * The reader's work grows with the text on a frame: at budget 3 it took 0.065 s a frame and 0.031 s a line found
 * (fitted on 16, 4 and 1 frames of captions, about 3.6 lines a frame, and of pages full of text, 46 to 60). PER_FRAME
 * is for frames like the first; textFactor scales it to the lines the first look found, from half to ten times.
 */
const PER_READ_FRAME = 0.065, PER_LINE = 0.031, TYPICAL_LINES = 3.6;
export const textFactor = (linesPerFrame: number): number =>
  Math.min(10, Math.max(0.5, (PER_READ_FRAME + PER_LINE * linesPerFrame) / (PER_READ_FRAME + PER_LINE * TYPICAL_LINES)));

/** Seconds of work per frame read and per second of sound heard, at a CPU budget of 1, 2, 3 and 4 or more (measured, T011). */
const PER_FRAME = [0.34, 0.24, 0.18, 0.15];
const PER_SOUND_SECOND = [0.27, 0.22, 0.19, 0.13];

/** About how long readback takes, in seconds, to ten. */
export const readbackEstimate = (o: { frames: number; soundSeconds: number; cpus: number; together: boolean; text?: number }): number => {
  const k = Math.min(4, Math.max(1, o.cpus)) - 1;
  const read = o.frames * (PER_FRAME[k] ?? 0.15) * (o.text ?? 1), hear = o.soundSeconds * (PER_SOUND_SECOND[k] ?? 0.13);
  return Math.max(10, Math.round(((o.together ? Math.max(read, hear) : read + hear) + 3) / 10) * 10);
};

/** What a kept transcript is kept for: the render's sound, the language asked for, the transcriber and the frame rate. */
const transcriptKey = (rt: Runtime, wav: Uint8Array, language: string | undefined, fps: number): string =>
  sha256(sha256(wav) + '|' + (language ?? '') + '|' + (rt.env.POPOST_ASR_CMD || 'popost.ai') + '|' + fps);

const keptTranscript = async (rt: Runtime, cacheFile: string, key: string): Promise<Transcript | undefined> => {
  const kept = await rt.fs.readText(cacheFile).then((t) => JSON.parse(t) as { format?: string; key?: string; transcript?: Transcript }, () => undefined);
  return kept?.format === CACHE_FORMAT && kept.key === key ? kept.transcript : undefined;
};

/** Whether the project keeps a transcript of this sound (the render's WAV as the transcribers hear it): hearing it again is free. */
export const keptFor = (rt: Runtime, dir: string, language?: string) => async (wav: Uint8Array, fps: number): Promise<boolean> =>
  (await keptTranscript(rt, rt.path.join(dir, TRANSCRIPT_CACHE), transcriptKey(rt, wav, language, fps))) !== undefined;

/** The render's sound as the transcriber hears it, and its transcript: the kept one when the sound is the same. */
const hear = async (rt: Runtime, o: { video: string; cacheFile: string; transcriber: Transcriber; language?: string; onStage?: OnStage }): Promise<{ transcript?: Transcript; reused: boolean }> => {
  const info = await probe(rt, o.video);
  if (!info.hasAudio) return { reused: false };
  return withTempDir(rt, 'popost-video-audio-', async (dir) => {
    const wav = rt.path.join(dir, 'audio.wav');
    o.onStage?.('taking the sound out');
    await speechWav(rt, o.video, wav);
    const key = transcriptKey(rt, await rt.fs.readFile(wav), o.language, info.fps);
    const kept = await keptTranscript(rt, o.cacheFile, key);
    if (kept) return { transcript: kept, reused: true };
    o.onStage?.('the transcriber is listening to ' + info.duration.toFixed(1) + ' s of sound');
    const transcript = toFrames(await o.transcriber.transcribe(wav, o.language), info.fps);
    await rt.fs.writeFile(o.cacheFile, JSON.stringify({ format: CACHE_FORMAT, key, transcript }) + '\n');
    return { transcript, reused: false };
  });
};

/**
 * A reader that reads FIRST_LOOK frames spread over its first list before the rest, and says how much text they held;
 * the samples are the same as reading the list at once (each frame is read on its own).
 */
export const lookingFirst = (reader: TextReader, onFirst: (linesPerFrame: number) => void): TextReader => {
  let looked = false;
  return {
    read: async (frames) => {
      if (looked || frames.length < 3 * FIRST_LOOK) return reader.read(frames);
      looked = true;
      const picked = new Set(Array.from({ length: FIRST_LOOK }, (_, k) => Math.floor(((2 * k + 1) * frames.length) / (2 * FIRST_LOOK))));
      const first = await reader.read(frames.filter((_, i) => picked.has(i)));
      onFirst(first.reduce((n, s) => n + s.lines.length, 0) / FIRST_LOOK);
      const rest = await reader.read(frames.filter((_, i) => !picked.has(i)));
      return [...first, ...rest].sort((a, b) => a.frame - b.frame);
    },
  };
};

export interface ReadbackRun {
  text: TextTrack;
  transcript?: Transcript;
  /** Every caption against what is behind it, per shot (contrast.ts). */
  contrast: CaptionContrast[];
  /** What was done: frames the reader read and how many frames a reading stands for, whether the transcript was the kept one, seconds of each part. */
  took: { frames: number; step: number; transcriptReused?: boolean; seconds: { text: number; speech?: number; contrast: number }; expected: number };
}

/** Reads and hears a render for readback, side by side when the CPU budget has room; progress on o.write. */
export const runReadback = async (rt: Runtime, o: { dir: string; video: string; resolved: Resolved; reader: TextReader; transcriber?: Transcriber; language?: string; write?: (line: string) => void; everyMs?: number }): Promise<ReadbackRun> => {
  const step = readingSpan(o.resolved.canvas.fps);
  const info = await probe(rt, o.video);
  const chosen = readbackFrames(o.resolved, info.frames);
  const frames = chosen.length;
  const together = partsSideBySide(rt);
  const cpus = cpuBudgetOf(rt).cpus;
  const expected = readbackEstimate({ frames, soundSeconds: o.transcriber && info.hasAudio ? info.duration : 0, cpus, together });
  o.write?.('readback: the text reader reads ' + frames + ' frames of ' + info.duration.toFixed(1) + ' s' + (o.transcriber && info.hasAudio ? ' and the transcriber hears the sound' : '') +
    (together ? ', side by side' : ', one after the other (CPU budget ' + cpus + ')') + '; expect about ' + expected + ' s (up to twice that on a slower machine).');
  const progress: Progress | undefined = o.write ? watchProgress(o.write, { label: 'readback', everyMs: o.everyMs ?? 15_000 }) : undefined;
  const timed = async <T>(name: string, work: (onStage?: OnStage) => Promise<T>): Promise<{ value: T; seconds: number }> => {
    const t0 = Date.now();
    const onStage = progress?.part(name);
    try {
      return { value: await work(onStage), seconds: Math.round((Date.now() - t0) / 100) / 10 };
    } finally {
      progress?.end(name);
    }
  };
  // When frames spread over the video hold much more (or less) text than captions do, the estimate is said again.
  const soundSeconds = o.transcriber && info.hasAudio ? info.duration : 0;
  const reader = lookingFirst(o.reader, (lines) => {
    const again = readbackEstimate({ frames, soundSeconds, cpus, together, text: textFactor(lines) });
    if (Math.abs(again - expected) >= Math.max(20, 0.3 * expected))
      o.write?.('readback: ' + FIRST_LOOK + ' frames spread over the video hold about ' + Math.round(lines) + ' lines of text each (a frame of captions holds 3 or 4), so reading takes ' + (again > expected ? 'longer' : 'less') + ': expect about ' + again + ' s in all.');
  });
  const readIt = () => timed('text', (onStage) => readFrames(rt, o.video, reader, chosen, { step, ...(onStage ? { onStage } : {}) }).then(cuesOf));
  const { transcriber } = o;
  const hearIt = () => (transcriber ? timed('speech', (onStage) => hear(rt, { video: o.video, cacheFile: rt.path.join(o.dir, TRANSCRIPT_CACHE), transcriber, ...(o.language ? { language: o.language } : {}), ...(onStage ? { onStage } : {}) })) : Promise.resolve(undefined));
  const t0 = Date.now();
  const contrast = await measureContrast(rt, o.video, o.resolved);
  const contrastSeconds = Math.round((Date.now() - t0) / 100) / 10;
  try {
    if (!together) { progress?.wait('text'); if (transcriber) progress?.wait('speech'); }
    const [read, heard] = together ? await Promise.all([readIt(), hearIt()]) : [await readIt(), await hearIt()] as const;
    return {
      text: read.value, ...(heard?.value.transcript ? { transcript: heard.value.transcript } : {}), contrast,
      took: { frames, step, ...(heard ? { transcriptReused: heard.value.reused } : {}), seconds: { text: read.seconds, ...(heard ? { speech: heard.seconds } : {}), contrast: contrastSeconds }, expected },
    };
  } finally {
    progress?.stop();
  }
};
