/**
 * Words the reference laid over a shot: its text cues with the role title (large text set in the edit, not a caption,
 * a watermark or the footage's own text; text/cues.ts), such as a sticker word over a clip or a heading over a recorded
 * page. A fill gives each place its new words by position, shots[k].words[j], and they are drawn where the reference
 * had them, at its size and on its frames of the shot, moving with the shot when time is re-flowed to speech. Words
 * wrapped in asterisks, *like this*, are drawn in a colour that stands out (marks.ts). The colour of the reference's
 * words is not measured: they are white with a dark outline, as unmeasured captions are.
 */
import { shownIn } from '../describe/kind';
import { barsOf } from '../text/bar';
import { DEFAULT_LINE_HEIGHT } from '../presets/text-styles';
import type { TextTrack } from '../text/types';
import type { Box, Measure, Problem, TextStyle, Track } from '../types';
import { captionStyle } from './caption-look';
import { highlightColour, markSpans, unmark } from './marks';

/**
 * One place: the box the reader gave the reference's line and the line's height (fractions of the canvas), on frames
 * from .. to-1 of its shot, counted from the shot's first frame.
 */
export interface WordPlace { box: Box; size: number; from: number; to: number }

/** Places a shot keeps at most: a shot with more large lines is a page of text, which a scene draws. */
export const MAX_PLACES = 6;
/** The font size of a line as a share of the height of the reader's box, as for captions (text/look.ts). */
const FONT_OF_BOX = 0.92;
/** How far new words may reach towards the canvas' sides, a fraction of its width. */
const MARGIN = 0.04;

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/** Up to 4 decimals: a box's height rounded up, so that the line it was made for still fits in it. */
const up4 = (v: number): number => Math.ceil(v * 1e4 - 1e-6) / 1e4;
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * The reference's titles by shot, with what they said: each in the shot that shows most of it (by more than half a
 * reading step, describe/kind.ts shownIn), in the order they appear, the higher first.
 */
export const titlePlaces = (m: Pick<Measure, 'shots'>, text: TextTrack | undefined): { place: WordPlace; text: string }[][] => {
  const out = m.shots.map((): { place: WordPlace; text: string }[] => []);
  // A bar's words stay through the video: they are the bar's places (barPlaces), not a shot's.
  for (const c of (text?.cues ?? []).filter((x) => x.role === 'title' && !x.bar)) {
    let best = -1;
    m.shots.forEach((s, k) => {
      if (shownIn(c, s, text?.step ?? 0) && (best < 0 || overlap(c, s) > overlap(c, m.shots[best] as typeof s))) best = k;
    });
    const s = m.shots[best];
    if (!s) continue;
    out[best]?.push({ place: { box: c.box, size: c.size, from: Math.max(0, c.start - s.start), to: Math.min(s.end, c.end) - s.start }, text: c.text });
  }
  return out.map((xs) => xs.sort((a, b) => a.place.from - b.place.from || a.place.box[1] - b.place.box[1]).slice(0, MAX_PLACES));
};

/**
 * The box new words are set in and their alignment: the reference's line height (one line, with room) around its
 * centre, as wide as the canvas allows on the side the reference's line keeps to. A line about the middle grows both
 * ways; one on the left keeps its left edge; one on the right its right edge.
 */
export const wordBox = (p: WordPlace): { box: Box; align: 'left' | 'center' | 'right'; size: number } => {
  const [x, y, w, h] = p.box;
  const size = r4(p.size * FONT_OF_BOX), cx = x + w / 2;
  const height = Math.min(1, up4(Math.max(h, size * DEFAULT_LINE_HEIGHT)));
  const top = r4(Math.min(1 - height, Math.max(0, y + h / 2 - height / 2)));
  const align = Math.abs(cx - 0.5) <= 0.1 ? 'center' : cx < 0.5 ? 'left' : 'right';
  if (align === 'center') {
    const half = Math.max(w / 2, Math.min(cx - MARGIN, 1 - MARGIN - cx));
    return { box: [r4(cx - half), top, r4(2 * half), height], align, size };
  }
  if (align === 'left') return { box: [r4(x), top, r4(Math.max(w, 1 - MARGIN - x)), height], align, size };
  return { box: [MARGIN, top, r4(Math.max(w, x + w - MARGIN)), height], align, size };
};

/** The style of a place's words: as legible as an unmeasured caption, at the reference's size, aligned as it was. */
export const wordStyle = (p: WordPlace): TextStyle => {
  const { align, size } = wordBox(p);
  return { ...captionStyle(undefined, {}, size), align };
};

/**
 * The text items of a shot's words, during its segment. time: a frame of the reference's shot, counted from its start,
 * as a frame of the segment; length: the segment's frames. An empty line leaves its place empty.
 */
export const wordTracks = (segment: string, words: readonly string[], places: readonly WordPlace[], time: (frame: number) => number, length: number): Track[] =>
  words.flatMap((raw, j): Track[] => {
    const p = places[j], line = unmark(raw);
    if (!p || !line.text.trim()) return [];
    const from = Math.min(Math.max(0, time(p.from)), length - 1);
    const to = Math.min(length, Math.max(from + 1, time(p.to)));
    const style = wordStyle(p);
    const spans = line.marks.length ? { spans: markSpans(line.marks, highlightColour(undefined, style.color)) } : {};
    return [{ id: segment + '-words-' + (j + 1), type: 'text', text: line.text, box: wordBox(p).box, style: { ...style, ...spans }, during: { segment, from, to } }];
  });

const err = (at: string, message: string, fix: string): Problem => ({ level: 'error', at, message, fix });

/** A shot's "words": a list of lines, no more than its places, and none on a shot that keeps the reference's footage. */
export const wordProblems = (shot: Record<string, unknown>, at: string, places: number): Problem[] => {
  const words = shot.words;
  if (words === undefined) return [];
  if (!Array.isArray(words) || words.some((w) => typeof w !== 'string'))
    return [err(at + '.words', '"words" is a list of lines, one per place the reference laid words on in this shot.', 'Write "words": ["..."].')];
  if ('keep' in shot && words.length) return [err(at + '.words', 'A shot that keeps the reference\'s footage shows the reference\'s own words.', 'Remove "words", or fill the shot with new content.')];
  if (words.length > places)
    return [err(at + '.words', 'This shot has ' + places + ' place' + (places === 1 ? '' : 's') + ' for laid-on words (where the reference set its titles); "words" has ' + words.length + ' lines.', places ? 'Keep ' + places + ' line' + (places === 1 ? '' : 's') + ', or draw the shot as a scene with its own text.' : 'Remove "words", or draw the shot as a scene with its own text.')];
  return [];
};

/**
 * A note naming the places a plan leaves without a line, in shots it fills with footage, a picture or a colour (a card
 * and a scene draw their own text; kept footage shows the reference's). undefined when every place has a line ("" counts).
 */
export const emptyWords = (shots: readonly Record<string, unknown>[], places: readonly WordPlace[][]): string | undefined => {
  const empty = places.flatMap((ps, k) => {
    const s = shots[k];
    if (!s || !ps.length || 'keep' in s || 'scene' in s || 'card' in s) return [];
    const given = Array.isArray(s.words) ? s.words.length : 0;
    return given < ps.length ? ['shots[' + k + '].words (' + (ps.length - given) + ' of ' + ps.length + ')'] : [];
  });
  if (!empty.length) return undefined;
  return 'The reference laid words over these shots and the plan gives them no line: ' + empty.slice(0, 6).join(', ') + (empty.length > 6 ? ' and ' + (empty.length - 6) + ' more' : '') + '. Give each place its line by position, or "" to leave it empty.';
};

/** The reference's bar (text/bar.ts; the highest when there are several): its words' places from the left, and the word each shot marks (-1: none). */
export interface BarPlaces { places: { box: Box; size: number }[]; marked: number[] }

/** The bar of a reference with what its words said, or undefined when it has none. */
export const barPlaces = (m: Pick<Measure, 'shots'>, text: TextTrack | undefined): (BarPlaces & { texts: string[] }) | undefined => {
  const bar = barsOf(text?.cues ?? [], m.shots)[0];
  return bar ? { places: bar.words.map((w) => ({ box: w.box, size: w.size })), marked: bar.marked, texts: bar.words.map((w) => w.text) } : undefined;
};

/** The box of bar word j: the room up to halfway to its neighbours (as much on its other side at the ends), at its line's height. */
export const barBox = (places: BarPlaces['places'], j: number): { box: Box; size: number } => {
  const p = places[j] ?? { box: [0, 0, 0, 0] as Box, size: 0 };
  const [x, y, w, h] = p.box;
  const prev = places[j - 1]?.box, next = places[j + 1]?.box;
  const right = next ? (x + w + next[0]) / 2 : undefined, left = prev ? (prev[0] + prev[2] + x) / 2 : undefined;
  const lo = Math.max(MARGIN, left ?? x - ((right ?? x + w) - (x + w))), hi = Math.min(1 - MARGIN, right ?? x + w + (x - (left ?? x)));
  const size = r4(p.size * FONT_OF_BOX);
  const height = Math.min(1, up4(Math.max(h, size * DEFAULT_LINE_HEIGHT)));
  return { box: [r4(Math.min(lo, x)), r4(Math.min(1 - height, Math.max(0, y + h / 2 - height / 2))), r4(Math.max(w, hi - Math.min(lo, x))), height], size };
};

/** The marked word of a shot: dark letters on a plate of a colour that stands out (the reference's colours are not measured). */
const MARKED_STYLE = { weight: 800, color: '#111111', align: 'center' as const, background: { color: '#ffd84a', padding: 0.25, radius: 0.3 } };

/**
 * The items of a bar: each word through the whole video ("bar-1" from the left), and over it, in each shot that marks
 * it, the word marked. segments: the project's, in order; total: the video's frames.
 */
export const barTracks = (bar: BarPlaces, words: readonly string[], segments: readonly { id: string }[], total: number): Track[] =>
  words.flatMap((raw, j): Track[] => {
    const text = raw.trim();
    if (!text || !bar.places[j]) return [];
    const { box, size } = barBox(bar.places, j);
    const first = segments[0]?.id ?? 'shot-01';
    const plain: Track = { id: 'bar-' + (j + 1), type: 'text', text, box, style: { ...captionStyle(undefined, {}, size), align: 'center' }, during: { segment: first, from: 0, to: total } };
    const lit = segments.flatMap((s, k): Track[] => (bar.marked[k] === j ? [{ id: 'bar-' + (j + 1) + '-' + s.id, type: 'text', text, box, style: { size, ...MARKED_STYLE }, during: { segment: s.id } }] : []));
    return [plain, ...lit];
  });

/** A plan's "bar": a list of words, no more than the reference's bar has, and only when it has one. */
export const barProblems = (bar: unknown, places: number): Problem[] => {
  if (bar === undefined) return [];
  if (!Array.isArray(bar) || bar.some((w) => typeof w !== 'string')) return [err('bar', '"bar" is a list of words, one per word of the reference\'s bar, from the left.', 'Write "bar": ["...", "..."].')];
  if (!places) return [err('bar', 'The reference has no bar of words to re-make.', 'Remove "bar"; draw such words in a scene.')];
  if (bar.length > places) return [err('bar', 'The reference\'s bar has ' + places + ' words; "bar" has ' + bar.length + '.', 'Give ' + places + ' words, from the left.')];
  return [];
};

/** A note when the reference has a bar and the plan gives it no words. */
export const barNote = (bar: (BarPlaces & { texts: string[] }) | undefined, given: unknown): string | undefined =>
  bar && given === undefined
    ? 'The reference has a bar of ' + bar.places.length + ' words laid on through the video (' + bar.texts.map((t) => '"' + t + '"').join(' ') + '): give "bar": [' + bar.places.length + ' words, from the left] to re-make it; the word each shot marks follows the reference.'
    : undefined;
