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

/** The longest common subsequence of the script's and the heard words: what was said, in order. */
export const matchSpeech = (script: string, heard: string): SpeechMatch => {
  const a = comparedWords(script), b = comparedWords(heard);
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (table[i] as Uint16Array)[j] = a[i] === b[j] ? ((table[i + 1] as Uint16Array)[j + 1] ?? 0) + 1 : Math.max((table[i + 1] as Uint16Array)[j] ?? 0, (table[i] as Uint16Array)[j + 1] ?? 0);
  const missing: string[] = [], extra: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (((table[i + 1] as Uint16Array)[j] ?? 0) >= ((table[i] as Uint16Array)[j + 1] ?? 0)) missing.push(a[i++] as string);
    else extra.push(b[j++] as string);
  }
  missing.push(...a.slice(i)); extra.push(...b.slice(j));
  const matched = (table[0] as Uint16Array)[0] ?? 0;
  return { script: n, heard: m, matched, share: n ? Math.round((matched / n) * 100) / 100 : 1, missing: missing.slice(0, 12), extra: extra.slice(0, 12) };
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

/**
 * Transcribes a speaking clip of a project and writes what was measured into its receipt. Returns undefined for a
 * clip without a speech receipt (nobody was asked to speak in it), and the receipt's own measurement when the clip
 * was measured before (nothing is transcribed, or charged, twice).
 */
export const measureClipSpeech = async (rt: Runtime, dir: string, file: string, transcriber: Transcriber): Promise<MeasuredSpeech | undefined> => {
  const clip = rt.path.resolve(dir, file), receiptFile = clip + '.speech.json';
  const receipt = await rt.fs.readText(receiptFile).then((t) => JSON.parse(t) as Record<string, unknown> & { text?: unknown; language?: unknown; measured?: MeasuredSpeech }, () => undefined);
  if (!receipt || typeof receipt.text !== 'string') return undefined;
  const videoSha256 = sha256(await rt.fs.readFile(clip));
  if (receipt.measured?.videoSha256 === videoSha256 && Array.isArray(receipt.measured.words)) return receipt.measured;
  const language = typeof receipt.language === 'string' ? receipt.language.split('-')[0] : undefined;
  const heard = await transcribe(rt, clip, transcriber, language);
  const fps = heard?.fps ?? (await probe(rt, clip)).fps;
  const words = (heard?.words ?? []).map((w) => ({ text: w.text, start: Math.round((w.start / fps) * 1000) / 1000, end: Math.round((w.end / fps) * 1000) / 1000 }));
  const measured: MeasuredSpeech = { videoSha256, language: heard?.language ?? language ?? '', words, spans: spokenSpans(words), match: matchSpeech(receipt.text, words.map((w) => w.text).join(' ')) };
  await rt.fs.writeFile(receiptFile, JSON.stringify({ ...receipt, measured }, null, 2));
  return measured;
};
