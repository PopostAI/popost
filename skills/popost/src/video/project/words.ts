/**
 * Words files (types.ts WordsFile): what is said in an audio material and when, one token per unit of the script,
 * exactly as src/align writes its tokens. parseWordsFile checks a file's content (the build step reads the file,
 * compile/words.ts); wordsFileOf writes one from an alignment.
 */
import { z } from 'zod';
import type { WordsFile, WordsInfo } from '../types';
import { tokenize, type AlignedToken, type Alignment } from '../align/index';
import { issueProblems } from './issues';

const TokenSchema = z.object({
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  confidence: z.number().min(0).max(1).default(1),
  matched: z.boolean().default(true),
});
const WordsFileSchema = z.object({ fps: z.number().gt(0).max(1000), tokens: z.array(TokenSchema) });

const FORMAT = '{ "fps": 30, "tokens": [{ "text": "一", "start": 0, "end": 5, "confidence": 1, "matched": true }, ...] }';

/** The first thing wrong with token k against the one before it, or undefined. */
const tokenError = (file: WordsFile, k: number): { error: string; fix: string } | undefined => {
  const t = file.tokens[k];
  if (!t) return undefined;
  const units = tokenize(t.text);
  const what = 'token ' + k + ' ("' + t.text + '", frames ' + t.start + '..' + (t.end - 1) + ')';
  if (units.length !== 1)
    return {
      error: what + ' is ' + (units.length === 0 ? 'no unit (only punctuation or spaces)' : units.length + ' units (' + units.join(', ') + ')') + '; a token is one CJK character or one run of Latin letters or digits.',
      fix: units.length === 0 ? 'Remove it: punctuation carries no time.' : 'Split it into ' + units.length + ' tokens, one per unit, sharing its frames.',
    };
  if (t.end <= t.start) return { error: what + ' ends (end ' + t.end + ') where or before it starts (start ' + t.start + ').', fix: 'Make "end" larger than "start": the token is spoken on start .. end-1.' };
  const prev = file.tokens[k - 1];
  if (prev && t.start < prev.end)
    return {
      error: what + ' starts before token ' + (k - 1) + ' ("' + prev.text + '") ends (frame ' + prev.end + '); tokens are in the order they are spoken and do not overlap.',
      fix: 'Start it at frame ' + prev.end + ' or later, or end token ' + (k - 1) + ' at ' + t.start + '. Frames count from the start of the audio file.',
    };
  return undefined;
};

/** A words file's content, or the first reason it cannot be used. name: the file, for messages. */
export const parseWordsFile = (json: unknown, name: string): WordsInfo => {
  const parsed = WordsFileSchema.safeParse(json, { reportInput: true });
  if (!parsed.success) {
    const first = issueProblems(parsed.error.issues)[0];
    return { error: 'The words file "' + name + '" is not a words file: ' + (first?.message ?? 'wrong shape'), fix: (first?.fix ? first.fix + ' ' : '') + 'The format is ' + FORMAT + ' (as src/align writes it).' };
  }
  const file: WordsFile = parsed.data;
  for (let k = 0; k < file.tokens.length; k++) {
    const e = tokenError(file, k);
    if (e) return { error: 'In the words file "' + name + '", ' + e.error, fix: e.fix };
  }
  return file;
};

/** A words file from an alignment (src/align): the tokens as they are, frames at fps. What retarget --speak writes. */
export const wordsFileOf = (alignment: Alignment, fps: number): WordsFile => ({
  fps,
  tokens: alignment.tokens.map((t: AlignedToken) => ({ text: t.text, start: t.start, end: t.end, confidence: t.confidence, matched: t.matched })),
});
