/**
 * What a generated clip really says, against what it was asked to say. A model speaks the lines of a prompt, but not
 * always all of them, and not exactly in their slots: so after a speaking clip is made its sound is transcribed (the
 * transcriber every command uses: the user's own, or popost.ai's, priced and agreed first), the measured word times
 * are written into the clip's speech receipt (<clip>.speech.json, "measured"), and the words are held against the
 * script. The mix and the checks then use the measured times (media/footage.ts, speechSpans), not the asked slots.
 * A clip that says less than MATCH_FLOOR of its script is reported with a named problem that offers a remake: the
 * program never pays for one by itself.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { probe } from '../media/ffmpeg';
import { error, warning } from '../project/check-common';
import { transcribe, type Transcriber } from '../speech/index';
import type { Problem } from '../types';

/**
 * The share of the script's words a clip must say, in order, to pass. A general value, not calibrated on any set:
 * a recogniser mishears a word in ten of clean speech now and then, and a clip that drops a clause loses more.
 */
export const MATCH_FLOOR = 0.8;
/** Words closer than this are one stretch of speech: a pause of a third of a second is inside a sentence. */
export const SPAN_GAP_SECONDS = 0.35;

const CJK = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/u;

/** The words of a text as they are compared: Latin words in lower case without punctuation, CJK one character each. */
export const comparedWords = (text: string): string[] => {
  const out: string[] = [];
  for (const piece of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    let run = '';
    for (const ch of piece) {
      if (CJK.test(ch)) { if (run) out.push(run); run = ''; out.push(ch); } else run += ch;
    }
    if (run.replace(/'/g, '')) out.push(run.replace(/^'+|'+$/g, ''));
  }
  return out;
};

export interface SpeechMatch {
  /** Words of the script, words heard, and how many of the script's were heard in order. */
  script: number; heard: number; matched: number;
  /** matched / script; 1 for an empty script. */
  share: number;
  /** Words of the script not heard, and words heard that the script does not have, in order (the first 12 of each). */
  missing: string[]; extra: string[];
}

/** The pairs (script word, heard word) of a longest common subsequence: what was said, in order. */
const commonPairs = (a: readonly string[], b: readonly string[]): [number, number][] => {
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  const at = (i: number, j: number): number => (table[i] as Uint16Array)[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (table[i] as Uint16Array)[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return pairs;
};

/** The script's words against the heard words: how many were said in order, and what is missing or extra. */
export const matchSpeech = (script: string, heard: string): SpeechMatch => {
  const a = comparedWords(script), b = comparedWords(heard);
  const pairs = commonPairs(a, b);
  const saidA = new Set(pairs.map(([i]) => i)), saidB = new Set(pairs.map(([, j]) => j));
  const missing = a.filter((_w, i) => !saidA.has(i)), extra = b.filter((_w, j) => !saidB.has(j));
  const n = a.length, matched = pairs.length;
  return { script: n, heard: b.length, matched, share: n ? Math.round((matched / n) * 100) / 100 : 1, missing: missing.slice(0, 12), extra: extra.slice(0, 12) };
};

/**
 * When each line of the script was said, from the heard words matched to its words (seconds of the clip); null for a
 * line none of whose words was heard. The captions of a clip's lines follow these times (template fill).
 */
export const lineTimes = (lines: readonly string[], words: readonly { text: string; start: number; end: number }[]): ({ at: number; to: number } | null)[] => {
  const perLine = lines.map((l) => comparedWords(l));
  const owner = perLine.flatMap((w, k) => w.map(() => k));
  // Each heard word is one or more compared words (a CJK word is one per character): every piece keeps its word's time.
  const pieces = words.flatMap((w) => comparedWords(w.text).map((t) => ({ t, start: w.start, end: w.end })));
  const pairs = commonPairs(perLine.flat(), pieces.map((p) => p.t));
  return lines.map((_l, k) => {
    const heard = pairs.filter(([i]) => owner[i] === k).map(([, j]) => pieces[j] as { start: number; end: number });
    if (!heard.length) return null;
    return { at: Math.min(...heard.map((h) => h.start)), to: Math.max(...heard.map((h) => h.end)) };
  });
};

/** Words in seconds as stretches of speech: joined where they lie closer than SPAN_GAP_SECONDS. */
export const spokenSpans = (words: readonly { start: number; end: number }[], gap = SPAN_GAP_SECONDS): [number, number][] => {
  const out: [number, number][] = [];
  for (const w of [...words].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && w.start - last[1] <= gap) last[1] = Math.max(last[1], w.end);
    else out.push([w.start, w.end]);
  }
  return out.map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]);
};

export interface MeasuredSpeech {
  /** The hash of the clip the words were heard in: a clip made again is measured again. */
  videoSha256: string;
  language: string;
  words: { text: string; start: number; end: number }[];
  spans: [number, number][];
  match: SpeechMatch;
  /** When each line of the receipt was said (seconds of the clip), in the order of its lines; null for a line not heard. */
  lines?: ({ at: number; to: number } | null)[];
  /** The clip has no audio stream (it came back without sound): it says nothing, and nothing was transcribed. */
  silent?: true;
}

export const SPEECH_PROBLEM = 'speech-not-as-written';

/** The problems of a measured clip: under the floor an error that offers a remake; any missing word a warning. */
export const speechMatchProblems = (file: string, m: SpeechMatch, key?: string): Problem[] => {
  if (m.share >= MATCH_FLOOR) return m.missing.length || m.extra.length
    ? [warning(file, 'The clip says ' + m.matched + ' of the ' + m.script + ' words of its script' + (m.missing.length ? '; not heard: ' + m.missing.join(' ') : '') + (m.extra.length ? '; heard besides: ' + m.extra.join(' ') : '') + '.', 'Listen to it; a recogniser mishears a word now and then. The captions and the mix follow the measured times.')]
    : [];
  return [error(file, SPEECH_PROBLEM + ': the clip says ' + m.matched + ' of the ' + m.script + ' words of its script (' + Math.round(m.share * 100) + '%, under ' + Math.round(MATCH_FLOOR * 100) + '%)' + (m.missing.length ? '; not heard: ' + m.missing.join(' ') : '') + (m.extra.length ? '; heard besides: ' + m.extra.join(' ') : '') + '.',
    'Listen to the clip. When it does not say its lines, show the user what is missing and the price of making it again; only after a yes, make it again under a new file name' + (key ? ' (popost video materials --approve-unplanned ' + key + ')' : ' (popost video materials --approve-unplanned <its key>)') + ': shorter lines, or more seconds for them, are said more reliably. Nothing is made again by itself.')];
};

/** The problem of a speaking clip that came back without an audio stream: none of its lines is heard. */
export const silentClipProblems = (file: string): Problem[] => [error(file, SPEECH_PROBLEM + ': the clip has no sound (no audio stream), so it says none of its lines.',
  'Show the user, with the price of making it again; only after a yes, make it again under a new file name (popost video materials --approve-unplanned <its key>). Nothing is made again by itself.')];

type Receipt = Record<string, unknown> & { text?: unknown; language?: unknown; lines?: { text?: unknown }[]; measured?: MeasuredSpeech };

const receiptOf = (rt: Runtime, clip: string): Promise<Receipt | undefined> =>
  rt.fs.readText(clip + '.speech.json').then((t) => JSON.parse(t) as Receipt, () => undefined);

/** The measurement a receipt keeps for this very clip (its hash), or undefined when it was never measured or the clip changed. */
export const keptMeasurement = async (rt: Runtime, dir: string, file: string): Promise<MeasuredSpeech | undefined> => {
  const clip = rt.path.resolve(dir, file), receipt = await receiptOf(rt, clip);
  if (!receipt?.measured || !Array.isArray(receipt.measured.words)) return undefined;
  return receipt.measured.videoSha256 === sha256(await rt.fs.readFile(clip)) ? receipt.measured : undefined;
};

const CLIP_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];

/** The clips under assets/ of a project that were asked to say a script (a speech receipt with its text), as project paths. */
export const speakingClips = async (rt: Runtime, dir: string, sub = 'assets', depth = 3): Promise<string[]> => {
  const here = rt.path.join(dir, sub);
  if (depth < 0 || !(await rt.fs.stat(here))?.isDirectory) return [];
  const out: string[] = [];
  for (const name of (await rt.fs.readdir(here)).sort()) {
    const rel = sub + '/' + name, full = rt.path.join(here, name);
    if ((await rt.fs.stat(full))?.isDirectory) out.push(...await speakingClips(rt, dir, rel, depth - 1));
    else if (CLIP_EXT.includes(rt.path.extname(name).toLowerCase()) && typeof (await receiptOf(rt, full))?.text === 'string') out.push(rel);
  }
  return out;
};

/**
 * Transcribes a speaking clip of a project and writes what was measured into its receipt. Returns undefined for a
 * clip without a speech receipt (nobody was asked to speak in it), and the receipt's own measurement when the clip
 * was measured before (nothing is transcribed, or charged, twice). A clip that needs hearing and no transcriber throws.
 */
export const measureClipSpeech = async (rt: Runtime, dir: string, file: string, transcriber?: Transcriber): Promise<MeasuredSpeech | undefined> => {
  const clip = rt.path.resolve(dir, file), receiptFile = clip + '.speech.json';
  const receipt = await receiptOf(rt, clip);
  if (!receipt || typeof receipt.text !== 'string') return undefined;
  const videoSha256 = sha256(await rt.fs.readFile(clip));
  if (receipt.measured?.videoSha256 === videoSha256 && Array.isArray(receipt.measured.words)) return receipt.measured;
  const language = typeof receipt.language === 'string' ? receipt.language.split('-')[0] : undefined;
  const info = await probe(rt, clip);
  // A clip without an audio stream is silence: nothing to hear, and nothing to pay for.
  if (!info.hasAudio) {
    const silent: MeasuredSpeech = { videoSha256, language: language ?? '', words: [], spans: [], match: matchSpeech(receipt.text, ''), silent: true };
    await rt.fs.writeFile(receiptFile, JSON.stringify({ ...receipt, measured: silent }, null, 2));
    return silent;
  }
  if (!transcriber) throw new Error('The clip ' + file + ' has not been heard yet and there is no transcriber.');
  const heard = await transcribe(rt, clip, transcriber, language);
  const fps = heard?.fps ?? info.fps;
  const words = (heard?.words ?? []).map((w) => ({ text: w.text, start: Math.round((w.start / fps) * 1000) / 1000, end: Math.round((w.end / fps) * 1000) / 1000 }));
  const scripted = Array.isArray(receipt.lines) ? receipt.lines.map((l) => (typeof l?.text === 'string' ? l.text : '')) : [];
  const measured: MeasuredSpeech = {
    videoSha256, language: heard?.language ?? language ?? '', words, spans: spokenSpans(words), match: matchSpeech(receipt.text, words.map((w) => w.text).join(' ')),
    ...(scripted.length ? { lines: lineTimes(scripted, words) } : {}),
  };
  await rt.fs.writeFile(receiptFile, JSON.stringify({ ...receipt, measured }, null, 2));
  return measured;
};
