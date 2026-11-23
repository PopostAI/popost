/**
 * The reference's own content repeated in the new video: a figure the reference showed that no source of the project
 * holds (its star count claimed for another product), or a phrase of its on-screen text word for word (its demo page
 * redrawn with its words). The reference gives a video its layout and its motion, not its content. Text the request
 * or a source of the project also holds belongs to the new video too (a product name both share) and is not reported.
 * The figures are matched as the number check matches them (numbers.ts); a phrase is at least six CJK characters or
 * three words in a row, very common words, punctuation and case left out. Pure.
 */
import { traced, valuesIn, type Figure } from './numbers';

/** A line of the reference's on-screen text and the shot (from 0) it was on screen in. */
export interface ReferenceLine { shot: number; text: string }

/** What a text repeats of the reference: the figure as shown or the words as written, and the reference's line it came from. */
export interface Repeat { shown: string; line: ReferenceLine }

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
/** A token: one CJK character, or a word (letters and digits between spaces, punctuation and symbols). */
const TOKEN = new RegExp('[' + CJK + ']|[^\\s\\p{P}\\p{S}' + CJK + ']+', 'gu');
const IS_CJK = new RegExp('^[' + CJK + ']$', 'u');
/** Words and characters too common to make a phrase anyone's: left out before phrases are compared. */
const COMMON = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'into', 'about',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'you', 'your', 'we', 'our',
  'us', 'i', 'my', 'me', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'not', 'no', 'so', 'do', 'does', 'can', 'will',
  'just', 'than', 'then', 'there', 'here', 'what', 'which', 'who', 'how', 'all', 'more', 'very', 'up', 'out', 'if',
  '的', '了', '是', '在', '和', '与', '也', '都', '就', '吗', '呢', '吧', '啊', '呀', '着',
]);
/** A phrase weighs this much at least: a word weighs 1, a CJK character half, a token with a digit nothing (a figure is matched as one). */
const PHRASE = 3;
/** Around every token, so that a run is found as whole tokens; between lines, so that a run never spans two. */
const SEP = '\x01';
const LINE = '\x02';

interface Token { t: string; at: number; end: number; weight: number }

/** The tokens of a text (NFKC, lower case), each with where it is in the normalized text. */
const tokensOf = (text: string): Token[] => {
  const tokens: Token[] = [];
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    const t = m[0], at = m.index ?? 0;
    if (COMMON.has(t)) continue;
    tokens.push({ t, at, end: at + t.length, weight: /\d/.test(t) ? 0 : IS_CJK.test(t) ? 0.5 : 1 });
  }
  return tokens;
};

const keyOf = (tokens: readonly Token[]): string => SEP + tokens.map((x) => x.t).join(SEP) + SEP;

/** A figure written with a unit or a sign (59K, $59, 35%, +12, 2万), not digits alone: the kind that is a claim. */
const withUnit = (f: Figure): boolean => /[^\d.,\s]/.test(f.shown);

/**
 * A checker for one reference and one project. sources: the texts of the project's sources and its request (numbers.ts
 * projectTexts, and texts given besides); sourceValues: their values, as the number check reads them.
 */
export const repeatsOf = (reference: readonly ReferenceLine[], sources: readonly string[], sourceValues: Float64Array) => {
  const lines = reference.map((line) => ({ line, key: keyOf(tokensOf(line.text)), values: valuesIn([line.text]) }));
  const all = lines.map((l) => l.key).join(LINE);
  const told = sources.map((s) => keyOf(tokensOf(s))).join(LINE);
  const referenceValues = valuesIn(reference.map((l) => l.text));
  /** The figures of a list (those no source holds) that the reference showed with a unit or a sign, each with the first line that shows it. */
  const figures = (untraced: readonly Figure[]): (Repeat & { figure: Figure })[] =>
    untraced.filter((f) => withUnit(f) && traced(f, referenceValues) && !traced(f, sourceValues)).flatMap((f) => {
      const line = lines.find((l) => traced(f, l.values))?.line;
      return line ? [{ shown: f.shown, line, figure: f }] : [];
    });
  /** The phrases of a text that a line of the reference has word for word and no source has: the longest from each start, left to right. */
  const phrases = (text: string): Repeat[] => {
    const normal = text.normalize('NFKC');
    const tokens = tokensOf(text);
    const out: Repeat[] = [];
    for (let i = 0; i < tokens.length;) {
      let j = i;
      while (j < tokens.length && all.includes(keyOf(tokens.slice(i, j + 1)))) j++;
      const run = tokens.slice(i, j);
      const key = keyOf(run);
      const line = run.reduce((n, x) => n + x.weight, 0) >= PHRASE && !told.includes(key) ? lines.find((l) => l.key.includes(key))?.line : undefined;
      if (line) out.push({ shown: normal.slice(run[0]?.at ?? 0, run[run.length - 1]?.end ?? 0), line });
      i = line ? j : i + 1;
    }
    return out;
  };
  return { figures, phrases };
};

export type Repeats = ReturnType<typeof repeatsOf>;
