/**
 * What the measured look of the source's captions (text/look.ts) says of a fill: how many lines mark a word or two,
 * against the share of the source's lines that had a highlighted word, and whether the lines are asked to build word
 * by word when the source showed each line whole. Pure.
 */
import type { Problem } from '../types';
import { warning } from '../project/check-common';
import { unmark } from '../retarget/marks';
import { oneIn } from '../text/share';
import type { CaptionLook } from '../text/types';

/** Fewer measured lines than this say too little about a share. */
const MIN_LINES = 6;

/** The fill's highlighted share against the source's: under half of it, or more than double. */
const shareProblems = (look: CaptionLook, lines: string[]): Problem[] => {
  const h = look.highlight;
  const share = h?.share ?? (h && look.samples ? h.lines / look.samples : undefined);
  if (!h || share === undefined || look.samples < MIN_LINES || h.confidence < 0.6) return [];
  const drawn = lines.filter((l) => l.trim() !== '');
  if (drawn.length < 4) return [];
  const marked = drawn.filter((l) => unmark(l).marks.length > 0).length;
  const want = Math.max(1, Math.round(share * drawn.length));
  const source = 'The source highlighted a word or two in ' + oneIn(share) + ' (' + h.lines + ' of the ' + look.samples + ' lines measured' + (h.color ? ', in ' + h.color : '') + ')';
  if (marked < 0.5 * share * drawn.length)
    return [warning('captions', source + '; the fill marks ' + marked + ' of its ' + drawn.length + ' lines.', 'Mark about ' + want + ' lines (' + (want - marked) + ' more): wrap the one or two words that carry the line in asterisks, "*like this*".')];
  if (marked > 2 * share * drawn.length && marked - want >= 2)
    return [warning('captions', source + '; the fill marks ' + marked + ' of its ' + drawn.length + ' lines, more than double.', 'Keep the marks on about ' + want + ' lines (remove them from ' + (marked - want) + '): a highlight on every line stresses nothing.')];
  return [];
};

const revealProblems = (look: CaptionLook, fill: { captionReveal?: unknown }): Problem[] => {
  const r = look.reveal;
  if (!r || r.confidence < 0.6) return [];
  if (r.kind === 'whole' && fill.captionReveal === 'words')
    return [warning('captionReveal', 'The source showed each caption line whole at once (' + r.lines + ' of the ' + r.of + ' line starts measured); the fill builds every line word by word.', 'Remove "captionReveal" (or set it to "whole"), unless the user asked for the words to appear one by one.')];
  return [];
};

export const captionLookProblems = (look: CaptionLook | undefined, fill: { captions?: unknown; captionReveal?: unknown }): Problem[] => {
  if (!look) return [];
  const lines = Array.isArray(fill.captions) ? fill.captions.filter((l): l is string => typeof l === 'string') : [];
  return [...shareProblems(look, lines), ...revealProblems(look, fill)];
};
