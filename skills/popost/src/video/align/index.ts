/**
 * Forgiving alignment: the words of a script get times from the words a recogniser heard. The two never agree
 * exactly (a name is misheard, a word is dropped, a filler is added), and that must not fail: what matches takes the
 * recognised time, what does not is placed between its neighbours, and every token says how sure its time is.
 *
 * Tokens: one per CJK character, one per run of Latin letters or digits. Punctuation and spaces carry no time.
 */
import type { SpokenWord } from '../speech/types';

export interface AlignedToken {
  text: string;
  /** Frames: spoken on start .. end-1. */
  start: number;
  end: number;
  /** 1: heard as written. About 0.5: something else was heard in its place. About 0.2: nothing was heard; the time is interpolated. */
  confidence: number;
  matched: boolean;
}

export interface Alignment {
  tokens: AlignedToken[];
  /** Share of the script's tokens that were heard as written. */
  matchedShare: number;
  /** Mean confidence of the tokens' times. */
  confidence: number;
}

const TOKEN = /[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]|[A-Za-z0-9]+/gu;

/** The timed units of a text, lower-cased. */
export const tokenize = (text: string): string[] => (text.match(TOKEN) ?? []).map((t) => t.toLowerCase());

interface Heard { text: string; start: number; end: number; confidence: number }

/** A recognised word of several units shares its time evenly among them (recognisers give no times inside a word). */
const heardTokens = (words: SpokenWord[]): Heard[] =>
  words.flatMap((w) => {
    const units = tokenize(w.text);
    const span = (w.end - w.start) / Math.max(1, units.length);
    return units.map((text, i) => ({ text, start: w.start + i * span, end: w.start + (i + 1) * span, confidence: w.confidence }));
  });

/** Costs of the three ways two sequences can disagree. A substitution is cheaper than a drop plus an addition. */
const SUBSTITUTE = 1, DROPPED = 0.8, ADDED = 0.7;

type Step = 'match' | 'substitute' | 'dropped' | 'added';

/** The cheapest way to turn the heard tokens into the script's: for every script token, the heard token it pairs with. */
const pair = (script: string[], heard: Heard[]): (number | undefined)[] => {
  const n = script.length, m = heard.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from = Array.from({ length: n + 1 }, () => new Array<Step>(m + 1));
  for (let i = 1; i <= n; i++) { (cost[i] as Float64Array)[0] = i * DROPPED; (from[i] as Step[])[0] = 'dropped'; }
  for (let j = 1; j <= m; j++) { (cost[0] as Float64Array)[j] = j * ADDED; (from[0] as Step[])[j] = 'added'; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = script[i - 1] === heard[j - 1]?.text;
      const diagonal = ((cost[i - 1] as Float64Array)[j - 1] ?? 0) + (same ? 0 : SUBSTITUTE);
      const dropped = ((cost[i - 1] as Float64Array)[j] ?? 0) + DROPPED;
      const added = ((cost[i] as Float64Array)[j - 1] ?? 0) + ADDED;
      const best = Math.min(diagonal, dropped, added);
      (cost[i] as Float64Array)[j] = best;
      (from[i] as Step[])[j] = best === diagonal ? (same ? 'match' : 'substitute') : best === dropped ? 'dropped' : 'added';
    }
  }
  const pairs = new Array<number | undefined>(n).fill(undefined);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const step = (from[i] as Step[])[j];
    if (step === 'match' || step === 'substitute') { pairs[i - 1] = j - 1; i--; j--; }
    else if (step === 'dropped') i--;
    else j--;
  }
  return pairs;
};

/**
 * script: the text as written (its spoken form, when a name has one). words: what was heard, in frames.
 * Returns one token per unit of the script, in order, with times that never run backwards.
 */
export const alignScript = (script: string, words: SpokenWord[]): Alignment => {
  const units = tokenize(script);
  const heard = heardTokens(words);
  if (!units.length) return { tokens: [], matchedShare: 1, confidence: 1 };
  const pairs = heard.length ? pair(units, heard) : units.map(() => undefined);
  const tokens: AlignedToken[] = units.map((text, k) => {
    const h = pairs[k] === undefined ? undefined : heard[pairs[k] as number];
    if (!h) return { text, start: NaN, end: NaN, confidence: 0.2, matched: false };
    const matched = h.text === text;
    return { text, start: h.start, end: h.end, confidence: Math.round((matched ? 1 : 0.5) * Math.max(0.3, h.confidence) * 100) / 100, matched };
  });
  // Tokens nothing was heard for share the gap between their timed neighbours; at an end they take the mean length.
  const timed = tokens.filter((t) => !Number.isNaN(t.start));
  const mean = timed.length ? timed.reduce((s, t) => s + t.end - t.start, 0) / timed.length : 3;
  for (let k = 0; k < tokens.length; k++) {
    if (!Number.isNaN((tokens[k] as AlignedToken).start)) continue;
    let end = k;
    while (end < tokens.length && Number.isNaN((tokens[end] as AlignedToken).start)) end++;
    const before = k > 0 ? (tokens[k - 1] as AlignedToken).end : undefined;
    const after = end < tokens.length ? (tokens[end] as AlignedToken).start : undefined;
    const count = end - k;
    const from = before ?? (after === undefined ? 0 : after - count * mean);
    const to = after ?? from + count * mean;
    const span = Math.max(0, to - from) / count;
    for (let q = k; q < end; q++) { (tokens[q] as AlignedToken).start = from + (q - k) * span; (tokens[q] as AlignedToken).end = from + (q - k + 1) * span; }
    k = end - 1;
  }
  // Whole frames, in order, at least one frame each.
  let clock = Math.max(0, Math.round((tokens[0] as AlignedToken).start));
  for (const t of tokens) {
    const start = Math.max(clock, Math.round(t.start));
    const end = Math.max(start + 1, Math.round(t.end));
    t.start = start; t.end = end; clock = end;
  }
  const matchedShare = tokens.filter((t) => t.matched).length / tokens.length;
  return { tokens, matchedShare: Math.round(matchedShare * 100) / 100, confidence: Math.round((tokens.reduce((s, t) => s + t.confidence, 0) / tokens.length) * 100) / 100 };
};

/**
 * Where a phrase of the script is spoken: the frames of its first and last token. occurrence counts from 1.
 * undefined when the phrase is not in the script that many times.
 */
export const findPhrase = (alignment: Alignment, phrase: string, occurrence = 1): { start: number; end: number; confidence: number; index: number } | undefined => {
  const want = tokenize(phrase);
  if (!want.length) return undefined;
  let seen = 0;
  for (let k = 0; k + want.length <= alignment.tokens.length; k++) {
    if (!want.every((w, q) => alignment.tokens[k + q]?.text === w)) continue;
    if (++seen < occurrence) continue;
    const part = alignment.tokens.slice(k, k + want.length);
    return { start: (part[0] as AlignedToken).start, end: (part[part.length - 1] as AlignedToken).end, confidence: Math.min(...part.map((t) => t.confidence)), index: k };
  }
  return undefined;
};

/** How often a phrase occurs in a script, for error messages about an ambiguous or missing phrase. */
export const countPhrase = (script: string, phrase: string): number => {
  const all = tokenize(script), want = tokenize(phrase);
  if (!want.length) return 0;
  let n = 0;
  for (let k = 0; k + want.length <= all.length; k++) if (want.every((w, q) => all[k + q] === w)) n++;
  return n;
};
