/**
 * A caption cue that follows the words: each unit of its text (src/align tokenize) gets the characters it covers and the
 * frames it is spoken on, by aligning the cue's text to the tokens spoken inside the cue's span (alignScript, forgiving:
 * a misheard or missing word is placed between its neighbours). Pure: check and resolve share it.
 */
import type { ResolvedWord } from '../types';
import { alignScript, tokenize } from '../align/index';
import { joinUnits, type PlacedToken } from './words';

const LATIN = /^[A-Za-z0-9]$/;

/**
 * Characters from .. to-1 (by code point, as text spans count) of every unit of a text, in the order tokenize gives
 * them: a run of Latin letters or digits is one unit, any other character tokenize keeps is one unit by itself.
 */
export const unitRanges = (text: string): { from: number; to: number }[] => {
  const chars = Array.from(text);
  const out: { from: number; to: number }[] = [];
  let p = 0;
  while (p < chars.length) {
    const ch = chars[p] ?? '';
    if (LATIN.test(ch)) {
      let q = p;
      while (q < chars.length && LATIN.test(chars[q] ?? '')) q++;
      out.push({ from: p, to: q });
      p = q;
    } else {
      if (tokenize(ch).length === 1) out.push({ from: p, to: p + 1 });
      p++;
    }
  }
  return out;
};

export interface CueWords {
  words: ResolvedWord[];
  /** Share of the cue's units heard as written inside its span (src/align matchedShare); 0 when nothing was spoken there. */
  matchedShare: number;
  /** The tokens spoken inside the span, joined, for messages. */
  heard: string;
}

/** Frames start .. end-1 shared evenly by count units, at least one frame each where there is room. */
const even = (count: number, start: number, end: number): { start: number; end: number }[] =>
  Array.from({ length: count }, (_x, k) => {
    const s = start + Math.floor((k * (end - start)) / count);
    return { start: Math.min(s, end - 1), end: Math.min(end, Math.max(s + 1, start + Math.floor(((k + 1) * (end - start)) / count))) };
  });

/**
 * The words of a cue shown on frames start .. end-1: its units matched to the tokens that overlap those frames. Times
 * outside the cue are pulled to its edges. With no token spoken there, the units share the cue's frames evenly.
 */
export const cueWords = (text: string, start: number, end: number, tokens: readonly PlacedToken[]): CueWords => {
  const ranges = unitRanges(text);
  const inside = tokens.filter((t) => t.end > start && t.start < end);
  const heard = joinUnits(inside.map((t) => t.text));
  if (!inside.length) {
    const frames = even(ranges.length, start, end);
    return { words: ranges.map((r, k) => ({ ...r, start: frames[k]?.start ?? start, end: frames[k]?.end ?? end })), matchedShare: 0, heard };
  }
  const a = alignScript(text, inside.map((t) => ({ text: t.text, start: t.start, end: t.end, confidence: t.confidence })));
  const words = ranges.map((r, k): ResolvedWord => {
    const t = a.tokens[k];
    const s = Math.min(end - 1, Math.max(start, t?.start ?? start));
    return { ...r, start: s, end: Math.min(end, Math.max(s + 1, t?.end ?? s + 1)) };
  });
  return { words, matchedShare: a.matchedShare, heard };
};
