/**
 * What kind of speech a reference has, which decides what the re-make does with it: narration (heard, nobody on screen
 * says it) is re-made as a voice-over; on-camera speech (a visible person says it) as a person who speaks in a clip;
 * sung words, fragments (a few exclamations) and no speech as no voice at all; unknown (not transcribed) as no voice.
 * A program can tell none, fragments and unknown. Whether heard words are narration, said on camera or sung needs
 * eyes: describe writes the phrases with a picture of the frame at the middle of each, and whoever reads the frames
 * confirms the kind per range of phrases (popost video speech-kind confirm). The record is speech.json in the
 * directory describe wrote; template save keeps the confirmed kinds in the template. Pure.
 */
import { syllablesOf } from '../speech/index';
import type { Phrase, Transcript } from '../speech/types';

export const SPEECH_FILE = 'speech.json';
export const SPEECH_FORMAT = 'popost-video-speech';
/** The sheets with one frame per phrase, at its middle: speech/phrases-01.jpg, -02 ... */
export const phraseSheetFile = (n: number): string => 'speech/phrases-' + String(n).padStart(2, '0') + '.jpg';
/** Phrases on one sheet. */
export const PHRASES_A_SHEET = 24;

/** The kinds a phrase can have; a whole reference can also have none or unknown. */
export const PHRASE_KINDS = ['narration', 'on-camera', 'sung', 'fragments'] as const;
export type PhraseKind = (typeof PHRASE_KINDS)[number];
export type SpeechKind = PhraseKind | 'none' | 'unknown';

/** Why there is, or is not, a transcript: read, a video without sound, --no-speech, a transcription that failed, no transcriber. */
export type SpeechStatus = 'transcribed' | 'silent' | 'skipped' | 'failed' | 'no-tool';

/**
 * Fragments: speech that is no script. Words are heard for less than FRAGMENT_SHARE of the video's length and its
 * phrases have FRAGMENT_SYLLABLES syllables or fewer on average (a Chinese character or a Latin syllable each): a few
 * exclamations or single words in a video that is otherwise music or ambience. One sentence of narration is longer
 * than that, so it is not decided here but confirmed from the frames.
 */
export const FRAGMENT_SHARE = 0.15;
export const FRAGMENT_SYLLABLES = 4;

export interface SpeechPhrase {
  index: number;
  /** Source frames: said on start .. end-1. */
  start: number;
  end: number;
  text: string;
  /** Absent until confirmed (or decided by the program: fragments). */
  kind?: PhraseKind;
  /** The picture that shows the frame at the phrase's middle, and the time written under that frame. */
  picture?: { file: string; seconds: number };
}

export interface SpeechFile {
  format: typeof SPEECH_FORMAT;
  version: 1;
  status: SpeechStatus;
  /** With skipped, failed and no-tool: the reason in a few words. */
  why?: string;
  fps: number;
  /** Seconds words are heard, and the video's length. */
  seconds: { spoken: number; video: number };
  /** true: every phrase has its kind (or there is nothing to confirm). */
  confirmed: boolean;
  /**
   * 'sound-analysis': the kinds are a default the listener's reading gave (withHeardKinds), not a reader's look at the
   * frames; speech-kind confirm replaces them.
   */
  from?: 'sound-analysis';
  /** The kinds present, in the order of PHRASE_KINDS; ["none"] or ["unknown"] for a reference without phrases. */
  kinds: SpeechKind[];
  phrases: SpeechPhrase[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

const kindsOf = (status: SpeechStatus, phrases: readonly SpeechPhrase[]): SpeechKind[] => {
  if (status !== 'transcribed') return [status === 'silent' ? 'none' : 'unknown'];
  if (!phrases.length) return ['none'];
  return PHRASE_KINDS.filter((k) => phrases.some((p) => p.kind === k));
};

/** Whether the phrases of a transcript are fragments (the constants above). */
export const isFragments = (phrases: readonly Phrase[], spokenSeconds: number, videoSeconds: number): boolean => {
  if (!phrases.length || !(videoSeconds > 0)) return false;
  const syllables = phrases.reduce((n, p) => n + p.words.reduce((s, w) => s + syllablesOf(w.text), 0), 0) / phrases.length;
  return spokenSeconds / videoSeconds < FRAGMENT_SHARE && syllables <= FRAGMENT_SYLLABLES;
};

/** The frame at the middle of a phrase. */
export const middleOf = (p: { start: number; end: number }): number => Math.floor((p.start + Math.max(p.start, p.end - 1)) / 2);

export interface SpeechInput {
  status: SpeechStatus;
  why?: string;
  transcript?: Transcript;
  /** The phrases of the transcript, cut at the shots (speech/index.ts, phrasesOf). */
  phrases?: readonly Phrase[];
  fps: number;
  /** The video's length in seconds. */
  duration: number;
}

/** The record of a reading: what the program can decide is decided, the rest waits for the frames. */
export const speechOf = (o: SpeechInput): SpeechFile => {
  const words = o.status === 'transcribed' ? (o.transcript?.words ?? []) : [];
  const spoken = words.reduce((n, w) => n + w.end - w.start, 0) / Math.max(1, o.fps);
  const read = o.status === 'transcribed' ? (o.phrases ?? []) : [];
  const fragments = isFragments(read, spoken, o.duration);
  const phrases = read.map((p, index): SpeechPhrase => ({ index, start: p.start, end: p.end, text: p.text, ...(fragments ? { kind: 'fragments' as const } : {}) }));
  return {
    format: SPEECH_FORMAT, version: 1, status: o.status, ...(o.why && o.status !== 'transcribed' ? { why: o.why } : {}), fps: o.fps,
    seconds: { spoken: r2(spoken), video: r2(o.duration) },
    confirmed: phrases.every((p) => p.kind !== undefined), kinds: kindsOf(o.status, phrases), phrases,
  };
};

/**
 * Words inside the music: phrases this short and this sparse, in a sound whose music a listener heard vocals in, are
 * the song's words and not a script. General values, not calibrated on any set: a sung hook or a sampled shout is a
 * few words (syllablesOf counts at least one syllable a word and rounds up, so six short words come to about ten),
 * and a narrated video speaks for more than two fifths of its length.
 */
export const HEARD_SYLLABLES = 12;
export const HEARD_SHARE = 0.4;

/** What the listener said of the voices in the music (the hosted sound analysis; describe passes it on). */
export interface HeardVoices { music: boolean; vocals: 'none' | 'sung' | 'spoken-sample' | 'rap'; speech?: string }

/**
 * A record whose open phrases get a default kind from what a listener heard: when the music has sung (or rapped)
 * vocals, or a spoken sample, and the phrases are short and sparse (HEARD_SYLLABLES, HEARD_SHARE), they are the
 * music's words: 'sung', or 'fragments' for a spoken sample. The record says where the kinds came from, and whoever
 * reads the frames can still confirm otherwise (speech-kind confirm). A record that is confirmed already, or has
 * nothing to confirm, is left as it is.
 */
export const withHeardKinds = (f: SpeechFile, heard: HeardVoices | undefined): SpeechFile => {
  if (!heard?.music || heard.vocals === 'none' || f.status !== 'transcribed' || f.confirmed || !f.phrases.length) return f;
  const syllables = f.phrases.reduce((n, p) => n + syllablesOf(p.text), 0) / f.phrases.length;
  const share = f.seconds.video > 0 ? f.seconds.spoken / f.seconds.video : 1;
  if (syllables > HEARD_SYLLABLES || share >= HEARD_SHARE) return f;
  const kind: PhraseKind = heard.vocals === 'spoken-sample' ? 'fragments' : 'sung';
  const phrases = f.phrases.map((p) => (p.kind ? p : { ...p, kind }));
  return { ...f, confirmed: true, from: 'sound-analysis', kinds: kindsOf(f.status, phrases), phrases };
};

/** A record with the pictures of its phrases named: sheet k (from 1) shows phrases (k-1)*PHRASES_A_SHEET onward. */
export const withPictures = (f: SpeechFile): SpeechFile => ({
  ...f,
  phrases: f.phrases.map((p) => ({ ...p, picture: { file: phraseSheetFile(Math.floor(p.index / PHRASES_A_SHEET) + 1), seconds: r2(middleOf(p) / f.fps) } })),
});

/**
 * A new reading that found the same phrases as a confirmed record keeps that record's kinds: describing the same
 * video again does not ask the reader twice.
 */
export const keepConfirmed = (fresh: SpeechFile, old: SpeechFile | undefined): SpeechFile => {
  const same = old?.confirmed && !fresh.confirmed && old.phrases.length === fresh.phrases.length
    && fresh.phrases.every((p, i) => { const q = old.phrases[i]; return q?.kind !== undefined && q.start === p.start && q.end === p.end && q.text === p.text; });
  if (!old || !same) return fresh;
  const phrases = fresh.phrases.map((p, i) => ({ ...p, kind: old.phrases[i]?.kind as PhraseKind }));
  return { ...fresh, confirmed: true, kinds: kindsOf(fresh.status, phrases), phrases };
};

/** Whether a value read from speech.json is a record. */
export const isSpeechFile = (v: unknown): v is SpeechFile =>
  typeof v === 'object' && v !== null && (v as SpeechFile).format === SPEECH_FORMAT && (v as SpeechFile).version === 1 && Array.isArray((v as SpeechFile).phrases) && Array.isArray((v as SpeechFile).kinds);

/** A voice-over belongs to the re-make only when the reference has narration. */
export const hasNarration = (f: Pick<SpeechFile, 'kinds'>): boolean => f.kinds.includes('narration');

export interface KindProblem { at: string; message: string; fix: string }

/** "0-3", "5": phrase indexes, first and last. */
const rangeOf = (text: string): [number, number] | undefined => {
  const m = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) return undefined;
  const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
  return a <= b ? [a, b] : undefined;
};

/**
 * The record with the kinds a reader confirmed: per kind, ranges of phrase indexes ("0-3", "5"). A phrase named twice
 * with different kinds, a range outside the phrases and a phrase left without a kind are problems; the record is
 * returned only when there is none.
 */
export const confirmSpeech = (f: SpeechFile, given: Partial<Record<PhraseKind, readonly string[]>>): { file?: SpeechFile; problems: KindProblem[] } => {
  const problems: KindProblem[] = [];
  const kinds = new Map<number, PhraseKind>(f.phrases.flatMap((p) => (p.kind ? [[p.index, p.kind] as const] : [])));
  const named = new Map<number, PhraseKind>();
  const last = f.phrases.length - 1;
  for (const kind of PHRASE_KINDS) {
    for (const text of given[kind] ?? []) {
      const range = rangeOf(text);
      if (!range || range[1] > last) {
        problems.push({ at: '--' + kind, message: '"' + text + '" is not a range of this video\'s phrases, which are numbered 0 to ' + last + '.', fix: 'Write phrase numbers as 0-3 or 5, from the list popost video speech-kind show prints.' });
        continue;
      }
      for (let i = range[0]; i <= range[1]; i++) {
        const before = named.get(i);
        if (before && before !== kind) problems.push({ at: '--' + kind, message: 'Phrase ' + i + ' is named as ' + before + ' and as ' + kind + '.', fix: 'Give every phrase one kind.' });
        named.set(i, kind);
        kinds.set(i, kind);
      }
    }
  }
  const open = f.phrases.filter((p) => !kinds.has(p.index)).map((p) => p.index);
  if (open.length) problems.push({ at: 'phrases', message: open.length + ' phrase(s) have no kind yet: ' + runs(open) + '.', fix: 'Look at the frame of each (its picture and time are in the list) and name its kind: --narration, --on-camera, --sung or --fragments with their numbers.' });
  if (problems.length) return { problems };
  const phrases = f.phrases.map((p) => ({ ...p, kind: kinds.get(p.index) as PhraseKind }));
  const { from: _default, ...rest } = f;
  return { file: { ...rest, confirmed: true, kinds: kindsOf(f.status, phrases), phrases }, problems };
};

/** Numbers as runs: 2-4, 7. */
export const runs = (xs: readonly number[]): string =>
  xs.reduce<[number, number][]>((out, x) => {
    const last = out[out.length - 1];
    if (last && last[1] === x - 1) last[1] = x;
    else out.push([x, x]);
    return out;
  }, []).map(([a, b]) => (a === b ? String(a) : a + '-' + b)).join(', ');

const WHY: Readonly<Record<Exclude<SpeechStatus, 'transcribed' | 'silent'>, string>> = {
  skipped: 'the transcription was skipped (--no-speech)',
  failed: 'the transcription failed',
  'no-tool': 'no transcriber was available',
};

/** What each kind means for the re-make, in a few words. */
export const KIND_MEANS: Readonly<Record<SpeechKind, string>> = {
  narration: 're-made as a voice-over',
  'on-camera': 're-made as a person who says the lines in a generated clip (speech.lines), never as a voice-over',
  sung: 'no voice: sung words are not spoken lines',
  fragments: 'no voice: a few exclamations are not a script',
  none: 'no voice-over',
  unknown: 'treated as no narration: no voice-over unless the user asks for one',
};

/** The line of REFERENCE.md about the kind of the speech. */
export const kindLine = (f: SpeechFile): string => {
  if (f.status === 'silent') return '- Speech: none (the video has no sound): no voice-over';
  if (f.status !== 'transcribed') return '- Speech was not transcribed: ' + WHY[f.status] + (f.why && f.status === 'failed' ? ' (' + f.why + ')' : '') + '. Speech kind: unknown, ' + KIND_MEANS.unknown + (f.status === 'failed' ? '. Run describe again to transcribe it' : '');
  if (!f.phrases.length) return '- Speech: none recognised: no voice-over';
  if (!f.confirmed) return '- Speech kind: unconfirmed. Whether these words are narration, said on camera or sung is not something a program hears: open the pictures of the phrases and confirm it (popost video speech-kind show <this directory>)';
  if (f.kinds.length === 1 && f.kinds[0] === 'fragments' && f.phrases.every((p) => p.kind === 'fragments'))
    return '- Speech kind: fragments (' + f.phrases.length + ' short phrase' + (f.phrases.length === 1 ? '' : 's') + ', ' + f.seconds.spoken.toFixed(1) + ' s of ' + f.seconds.video.toFixed(1) + ' s): ' + KIND_MEANS.fragments;
  return '- Speech kind: ' + PHRASE_KINDS.filter((k) => f.kinds.includes(k)).map((k) => k + ' (phrases ' + runs(f.phrases.filter((p) => p.kind === k).map((p) => p.index)) + '): ' + KIND_MEANS[k]).join('; ')
    + (f.from === 'sound-analysis' ? '. A default from the sound analysis (vocals in the music, short and sparse phrases), not from the frames: popost video speech-kind confirm corrects it' : '');
};

/** A stretch of the reference with the kind of the speech in it, in source frames: what the beats are read with. */
export interface KindRange { start: number; end: number; kind: PhraseKind }

/** The confirmed phrases as ranges; undefined for a record that is not confirmed (the beats are then read without kinds). */
export const kindRanges = (f: SpeechFile | undefined): KindRange[] | undefined =>
  f && f.confirmed ? f.phrases.flatMap((p) => (p.kind ? [{ start: p.start, end: p.end, kind: p.kind }] : [])) : undefined;

/** What a template keeps of the record: why the speech is known or not, and the kinds. */
export interface SpeechFacts { status: SpeechStatus; kinds: SpeechKind[] }
export const factsOfSpeech = (f: SpeechFile): SpeechFacts => ({ status: f.status, kinds: f.kinds });
