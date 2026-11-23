/**
 * Roles that agree with the speech. With a transcript, being said decides whether a line is a caption: a caption is
 * a line on screen while its words are spoken. The picture-only rules (cues.ts) take a page's own text for captions
 * when it changes in a band (a README scrolling past) and miss real captions on a busy page; the speech tells them
 * apart. Without a transcript, or one with no words, the picture-only rules stay. Pure functions on cues.
 *
 * With speech:
 * - watermark: as the picture-only rules found, and any line with the same words as a watermark (a platform mark that
 *   blinks in and out is never a caption);
 * - caption: a line whose words are heard while it is on screen (saidShare >= SAID), in the band where most such lines
 *   sit, at about their size. A line shown while nothing is said for a second either side (a music intro, an end card)
 *   keeps the picture-only role, if it sits in that band;
 * - everything else keeps the picture-only role; a picture-only caption that is not said becomes a title or a label.
 */
import { alignScript, tokenize } from '../align/index';
import { joinWords } from '../speech/index';
import type { SpokenWord, Transcript } from '../speech/types';
import { editDistance, sameText } from './cues';
import { fold } from './fold';
import type { TextCue, TextRole, TextTrack } from './types';

/**
 * A line is said when at least this share of its words is heard while it is on screen. Measured on 7 development
 * cases (2026-11-20): the 152 lines that end as captions score 0.44 to 1 (91 of them 0.9 or more; a misheard name or a
 * reader's slip costs a little), the 53 other lines in the caption band at most 0.33 (42 of them under 0.1).
 */
export const SAID = 0.4;
/** A line with no word heard within this many seconds of it was shown in silence: the speech says nothing about it. */
const QUIET_SECONDS = 1;
/** Lines smaller than this share of the height, or on screen longer than LONGEST_SECONDS, are never captions (cues.ts). */
const MIN_SIZE = 0.03;
const LONGEST_SECONDS = 12;
/**
 * A caption is at most this many times taller or smaller than the median of the said captions. A reader's box around
 * a caption may be 1.6 times its line (an ascender, a symbol); a said title is 2.5 to 5 times taller.
 */
const SIZE_RATIO = 1.7;
/** A line takes a watermark's role from it only when it has about as many letters (a short mark inside a caption does not). */
const MARK_LENGTH = 0.8;
/** Bands of the height (cues.ts uses the same 25): a caption sits within one band of the busiest. */
const BANDS = 25;

const letters = (s: string): string => fold(s).replace(/[^\p{L}\p{N}]/gu, '');

/** How close a line's letters come to some stretch of what was heard (1: all there). Catches a name heard in pieces. */
const lettersClose = (line: string, heard: string): number => {
  const a = letters(line), b = letters(heard);
  if (a.length < 2 || !b) return 0;
  if (b.includes(a)) return 1;
  let best = editDistance(a, b);
  for (let i = 0; i + a.length <= b.length; i++) best = Math.min(best, editDistance(a, b.slice(i, i + a.length)));
  return Math.max(0, 1 - best / a.length);
};

/**
 * The share of a line's words that were heard: the larger of the aligner's share of tokens heard as written (src/align)
 * and the closeness of its letters to what was heard. Both sides are folded (fold.ts) first.
 */
export const saidShare = (line: string, heard: SpokenWord[]): number => {
  const folded = fold(line);
  if (!heard.length || !tokenize(folded).length) return 0;
  const words = heard.map((w) => ({ ...w, text: fold(w.text) }));
  return Math.round(Math.max(alignScript(folded, words).matchedShare, lettersClose(folded, joinWords(words))) * 100) / 100;
};

interface Seen { c: TextCue; mark: boolean; silent: boolean; said?: number }

const pct = (v: number): string => Math.round(v * 100) + '%';
const centreOf = (c: TextCue): number => c.box[1] + c.box[3] / 2;
const bandOf = (c: TextCue): number => Math.round(centreOf(c) * BANDS);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** A cue with a role and its reason; the share heard only when it was judged. Key order is fixed for byte-identical files. */
const cueWith = (c: TextCue, role: TextRole, why: string | undefined, said?: number): TextCue => ({
  text: c.text, start: c.start, end: c.end, box: c.box, size: c.size, samples: c.samples, confidence: c.confidence, role,
  ...(why ? { why } : {}), ...(said !== undefined ? { said } : {}),
});

/** The band most said lines sit in, and their median height; undefined when no line is said. */
const saidBand = (seen: Seen[]): ((c: TextCue) => boolean) => {
  const said = seen.filter((s) => !s.mark && (s.said ?? 0) >= SAID).map((s) => s.c);
  const texts = new Map<number, Set<string>>();
  for (const c of said) texts.set(bandOf(c), (texts.get(bandOf(c)) ?? new Set<string>()).add(letters(c.text)));
  const around = (b: number): number => [b - 1, b, b + 1].reduce((n, k) => n + (texts.get(k)?.size ?? 0), 0);
  const top = [...texts.keys()].sort((a, b) => around(b) - around(a) || a - b)[0];
  if (top === undefined) return () => false;
  const size = median(said.filter((c) => Math.abs(bandOf(c) - top) <= 1).map((c) => c.size));
  return (c) => Math.abs(bandOf(c) - top) <= 1 && c.size <= SIZE_RATIO * size && c.size * SIZE_RATIO >= size;
};

/** Why a line is not a caption although it might have been one. */
const notCaption = (s: Seen): string => {
  if (s.said === undefined) return 'shown while nothing is said, outside the band of the said captions';
  if (s.said < SAID) return 'not said: ' + pct(s.said) + ' of its words heard';
  return 'said, but not set like the captions (at ' + pct(centreOf(s.c)) + ' of the height, ' + pct(s.c.size) + ' high)';
};

/** The track with roles that agree with the transcript; the same track when there is no speech. Applying it twice changes nothing. */
export const rolesWithSpeech = (track: TextTrack, transcript: Transcript | undefined): TextTrack => {
  const words = transcript?.words ?? [];
  if (!transcript || !words.length) return track;
  const fps = transcript.fps;
  const mids = words.map((w) => (w.start + w.end) / 2);
  const within = (c: TextCue, m: number): SpokenWord[] => words.filter((_w, k) => (mids[k] ?? 0) >= c.start - m && (mids[k] ?? 0) < c.end + m);
  const marks = track.cues.filter((c) => c.role === 'watermark').map((c) => letters(c.text));
  const likeMark = (c: TextCue): boolean => {
    const own = letters(c.text);
    return marks.some((m) => sameText(m, own) && Math.min(m.length, own.length) >= MARK_LENGTH * Math.max(m.length, own.length));
  };
  const seen = track.cues.map((c): Seen => {
    const silent = !within(c, Math.round(QUIET_SECONDS * fps)).length;
    const judged = c.role !== 'watermark' && !silent && c.size >= MIN_SIZE && (c.end - c.start) / fps <= LONGEST_SECONDS;
    // The edges of a cue are exact to about half a sampling step, and a caption may lead or trail its words a little.
    const said = judged ? saidShare(c.text, within(c, Math.max(1, track.step))) : undefined;
    const mark = c.role === 'watermark' || (likeMark(c) && (said ?? 0) < SAID);
    return { c, mark, silent, ...(said !== undefined && !mark ? { said } : {}) };
  });
  const inBand = saidBand(seen);
  const anySaid = seen.some((s) => !s.mark && (s.said ?? 0) >= SAID);
  const cues = seen.map((s): TextCue => {
    const { c } = s;
    if (s.mark) return cueWith(c, 'watermark', c.role === 'watermark' ? c.why : 'the same words as a watermark');
    if ((s.said ?? 0) >= SAID && inBand(c)) return cueWith(c, 'caption', 'said (' + pct(s.said ?? 0) + ' of its words heard), in the caption band at ' + pct(centreOf(c)), s.said);
    if (s.silent && c.role === 'caption' && (!anySaid || inBand(c))) return cueWith(c, 'caption', anySaid ? 'shown while nothing is said, in the band of the said captions' : c.why);
    if (c.role === 'caption') return cueWith(c, c.size >= 0.06 ? 'title' : 'label', notCaption(s), s.said);
    return cueWith(c, c.role, (s.said ?? 0) >= SAID ? notCaption(s) : c.why, s.said);
  });
  return { ...track, cues };
};
