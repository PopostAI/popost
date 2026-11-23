/**
 * Checks of how things look: gradients, text styles and their spans, the look of an item (loop, mask), font materials.
 */
import type { Fill, ImageTrack, Material, Problem, TextSpanStyle, TextStyle, VideoTrack, VisualTrack } from '../types';
import { LOOP_AMOUNT_RANGE } from '../presets/loop';
import { error, warning, type CheckContext } from './check-common';

/** Text smaller than this share of the canvas height is hard to read on a phone. */
export const MIN_TEXT_SIZE = 0.022;

/** Font files a page can declare. */
export const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf'];

/** A gradient's stops must not go back. */
export const checkFill = (fill: Fill, at: string): Problem[] =>
  typeof fill === 'string'
    ? []
    : fill.stops.flatMap((s, i) => {
        const prev = fill.stops[i - 1];
        return prev && s.at < prev.at
          ? [error(at + '.stops[' + i + '].at', 'Stop ' + i + ' is at ' + s.at + ', before stop ' + (i - 1) + ' (at ' + prev.at + '); stops go in order along the gradient.', 'Give it an "at" of at least ' + prev.at + ', or move it before stop ' + (i - 1) + '.')]
          : [];
      });

const spanText = (s: TextSpanStyle): string => '[' + s.from + ', ' + s.to + ')';

/** Spans against the text they style: inside it (counted by code point) and not overlapping. */
export const checkSpans = (spans: readonly TextSpanStyle[] | undefined, text: string, at: string, what: string): Problem[] => {
  if (!spans) return [];
  const length = Array.from(text).length;
  const out: Problem[] = [];
  spans.forEach((s, i) => {
    const here = at + '[' + i + ']';
    if (s.to <= s.from) out.push(error(here + '.to', 'Span ' + i + ' of ' + what + ' ends (to ' + s.to + ') where or before it starts (from ' + s.from + ').', 'Make "to" larger than "from": the span covers characters from .. to-1.'));
    else if (s.to > length)
      out.push(error(here + '.to', 'Span ' + i + ' of ' + what + ' runs to character ' + s.to + ', but the text has ' + length + ' characters (counted by code point: a Chinese character or an emoji is one).',
        'Set "to" to at most ' + length + '.'));
  });
  const order = spans.map((s, i) => ({ s, i })).sort((a, b) => a.s.from - b.s.from || a.i - b.i);
  order.forEach(({ s, i }, j) => {
    const prev = order[j - 1];
    if (prev && s.from < prev.s.to)
      out.push(error(at + '[' + i + ']', 'Span ' + i + ' ' + spanText(s) + ' of ' + what + ' overlaps span ' + prev.i + ' ' + spanText(prev.s) + '; a character takes the look of one span.',
        'Start span ' + i + ' at ' + prev.s.to + ' or later, or end span ' + prev.i + ' at ' + s.from + '.'));
  });
  return out;
};

/** A text style object: readable size, and its spans against the text. Named styles were checked by the schema. */
export const checkTextStyle = (ctx: CheckContext, style: string | TextStyle | undefined, text: string | undefined, at: string, what: string): Problem[] => {
  if (typeof style !== 'object') return [];
  const out: Problem[] = [];
  if (style.size !== undefined && style.size < MIN_TEXT_SIZE) {
    const px = Math.round(style.size * ctx.project.canvas.height);
    out.push(warning(at + '.size', what + ' is ' + (style.size * 100).toFixed(1) + '% of the canvas height (' + px + ' px), smaller than ' + (MIN_TEXT_SIZE * 100).toFixed(1) + '%, which is hard to read on a phone.',
      'Use a size of at least ' + MIN_TEXT_SIZE + ', for example 0.035.'));
  }
  return text === undefined ? out : [...out, ...checkSpans(style.spans, text, at + '.spans', what)];
};

const loopProblems = (t: VisualTrack, at: string): Problem[] => {
  if (!t.loop || t.loop.amount === undefined) return [];
  const [lo, hi] = LOOP_AMOUNT_RANGE[t.loop.preset];
  return t.loop.amount < lo || t.loop.amount > hi
    ? [error(at + '.loop.amount', 'The ' + t.loop.preset + ' loop of "' + t.id + '" has amount ' + t.loop.amount + '; it must be from ' + lo + ' to ' + hi + '.', 'Use an amount from ' + lo + ' to ' + hi + ', or remove it for the default.')]
    : [];
};

const maskProblems = (t: ImageTrack | VideoTrack, at: string): Problem[] =>
  t.mask !== undefined && t.radius !== undefined
    ? [warning(at + '.radius', '"' + t.id + '" has a mask, which already sets its outline, so "radius" is ignored.', 'Remove "radius", or remove "mask" to keep rounded corners.')]
    : [];

/** What every visual item may carry: a loop, a fill, a mask. */
export const checkLook = (t: VisualTrack, at: string): Problem[] => [
  ...loopProblems(t, at),
  ...(t.type === 'shape' ? checkFill(t.color, at + '.color') : []),
  ...(t.type === 'image' || t.type === 'video' ? maskProblems(t, at) : []),
];

const fontProblems = (m: Material, i: number): Problem[] => {
  const at = 'materials[' + i + '].file';
  if (!m.file) return [error(at, 'Font material "' + m.id + '" has no file.', 'Set "file" to a font file in the project directory, for example "assets/' + m.id + '.woff2".', FONT_EXTENSIONS)];
  const ext = m.file.slice(m.file.lastIndexOf('.')).toLowerCase();
  return FONT_EXTENSIONS.includes(ext) ? [] : [error(at, 'The file "' + m.file + '" of font material "' + m.id + '" is not a font file this engine declares.', 'Use a WOFF2, WOFF, TTF or OTF file.', FONT_EXTENSIONS)];
};

/** Every font material has a file with a font extension (that it exists is checked with the other files). */
export const checkFonts = (ctx: CheckContext): Problem[] => ctx.project.materials.flatMap((m, i) => (m.kind === 'font' ? fontProblems(m, i) : []));
