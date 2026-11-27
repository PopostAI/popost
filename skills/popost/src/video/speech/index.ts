/**
 * Speech of a video: extract the sound, have a transcriber recognise it, keep the words in source frames.
 * The transcriber is a command named by POPOST_ASR_CMD, called as: <command> <audio.wav> <out.json> [language]
 *   out.json  { "language": "zh", "words": [{ "text": "...", "start": 1.02, "end": 1.16, "confidence": 0.99 }] }
 * with times in seconds. skills/popost/tools/video/asr-faster-whisper is one such command for the development loop.
 * Without one, a connected popost.ai account transcribes within a confirmed POPOST_ASR_MAX_CREDITS budget (hosted.ts).
 */
import type { Runtime } from '../../runtime';
import { toolCommand, withTempDir } from '../host';
import { probe } from '../media/ffmpeg';
import { speechWav } from '../media/wav';
import type { OnStage } from '../progress';
import { runTool, ToolError } from '../tool';
import { hostedTranscriber, hostedTranscriptionAbsence } from './hosted';
import type { Phrase, RawTranscript, SpokenWord, Transcriber, Transcript } from './types';

export type { Phrase, RawTranscript, SpokenWord, Transcriber, Transcript } from './types';

const VARIABLE = 'POPOST_ASR_CMD';

const isRaw = (v: unknown): v is RawTranscript =>
  typeof v === 'object' && v !== null && typeof (v as RawTranscript).language === 'string' && Array.isArray((v as RawTranscript).words);

/**
 * The transcriber behind POPOST_ASR_CMD; when it is not set, popost.ai's for a connected account with a confirmed
 * POPOST_ASR_MAX_CREDITS budget; else undefined (speech is then simply not read). The transcriber runs its command
 * through `rt`, the runtime of the command that asked for it.
 */
export const commandTranscriber = (rt: Runtime): Transcriber | undefined => {
  if (!toolCommand(rt, VARIABLE)) return hostedTranscriber(rt);
  return {
    transcribe: (file, language) =>
      withTempDir(rt, 'popost-video-asr-', async (dir) => {
        const out = rt.path.join(dir, 'out.json');
        await runTool(rt, VARIABLE, 'The transcriber', [file, out, ...(language ? [language] : [])]);
        const parsed: unknown = JSON.parse(await rt.fs.readText(out));
        if (!isRaw(parsed)) throw new ToolError('The transcriber wrote something that is not { language, words }. See skills/popost/src/video/speech/index.ts for the format.');
        return parsed;
      }),
  };
};

/** Why commandTranscriber gives none, for "leftOut" and errors: POPOST_ASR_CMD is not set, and why popost.ai's is not used. */
export const transcriberAbsence = (rt: Runtime): string => {
  const hosted = hostedTranscriptionAbsence(rt);
  return VARIABLE + ' is not set' + (hosted?.connected ? ', and ' + hosted.why : '');
};

const CJK = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/u;

/**
 * Seconds to source frames. A word always lasts at least one frame and never starts before the word before it ends.
 * Recognisers split an unfamiliar Latin word into pieces ("An", "ime") and mark a new word with a leading space:
 * a Latin piece without that space is joined to the Latin word before it.
 */
export const toFrames = (raw: RawTranscript, fps: number): Transcript => {
  const words: SpokenWord[] = [];
  for (const w of raw.words) {
    const text = w.text.trim();
    if (!text) continue;
    const prev = words[words.length - 1];
    const end = Math.round(w.end * fps);
    const confidence = Math.round(w.confidence * 1000) / 1000;
    const continues = prev && !/^\s/.test(w.text) && !CJK.test(text[0] ?? '') && /[A-Za-z0-9]$/.test(prev.text) && /^[A-Za-z0-9]/.test(text);
    if (prev && continues) {
      words[words.length - 1] = { text: prev.text + text, start: prev.start, end: Math.max(prev.end, end), confidence: Math.min(prev.confidence, confidence) };
      continue;
    }
    const start = Math.max(Math.round(w.start * fps), prev?.end ?? 0);
    words.push({ text, start, end: Math.max(start + 1, end), confidence });
  }
  return { language: raw.language, words, fps };
};

/** Reads the speech of a video. Returns undefined when the video has no sound. onStage: for a progress line. */
export const transcribe = async (rt: Runtime, video: string, transcriber: Transcriber, language?: string, onStage?: OnStage): Promise<Transcript | undefined> => {
  const info = await probe(rt, video);
  if (!info.hasAudio) return undefined;
  return withTempDir(rt, 'popost-video-audio-', async (dir) => {
    const wav = rt.path.join(dir, 'audio.wav');
    onStage?.('taking the sound out');
    await speechWav(rt, video, wav);
    onStage?.('the transcriber is listening to ' + info.duration.toFixed(1) + ' s of sound');
    return toFrames(await transcriber.transcribe(wav, language), info.fps);
  });
};

/** Joins words the way their script is written: no space between CJK characters, a space between other words. */
export const joinWords = (words: { text: string }[]): string =>
  words.reduce((s, w) => {
    const last = s[s.length - 1] ?? '';
    const needsSpace = s && !CJK.test(last) && !CJK.test(w.text[0] ?? '') && !/^[,.!?;:，。！？；：、]/.test(w.text);
    return s + (needsSpace ? ' ' : '') + w.text;
  }, '');

const CLAUSE_END = /[,.!?;:，。！？；：、]$/;
const CJK_ALL = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/gu;
const LATIN_RUN = /[A-Za-z0-9]+/g;

/**
 * About how many syllables a word is spoken in: one per CJK character; one per character of a short run of capitals
 * or digits (spelled out: "AI", "MP4"); one per 2.5 letters of any other Latin word. At least one.
 */
export const syllablesOf = (text: string): number => {
  const cjk = (text.match(CJK_ALL) ?? []).length;
  const latin = (text.match(LATIN_RUN) ?? []).reduce((n, run) => n + (/^[A-Z0-9]{1,5}$/.test(run) ? run.length : Math.ceil(run.length / 2.5)), 0);
  return Math.max(1, cjk + latin);
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Frames a syllable takes at the speaker's usual pace: the median over the words, at least 1. */
export const paceFramesOf = (words: SpokenWord[]): number => Math.max(1, median(words.map((w) => (w.end - w.start) / syllablesOf(w.text))));

/**
 * The pause before each word, in frames (Infinity before the first). It is the silence between the two words plus the
 * time the word lasts beyond its syllables at the speaker's usual pace (paceFramesOf): recognisers that
 * give contiguous word times hide a pause inside the word after it. Measured on the development set, where one
 * recogniser gave no gap at all in 222 of 223 word joins: the extra time sits at sentence starts (12 to 14 frames for a
 * one-syllable word spoken in 4).
 */
export const pausesOf = (words: SpokenWord[], pace = paceFramesOf(words)): number[] =>
  words.map((w, k) => {
    const prev = words[k - 1];
    if (!prev) return Infinity;
    return Math.max(0, w.start - prev.end) + Math.max(0, w.end - w.start - syllablesOf(w.text) * pace);
  });

/** A phrase is at most this long unless the caller says otherwise: about one caption line of a short video, spoken. */
export const MAX_PHRASE_SECONDS = 3.5;
/** A cut closer than this to either end of a phrase does not split it: the editor cut on the phrase, not inside it. */
const EDGE_SECONDS = 0.5;

export interface PhraseOptions {
  /** A pause of at least this many frames ends a phrase. Default: a quarter of a second. */
  pauseFrames?: number;
  /** No phrase is longer than this (unless it is one word): a longer one is cut at its largest pause. Default: MAX_PHRASE_SECONDS. */
  maxFrames?: number;
  /** Frames at which a shot begins: a phrase is cut there, between the two words around it, when both parts last at least half a second. */
  boundaries?: number[];
  /** Frames a syllable takes at the speaker's usual pace, when the words are a part of a longer speech (paceFramesOf of the whole). */
  pace?: number;
  /**
   * A phrase shorter than this joins the phrase before or after it when no pause lies between them (inside one shot,
   * and within maxFrames): "Sí," is not a line of its own. Default 0: every phrase is kept. The beats of a reference
   * use MIN_PHRASE_SECONDS.
   */
  minFrames?: number;
}

/** A line a voice can say on its own lasts about this long. Shorter phrases were 20 of 28 beats in a fast dialogue, and speaking each alone made the video 76% longer. */
export const MIN_PHRASE_SECONDS = 1;

interface Run { words: SpokenWord[]; pauses: number[] }

const span = (r: Run): number => (r.words[r.words.length - 1]?.end ?? 0) - (r.words[0]?.start ?? 0);
const cut = (r: Run, k: number): [Run, Run] => [{ words: r.words.slice(0, k), pauses: r.pauses.slice(0, k) }, { words: r.words.slice(k), pauses: r.pauses.slice(k) }];
const mid = (w: SpokenWord | undefined): number => (w ? (w.start + w.end) / 2 : 0);

/** Cuts a run at every shot boundary that falls between two of its words, when both parts last at least edge frames. */
const atBoundaries = (r: Run, boundaries: number[], edge: number): Run[] => {
  for (let k = 1; k < r.words.length; k++) {
    if (!boundaries.some((b) => b > mid(r.words[k - 1]) && b <= mid(r.words[k]))) continue;
    const [a, b] = cut(r, k);
    if (span(a) >= edge && span(b) >= edge) return [a, ...atBoundaries(b, boundaries, edge)];
  }
  return [r];
};

/** Cuts a run longer than max at its largest pause, keeping both parts at least edge long when it can; ties go to the middle. */
const atLargestPause = (r: Run, max: number, edge: number): Run[] => {
  if (span(r) <= max || r.words.length < 2) return [r];
  const centre = ((r.words[0]?.start ?? 0) + (r.words[r.words.length - 1]?.end ?? 0)) / 2;
  const options = r.words.slice(1).map((w, j) => ({ k: j + 1, pause: r.pauses[j + 1] ?? 0, off: Math.abs(w.start - centre) }));
  const roomy = options.filter((o) => { const [a, b] = cut(r, o.k); return span(a) >= edge && span(b) >= edge; });
  const best = (roomy.length ? roomy : options).sort((x, y) => y.pause - x.pause || x.off - y.off)[0];
  if (!best) return [r];
  const [a, b] = cut(r, best.k);
  return [...atLargestPause(a, max, edge), ...atLargestPause(b, max, edge)];
};

/** Joins a run shorter than min frames with the run before or after it, when neither a pause nor the start of a shot lies between them and the two together stay within max. */
const joinShort = (runs: Run[], min: number, max: number, boundaries: number[], pauseFrames: number): Run[] => {
  if (min <= 0) return runs;
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    const last = prev?.words[prev.words.length - 1], first = r.words[0], start = prev?.words[0], end = r.words[r.words.length - 1];
    const crosses = boundaries.some((f) => f > mid(last) && f <= mid(first));
    const together = (end?.end ?? 0) - (start?.start ?? 0);
    const paused = (first?.start ?? 0) - (last?.end ?? 0) >= pauseFrames;
    if (prev && (span(prev) < min || span(r) < min) && !crosses && !paused && together <= max) out[out.length - 1] = { words: [...prev.words, ...r.words], pauses: [...prev.pauses, ...r.pauses] };
    else out.push(r);
  }
  return out;
};

/**
 * Splits the words into phrases a person would call lines: at pauses of at least pauseFrames (pausesOf, so a pause a
 * recogniser hid inside a word counts), after a word that ends a clause (the recogniser's own punctuation), at shot
 * boundaries when they are given, and never longer than maxFrames: a longer stretch is cut at its largest pause.
 */
export const phrasesOf = (t: Transcript, o: PhraseOptions = {}): Phrase[] => {
  const pauseFrames = o.pauseFrames ?? Math.round(t.fps / 4);
  const max = o.maxFrames ?? Math.round(MAX_PHRASE_SECONDS * t.fps);
  const edge = Math.round(EDGE_SECONDS * t.fps);
  const pauses = pausesOf(t.words, o.pace ?? paceFramesOf(t.words));
  const runs: Run[] = [];
  t.words.forEach((w, k) => {
    const run = runs[runs.length - 1];
    const prev = t.words[k - 1];
    if (run && prev && (pauses[k] ?? 0) < pauseFrames && !CLAUSE_END.test(prev.text)) { run.words.push(w); run.pauses.push(pauses[k] ?? 0); }
    else runs.push({ words: [w], pauses: [pauses[k] ?? 0] });
  });
  const cutUp = runs.flatMap((r) => atBoundaries(r, o.boundaries ?? [], edge)).flatMap((r) => atLargestPause(r, max, edge));
  const split = joinShort(cutUp, o.minFrames ?? 0, max, o.boundaries ?? [], pauseFrames);
  return split.map(({ words: g }) => ({
    text: joinWords(g), start: g[0]?.start ?? 0, end: g[g.length - 1]?.end ?? 0, words: g,
    confidence: Math.round((g.reduce((s, w) => s + w.confidence, 0) / g.length) * 1000) / 1000,
  }));
};

/** Characters a second of the speech, over the time words are being said (pauses and punctuation left out). */
export const paceOf = (t: Transcript | undefined): { charactersPerSecond: number; language: string } | undefined => {
  if (!t || !t.words.length) return undefined;
  const chars = t.words.reduce((n, w) => n + Array.from(w.text).filter((c) => !/[\s,.!?;:，。！？；：、]/.test(c)).length, 0);
  const seconds = t.words.reduce((n, w) => n + (w.end - w.start), 0) / Math.max(1, t.fps);
  return seconds > 0 ? { charactersPerSecond: Math.round((chars / seconds) * 10) / 10, language: t.language } : undefined;
};
