/**
 * What the scene check finds by looking at a shot the way a viewer does, from facts the renderer read (check.ts reads
 * them): a text that arrives so late that it is on screen too briefly to be read, a text a short shot never shows, a
 * picture that is nearly all ground (or far emptier than its reference shot), numbers no file of the project holds,
 * the reference's own words and numbers. All are warnings: each names the segment, the scene file, the picture
 * to open and one fix, for the model that wrote the scene. Pure.
 */
import { warning } from '../project/check-common';
import type { SceneText } from '../page/contract';
import type { Repeat } from './copied';
import type { Figure } from './numbers';
import type { Problem } from '../types';

/** A shot as the findings name it: its index and id, its scene file and its length. */
export interface Shot { k: number; id: string; src: string; seconds: number }

/** Below this share of the picture that is not ground, a shot that shows little text is nearly empty. */
export const EMPTY_FILL = 0.02;
/** Fewer visible characters than this (spaces left out) is little text. */
export const FEW_CHARACTERS = 6;

const at = (k: number): string => 'segments[' + k + '].base.scene';
const cut = (text: string): string => (text.length > 40 ? text.slice(0, 39) + '…' : text);
const s2 = (seconds: number): string => seconds.toFixed(2) + ' s';
const quoted = (texts: readonly string[]): string => texts.map((t) => '"' + cut(t) + '"').join(', ');
const where = (shot: Shot): string => 'segment "' + shot.id + '" ("' + shot.src + '")';

/** The texts listed once: one whose text lies inside another listed text (a word inside its line) is left out. */
const outermost = <T extends { text: string }>(texts: readonly T[]): T[] =>
  texts.filter((t, i) => !texts.some((o, j) => j !== i && o.text !== t.text && o.text.includes(t.text)));

/** Seconds a text needs on screen to be read, at least; a shorter stay is fine when it is half the shot or more. */
export const READING = 1.5;

/**
 * The second of a shot by which a text must be visible so that it stays long enough: half the shot or READING
 * seconds, whichever is less. A list whose items arrive with the voice over a long shot is fine as long as the last
 * item stays READING seconds; in a short shot a text must be there by the middle.
 */
export const readBy = (seconds: number): number => Math.max(seconds / 2, seconds - READING);

/**
 * Texts visible in the shot's last frame that were not visible half-way through it (by element): the cheap first
 * filter, since only those can arrive too late (readBy is never before the middle).
 */
export const lateTexts = (half: readonly SceneText[], end: readonly SceneText[]): SceneText[] =>
  end.filter((t) => t.visible && !half.some((h) => h.index === t.index && h.visible));

/** The texts of the list that are not visible in the frame given (by element). */
export const unseenIn = (texts: readonly SceneText[], frame: readonly SceneText[]): SceneText[] =>
  texts.filter((t) => !frame.some((f) => f.index === t.index && f.visible));

/**
 * A warning for texts that were not visible yet at readBy, so that they stay on screen less than half the shot and
 * less than READING seconds. seen: for each, the second of the shot from which it was seen (the first of the frames
 * sampled after readBy that shows it); it stays from then to the end of the shot.
 */
export const lateProblem = (shot: Shot, late: readonly { text: string; seen: number }[], picture: string): Problem | undefined => {
  const listed = outermost(late).slice(0, 3);
  if (!listed.length) return undefined;
  const by = readBy(shot.seconds);
  const parts = listed.map((t) => '"' + cut(t.text) + '" becomes visible only at about ' + s2(t.seen) + ' and stays ' + s2(Math.max(0, shot.seconds - t.seen)));
  const [they, it] = listed.length > 1 ? ['they', 'them'] : ['it', 'it'];
  return warning(at(shot.k), 'In ' + where(shot) + ', a shot of ' + s2(shot.seconds) + ', ' + parts.join(', ') + ': too briefly to read ' + it + ' (less than half the shot and less than ' + READING + ' s). At ' + s2(by) + ' ' + they + ' cannot be seen yet; half-way through: ' + picture + '.',
    'Let ' + it + ' be visible by ' + s2(by) + ' here, so that ' + they + ' stay' + (listed.length > 1 ? '' : 's') + ' ' + (by > shot.seconds / 2 ? READING + ' s' : 'half the shot') + ' or more: start the entrance earlier or make it shorter, and hold its end state (animation-fill-mode both). The shot\'s length follows the reference and the voice, so do not count on a longer one.');
};

/**
 * Texts a shot never shows (neither half-way nor at its end) that the same scene file shows in a longer segment: an
 * entrance timed for the longer shot starts after the shorter one has ended.
 */
export const unseenProblem = (shot: Shot, mine: readonly SceneText[], longer: Shot, theirs: readonly SceneText[], picture: string): Problem | undefined => {
  const shown = theirs.filter((t) => t.visible).map((t) => t.index);
  const missing = outermost(mine.filter((t) => !t.visible && shown.includes(t.index))).slice(0, 3);
  if (!missing.length) return undefined;
  return warning(at(shot.k), 'In ' + where(shot) + ', a shot of ' + s2(shot.seconds) + ', ' + quoted(missing.map((t) => t.text)) + (missing.length > 1 ? ' are' : ' is') + ' never visible (' + picture + '), though segment "' + longer.id + '" (' + s2(longer.seconds) + ') shows ' + (missing.length > 1 ? 'them' : 'it') + ' with the same scene file: the entrance starts after this shorter shot has ended.',
    'Time the entrances for the shortest shot that shows "' + shot.src + '": every text visible by ' + s2(readBy(shot.seconds)) + ', then held. Or give this segment a scene file of its own.');
};

/** Visible characters of the texts, spaces left out (a text inside another is counted with it). */
export const visibleCharacters = (texts: readonly SceneText[]): number =>
  outermost(texts.filter((t) => t.visible)).reduce((n, t) => n + t.text.replace(/\s/g, '').length, 0);

const pct1 = (v: number): string => Math.round(v * 1000) / 10 + '%';

/** How a share of the picture was measured when clips or pictures lie over the scene (items of them): counted whole. */
const counted = (items: number): string =>
  items > 0 ? ' (the ' + (items === 1 ? 'video or image item' : items + ' video and image items') + ' over the scene counted whole)' : '';

/** A warning for a half-way picture that is nearly all ground and shows little text; undefined otherwise. items: the clips and pictures over the scene, counted in fill. */
export const emptyProblem = (shot: Shot, fill: number, characters: number, picture: string, items = 0): Problem | undefined => {
  if (!(fill < EMPTY_FILL) || characters >= FEW_CHARACTERS) return undefined;
  const text = characters === 0 ? 'no text' : 'only ' + characters + ' character' + (characters === 1 ? '' : 's') + ' of text';
  return warning(at(shot.k), 'Half-way through ' + where(shot) + ' the picture is nearly empty: ' + pct1(fill) + ' of it stands out from its ground' + counted(items) + ', and it shows ' + text + ' (' + picture + ').',
    'Draw what the shot is about (the card, the picture, the title, the figure of the reference shot) so that it is visible by the middle of the shot, in colours that stand out from the ground. A ground of gradients and soft blurred shapes alone counts as empty.');
};

/** A scene at most this share of its reference shot's fill ... */
export const EMPTIER = 0.5;
/** ... and at least this much of the picture below it is far emptier than its shot. */
export const EMPTIER_GAP = 0.1;


/**
 * A warning for a half-way picture far emptier than the middle of the reference shot the segment re-creates (the same
 * measure, read by describe from the reference); undefined otherwise. reference.shot counts from 0; items: the clips
 * and pictures over the scene, counted in fill.
 */
export const emptierProblem = (shot: Shot, fill: number, reference: { shot: number; fill: number }, picture: string, items = 0): Problem | undefined => {
  if (!(fill <= reference.fill * EMPTIER && reference.fill - fill >= EMPTIER_GAP)) return undefined;
  return warning(at(shot.k), 'Half-way through ' + where(shot) + ' ' + pct1(fill) + ' of the picture stands out from its ground' + counted(items) + '; in the middle of the reference\'s shot ' + (reference.shot + 1) + ', which it re-creates, ' + pct1(reference.fill) + ' did: the scene is far emptier than its shot (' + picture + ').',
    'Draw what the reference shot holds, as densely: its cards, pictures, text and figures at their sizes, in colours that stand out from the ground, visible by the middle of the shot. A ground of gradients and soft blurred shapes alone counts as empty.');
};

/** The sentence every warning about the reference's content ends with. */
export const REFERENCE_CONTENT = 'this is the reference\'s content; show what the sources of this video say';
const REPEAT_FIX = 'Write what the request and the sources in project/source/ say about this video\'s subject, a figure only from a source. The reference gives the layout and the motion, never the words or the numbers; a name the sources share with it is fine.';

/** What a text repeats, each with the reference's shot (from 1) and its line there. */
const repeatsText = (repeats: readonly Repeat[]): string =>
  repeats.slice(0, 4).map((r) => '"' + cut(r.shown) + '" (the reference\'s shot ' + (r.line.shot + 1) + ': "' + cut(r.line.text) + '")').join(', ');

/** A warning for the reference's words or numbers that a scene shows. */
export const sceneRepeatsProblem = (shot: Shot, repeats: readonly Repeat[], picture: string): Problem | undefined =>
  repeats.length
    ? warning(at(shot.k), where(shot).charAt(0).toUpperCase() + where(shot).slice(1) + ' shows what the reference showed: ' + repeatsText(repeats) + ' (' + picture + '): ' + REFERENCE_CONTENT + '.', REPEAT_FIX)
    : undefined;

/** A warning for the reference's words or numbers that a caption or a text item (noun) shows. */
export const textRepeatsProblem = (place: string, noun: string, text: string, id: string, repeats: readonly Repeat[]): Problem | undefined =>
  repeats.length
    ? warning(place, 'The ' + noun + ' "' + cut(text) + '" (segment "' + id + '") shows what the reference showed: ' + repeatsText(repeats) + ': ' + REFERENCE_CONTENT + '.', REPEAT_FIX)
    : undefined;

const tail = (none: boolean): string =>
  none ? ' The project holds no text file outside scenes/ to look in.' : '';

const NUMBER_FIX = 'If they come from a source, save that text into the project (a .txt or .md file in source/); never show a number you did not read somewhere.';

/** A warning for numbers a scene shows that no file of the project holds. none: the project holds no text file at all. */
export const sceneNumbersProblem = (shot: Shot, figures: readonly Figure[], picture: string, none: boolean): Problem | undefined =>
  figures.length
    ? warning(at(shot.k), 'The numbers shown in ' + where(shot) + ' are found in no file of the project: ' + figures.slice(0, 8).map((f) => f.shown).join(', ') + ' (' + picture + ').' + tail(none), NUMBER_FIX)
    : undefined;

/** A warning for numbers a caption or a text item (noun) shows that no file of the project holds. */
export const textNumbersProblem = (place: string, noun: string, text: string, id: string, figures: readonly Figure[], none: boolean): Problem | undefined =>
  figures.length
    ? warning(place, 'The ' + noun + ' "' + cut(text) + '" (segment "' + id + '") shows numbers found in no file of the project: ' + figures.slice(0, 8).map((f) => f.shown).join(', ') + '.' + tail(none), NUMBER_FIX)
    : undefined;
