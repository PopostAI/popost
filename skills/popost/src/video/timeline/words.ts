/**
 * Words on the timeline: the tokens of every audio track whose material names a words file, in project frames (the
 * conversion in the header of types.ts), and phrase spans placed on them. Pure and DOM-free: check and resolve share it.
 */
import type { Project, Span, WordToken, WordsFile, WordsInfo } from '../types';
import { tokenize } from '../align/index';
import { editDistance } from '../project/suggest';
import { framesOf, spanFrames, wholeVideo, type SpanFrames, type Timeline } from './spans';

/** What the build step read from each words file, by material id (compile/words.ts). A material not in it was not read. */
export type WordsTable = Readonly<Record<string, WordsInfo>>;

/** A token on the timeline, frames start .. end-1 of the project. key: its unit as phrases are matched (lower case). */
export interface PlacedToken { text: string; key: string; start: number; end: number; confidence: number }

/**
 * An audio track that plays a material with a words file. start / end: the track's frames (end only when "during"
 * ends it). tokens: absent when the file was not read or cannot be used (check reports it at the material).
 */
export interface TrackWords { track: string; material: string; start: number; end?: number; tokens?: PlacedToken[] }

export const isWordsFile = (w: WordsInfo | undefined): w is WordsFile => w !== undefined && !('error' in w);

/** Token frames at the file's rate as whole frames at the project's rate: rounded, in order, at least one frame each. */
export const toProjectFrames = (tokens: readonly WordToken[], fileFps: number, fps: number): { start: number; end: number }[] => {
  let clock = 0;
  return tokens.map((t) => {
    const start = Math.max(clock, Math.round((t.start * fps) / fileFps));
    const end = Math.max(start + 1, Math.round((t.end * fps) / fileFps));
    clock = end;
    return { start, end };
  });
};

const placeTokens = (file: WordsFile, fps: number, at: number): PlacedToken[] => {
  const frames = toProjectFrames(file.tokens, file.fps, fps);
  return file.tokens.map((t, k) => ({
    text: t.text, key: tokenize(t.text)[0] ?? '', start: at + (frames[k]?.start ?? 0), end: at + (frames[k]?.end ?? 1), confidence: t.confidence,
  }));
};

/** Every audio track whose material names a words file, in file order, with its words on the timeline. */
export const trackWords = (project: Project, tl: Timeline, table: WordsTable): TrackWords[] => {
  const materials = new Map(project.materials.map((m) => [m.id, m] as const).reverse());
  return project.tracks.flatMap((t): TrackWords[] => {
    if (t.type !== 'audio') return [];
    const m = materials.get(t.material);
    if (!m?.words || m.kind !== 'audio') return [];
    const span = t.during ? spanFrames(tl, t.during) : wholeVideo(tl);
    const start = span?.start ?? 0;
    const file = table[m.id];
    const base: TrackWords = { track: t.id, material: m.id, start, ...(t.during && span ? { end: span.end } : {}) };
    return [isWordsFile(file) ? { ...base, tokens: placeTokens(file, project.canvas.fps, start-(t.in??0)).filter(token=>token.end>start&&token.start<(span?.end??Infinity)).map(token=>({...token,start:Math.max(start,token.start),end:Math.min(span?.end??Infinity,token.end)})) } : base];
  });
};

/** The track a span or a caption track names with "of" / "words", or the only one; undefined when that is not clear. */
export const pickWords = (words: readonly TrackWords[], of: string | boolean | undefined): TrackWords | undefined => {
  if (typeof of === 'string') return words.find((w) => w.track === of);
  return words.length === 1 ? words[0] : undefined;
};

/** Every token index at which the units start in this order. */
export const phraseIndexes = (tokens: readonly PlacedToken[], units: readonly string[]): number[] => {
  const out: number[] = [];
  if (!units.length) return out;
  for (let k = 0; k + units.length <= tokens.length; k++) if (units.every((u, q) => tokens[k + q]?.key === u)) out.push(k);
  return out;
};

/** Where one occurrence of a phrase is spoken: its first and last token and their frames, and its lowest confidence. */
export interface PhrasePlace { first: number; last: number; start: number; end: number; confidence: number }

export const placeAt = (tokens: readonly PlacedToken[], first: number, count: number): PhrasePlace => {
  const part = tokens.slice(first, first + count);
  return { first, last: first + count - 1, start: part[0]?.start ?? 0, end: part[part.length - 1]?.end ?? 0, confidence: Math.min(...part.map((t) => t.confidence)) };
};

/** Frames of a phrase span: from the first token's first frame - lead to its last token's last frame + hold. */
export const phraseFrames = (tl: Timeline, place: PhrasePlace, span: Span): SpanFrames =>
  framesOf(tl, place.start - (span.lead ?? 0), place.end + (span.hold ?? 0));

/** The place of a phrase span, when it is clear: one occurrence, or the one asked for. */
export const findPhrase = (tokens: readonly PlacedToken[], span: Span): PhrasePlace | undefined => {
  const units = tokenize(span.phrase ?? '');
  const at = phraseIndexes(tokens, units);
  const k = span.occurrence === undefined ? (at.length === 1 ? at[0] : undefined) : at[span.occurrence - 1];
  return k === undefined ? undefined : placeAt(tokens, k, units.length);
};

/** Absolute frames of any span; undefined when it cannot be placed (check says why). */
export const placeSpan = (tl: Timeline, words: readonly TrackWords[], span: Span): SpanFrames | undefined => {
  if (span.phrase === undefined) return spanFrames(tl, span);
  const tokens = pickWords(words, span.of)?.tokens;
  const place = tokens ? findPhrase(tokens, span) : undefined;
  return place ? phraseFrames(tl, place, span) : undefined;
};

/** Units joined back into text: a space only between two Latin or digit units. */
export const joinUnits = (texts: readonly string[]): string =>
  texts.reduce((s, t, i) => (i > 0 && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(t) ? s + ' ' + t : s + t), '');

/**
 * The phrases of the words nearest to one that is not in them, by edit distance over windows of one unit fewer to
 * one unit more, nearest first, at most max, each once, with where it starts.
 */
export const nearestPhrases = (tokens: readonly PlacedToken[], phrase: string, max = 3): { text: string; start: number }[] => {
  const units = tokenize(phrase);
  const want = joinUnits(units);
  const seen = new Set<string>();
  const ranked: { text: string; start: number; d: number }[] = [];
  for (const n of [units.length - 1, units.length, units.length + 1]) {
    if (n < 1) continue;
    for (let k = 0; k + n <= tokens.length; k++) {
      const part = tokens.slice(k, k + n);
      const key = joinUnits(part.map((t) => t.key));
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ text: joinUnits(part.map((t) => t.text)), start: part[0]?.start ?? 0, d: editDistance(key, want) });
    }
  }
  // Nearest first; at the same distance a phrase of the same length first, then the earlier one.
  const len = (s: string): number => Math.abs(tokenize(s).length - units.length);
  return ranked.sort((a, b) => a.d - b.d || len(a.text) - len(b.text) || a.start - b.start).slice(0, max).map(({ text, start }) => ({ text, start }));
};
