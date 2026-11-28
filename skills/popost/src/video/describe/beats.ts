/**
 * The beats of a reference: one list of what is said or shown, in time order, shared by describe, template and
 * retarget. A plan's "captions[i]" is the new line of beat i. A beat is
 * - a caption line that is said (shown and said), or one shown while nothing is said (a music intro, an end card);
 * - a phrase of speech that no caption covers (said, not shown): its new line is spoken (--speak) and never drawn, so
 *   the reference's look is kept;
 * - without speech, every caption line (shown), as before beats existed.
 * With the kinds of the speech (speech-kind.ts): words that are sung or fragments make no beat of their own, and a
 * beat whose words a visible person says is a dialogue beat (speech: 'on-camera'), which no voice-over reads.
 * Frames are the source's. Pure functions; no file access.
 */
import { joinWords, MIN_PHRASE_SECONDS, paceFramesOf, phrasesOf, syllablesOf } from '../speech/index';
import type { SpokenWord, Transcript } from '../speech/types';
import { rolesWithSpeech, SAID } from '../text/speech';
import type { TextCue, TextTrack } from '../text/types';
import type { KindRange } from './speech-kind';

export interface Beat {
  /** Source frames: the beat lasts start .. end-1. */
  start: number;
  end: number;
  /** The caption's wording when shown; the recognised words when only said. */
  text: string;
  /** false: said with no caption on screen. */
  shown: boolean;
  /** true: its words were heard (a said caption, or speech). */
  said: boolean;
  /** 0..1. A said caption: the share of its words heard; a caption without speech: the reader's confidence; speech: the recogniser's. */
  confidence: number;
  /** 'on-camera': a visible person says its words (a dialogue beat). Absent: narration, or no confirmed kind. */
  speech?: 'on-camera';
}

export interface ReferenceBeats {
  /** The text track with roles that agree with the speech (rolesWithSpeech); undefined without text. */
  text?: TextTrack;
  beats: Beat[];
  /** The caption cues, in time order: the caption band is set from them. */
  captions: TextCue[];
}

/** A beat whose confidence is below this is marked unsure. */
export const UNSURE = 0.6;
/**
 * Speech outside every caption that is this short (in syllables) and this close to a caption (in seconds) is a word the
 * caption left out or a word heard a little early or late, not a line of its own.
 */
const STRAY_SYLLABLES = 2;
const STRAY_SECONDS = 0.5;

const mid = (w: SpokenWord): number => (w.start + w.end) / 2;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Caption lines that appear together (within one sampling step) and overlap are one beat: the two lines of one
 * caption, read top to bottom. Without this the upper line would get a beat of no length.
 */
const together = (captions: TextCue[], step: number): TextCue[][] => {
  const groups: TextCue[][] = [];
  for (const c of captions) {
    const g = groups[groups.length - 1];
    const first = g?.[0];
    if (g && first && c.start - first.start <= step && c.start < Math.max(...g.map((x) => x.end))) g.push(c);
    else groups.push([c]);
  }
  return groups;
};

const shownBeats = (captions: TextCue[], step: number, total: number): Beat[] => {
  const groups = together(captions, step);
  return groups.map((g, i) => {
    const next = groups[i + 1]?.[0];
    const lines = [...g].sort((a, b) => a.box[1] - b.box[1]);
    const shares = g.flatMap((c) => (c.said === undefined ? [] : [c.said]));
    const share = shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length);
    const said = shares.length > 0 && share >= SAID;
    const start = Math.min(...g.map((c) => c.start)), end = Math.max(...g.map((c) => c.end));
    return {
      start, end: Math.min(end, next ? next.start : total, total), text: joinWords(lines.map((c) => ({ text: c.text.trim() }))), shown: true, said,
      confidence: r3(said ? share : g.reduce((n, c) => n + c.confidence, 0) / g.length),
    };
  });
};

/**
 * The words no shown beat covers, in runs of consecutive words. A word is covered when its middle lies in a shown beat,
 * widened by tolerance frames on both sides (caption edges are exact to about half a sampling step). A run ends where a
 * shown beat lies between two of its words.
 */
const uncoveredRuns = (words: SpokenWord[], shown: Beat[], tolerance: number): SpokenWord[][] => {
  const covered = (w: SpokenWord): boolean => shown.some((b) => mid(w) >= b.start - tolerance && mid(w) < b.end + tolerance);
  const runs: SpokenWord[][] = [];
  let run: SpokenWord[] = [];
  for (const w of words) {
    const prev = run[run.length - 1];
    if (covered(w) || (prev && shown.some((b) => b.start < mid(w) && b.end > mid(prev)))) { if (run.length) runs.push(run); run = []; }
    if (!covered(w)) run.push(w);
  }
  if (run.length) runs.push(run);
  return runs;
};

const isStray = (run: SpokenWord[], shown: Pick<Beat, 'start' | 'end'>[], fps: number): boolean => {
  const first = run[0], last = run[run.length - 1];
  if (!first || !last || run.reduce((n, w) => n + syllablesOf(w.text), 0) > STRAY_SYLLABLES) return false;
  const near = STRAY_SECONDS * fps;
  return shown.some((b) => Math.abs(first.start - b.end) <= near || Math.abs(b.start - last.end) <= near);
};

/**
 * Beats in time order that never overlap: a spoken beat starts after the beat before it and ends where a shown beat
 * starts. Shown beats keep their spans (they never overlap one another).
 */
const ordered = (beats: Beat[]): Beat[] => {
  const sorted = [...beats].sort((a, b) => a.start - b.start || Number(b.shown) - Number(a.shown)).map((b) => ({ ...b }));
  const out: Beat[] = [];
  for (const b of sorted) {
    const prev = out[out.length - 1];
    if (prev && b.start < prev.end) {
      if (b.shown && !prev.shown) prev.end = b.start;
      else b.start = prev.end;
    }
    if (prev && !prev.shown && prev.end <= prev.start) out.pop();
    if (b.end > b.start || b.shown) out.push(b);
  }
  return out;
};

export interface BeatOptions {
  text?: TextTrack;
  transcript?: Transcript;
  /** The source's frame count. */
  total: number;
  /** Frames at which the shots begin: speech beats are cut there (phrasesOf). */
  boundaries?: number[];
  /** The confirmed kinds of the speech (speech-kind.ts, kindRanges); without them every heard word is read as before. */
  kinds?: readonly KindRange[];
}

/** Frames of a span that lie in ranges of a kind. */
const covered = (b: { start: number; end: number }, kinds: readonly KindRange[], kind: KindRange['kind']): number =>
  kinds.reduce((n, k) => n + (k.kind === kind ? Math.max(0, Math.min(b.end, k.end) - Math.max(b.start, k.start)) : 0), 0);

/** A beat is a dialogue beat when more of it lies in on-camera speech than in narration. */
const withKind = (b: Beat, kinds: readonly KindRange[] | undefined): Beat => {
  if (!kinds) return b;
  const seen = covered(b, kinds, 'on-camera');
  return seen > 0 && seen > covered(b, kinds, 'narration') ? { ...b, speech: 'on-camera' } : b;
};

/** The beats of a reference from its text and its speech; with neither, no beats. */
export const referenceBeats = (o: BeatOptions): ReferenceBeats => {
  const text = o.text ? rolesWithSpeech(o.text, o.transcript) : undefined;
  const captions = (text?.cues ?? []).filter((c) => c.role === 'caption').sort((a, b) => a.start - b.start);
  const shown = shownBeats(captions, o.text?.step ?? 1, o.total);
  const kinds = o.kinds;
  // Sung words and fragments are no lines: they make no beat of their own (a caption shown over them stays a shown beat).
  const silent = (w: SpokenWord): boolean => (kinds ?? []).some((k) => (k.kind === 'sung' || k.kind === 'fragments') && mid(w) >= k.start && mid(w) < k.end);
  const words = (o.transcript?.words ?? []).filter((w) => !silent(w));
  if (!o.transcript || !words.length) return { ...(text ? { text } : {}), beats: shown.map((b) => withKind(b, kinds)), captions };
  const t = o.transcript;
  const pace = paceFramesOf(words);
  const runs = uncoveredRuns(words, shown, coverTolerance(o.text)).filter((run) => !isStray(run, shown, t.fps));
  // A spoken beat is also cut where the kind of the speech changes, so that it is narration or dialogue, never both.
  const cuts = [...(o.boundaries ?? []), ...(kinds ?? []).map((k) => k.start)].sort((a, b) => a - b);
  const spoken = runs.flatMap((run) => phrasesOf({ ...t, words: run }, { pace, minFrames: Math.round(MIN_PHRASE_SECONDS * t.fps), ...(cuts.length ? { boundaries: cuts } : {}) }))
    .map((p): Beat => ({ start: p.start, end: Math.min(p.end, o.total), text: p.text, shown: false, said: true, confidence: p.confidence }));
  return { ...(text ? { text } : {}), beats: ordered([...shown, ...spoken]).map((b) => withKind(b, kinds)), captions };
};

/**
 * Seconds of speech in no beat, and how many words that is. Strictly, a word is in a beat when its middle is. With
 * tolerance (frames) the beats are widened by it, and with strays a word left out next to a shown beat (isStray) counts
 * as that caption's: the rules referenceBeats attributes words by.
 */
export const uncoveredSpeech = (beats: Pick<Beat, 'start' | 'end' | 'shown'>[], transcript: Transcript | undefined, o: { tolerance?: number; strays?: boolean } = {}): { seconds: number; words: number } => {
  const words = transcript?.words ?? [];
  const tol = o.tolerance ?? 0;
  const out = words.filter((w) => !beats.some((b) => mid(w) >= b.start - tol && mid(w) < b.end + tol));
  const shown = beats.filter((b) => b.shown);
  const runs = out.reduce<SpokenWord[][]>((acc, w) => {
    const run = acc[acc.length - 1], prev = run?.[run.length - 1];
    if (run && prev && words.indexOf(prev) + 1 === words.indexOf(w)) run.push(w); else acc.push([w]);
    return acc;
  }, []);
  const left = o.strays ? runs.filter((run) => !isStray(run, shown, transcript?.fps ?? 1)).flat() : out;
  return { seconds: Math.round((left.reduce((n, w) => n + w.end - w.start, 0) / Math.max(1, transcript?.fps ?? 1)) * 10) / 10, words: left.length };
};

/** The frames by which referenceBeats widens a caption when it decides which words it covers: half the text's sampling step. */
export const coverTolerance = (text: TextTrack | undefined): number => Math.ceil((text?.step ?? 0) / 2);
