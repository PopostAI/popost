/**
 * What a shot most likely is, in the words the documents use, read cautiously from what describe measured: a recording
 * of a page or an app, a designed picture, or filmed or photographic material. Each kind rests on three facts (its
 * text, its ground, its motion); a kind is named only when at least two of its facts hold, no other kind has as many,
 * and no fact of another kind's ground contradicts it. Otherwise nothing is said: a model then reads the pictures,
 * which it does anyway; this line is a hint they confirm or correct.
 */
import { hexToRgb, toLab } from '../measure/colour';
import type { ShotMeasure } from '../types';
import type { TextCue } from '../text/types';

export type ShotKind = 'page' | 'design' | 'filmed';

/** The words the documents use for each kind. */
export const KIND_WORDS: Readonly<Record<ShotKind, string>> = {
  page: 'a recording of a page or an app',
  design: 'a designed picture',
  filmed: 'filmed or photographic material',
};

export interface ShotLooks { kind: ShotKind; facts: string[] }

/** A page shows this many of its own lines of text at least (the "footage with N lines of its own text" of the timeline). */
const MANY_LINES = 8;
/** A designed picture's words: at most this many large lines, the largest at least LARGE of the height. */
const FEW_LINES = 6;
const LARGE = 0.05;
/** A flat ground: its largest colour covers at least this share. A light ground is at least L 85, a dark one at most L 20. */
const FLAT = 0.45;
const SIMPLE = 0.4;
/** A simple ground: its three largest colours cover at least this share (a gradient, a card on a ground). */
const SIMPLE_THREE = 0.8;
/** A textured picture: no colour covers this share, and the six largest together cover less than TEXTURED_ALL. */
const TEXTURED_TOP = 0.25;
const TEXTURED_ALL = 0.7;
/** A scroll: a vertical move of at least this share of the frame a second, twice its sideways move, no zoom to speak of. */
const SCROLL = 0.02;

const pct = (v: number): string => Math.round(v * 100) + '%';
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
/**
 * Whether a cue is on screen in a shot: it overlaps the shot by more than half a reading step. A cue's edges are put
 * half a step out from the frames that read it, so a title that appears at a cut would otherwise reach into the shot
 * before it, and a card's title be listed on the recording before the card. step: the text track's (0: any overlap).
 */
export const shownIn = (c: { start: number; end: number }, s: { start: number; end: number }, step = 0): boolean =>
  Math.min(c.end, s.end) - Math.max(c.start, s.start) > Math.floor(step / 2);
const plural = (n: number, one: string, many: string): string => n + ' ' + (n === 1 ? one : many);

/** The text facts; undefined throughout when the text was not read (cues undefined): nothing is known. */
const textFacts = (s: ShotMeasure, cues: readonly TextCue[] | undefined, step: number): Record<ShotKind, string | undefined> => {
  if (!cues) return { page: undefined, design: undefined, filmed: undefined };
  const mine = cues.filter((c) => shownIn(c, s, step));
  // Captions and a watermark are laid on in the edit: they say nothing about what the shot itself is.
  const own = mine.filter((c) => c.role === 'in-picture');
  const laid = mine.filter((c) => c.role === 'title' || c.role === 'label');
  const largest = Math.max(0, ...laid.map((c) => c.size));
  return {
    page: own.length >= MANY_LINES ? plural(own.length, 'small line', 'small lines') + ' of text, median height ' + pct(median(own.map((c) => c.size))) : undefined,
    design: laid.length >= 1 && laid.length <= FEW_LINES && largest >= LARGE && own.length < MANY_LINES ? plural(laid.length, 'large line', 'large lines') + ' of text, up to ' + pct(largest) + ' of the height' : undefined,
    filmed: own.length + laid.length <= 2 && largest < LARGE ? 'little text (' + plural(own.length + laid.length, 'line', 'lines') + ')' : undefined,
  };
};

const groundFacts = (s: ShotMeasure): Record<ShotKind, string | undefined> => {
  const top = s.palette[0];
  if (!top || !s.background) return { page: undefined, design: undefined, filmed: undefined };
  const light = toLab(hexToRgb(top.hex))[0];
  const three = s.palette.slice(0, 3).reduce((n, p) => n + p.share, 0);
  const all = s.palette.reduce((n, p) => n + p.share, 0);
  const flat = top.share >= FLAT && (light >= 85 || light <= 20);
  return {
    page: flat ? 'a flat ' + (light >= 85 ? 'light' : 'dark') + ' ground, ' + top.hex + ' over ' + pct(top.share) : undefined,
    design: top.share >= SIMPLE ? 'a flat ground, ' + top.hex + ' over ' + pct(top.share) : three >= SIMPLE_THREE ? 'a simple ground, three colours over ' + pct(three) : undefined,
    filmed: top.share < TEXTURED_TOP && all < TEXTURED_ALL ? 'a textured picture, no colour over ' + pct(top.share) : undefined,
  };
};

const motionFacts = (s: ShotMeasure): Record<ShotKind, string | undefined> => {
  const c = s.camera;
  const [px, py] = c.panPerS;
  const scroll = c.kind === 'move' && Math.abs(py) >= SCROLL && Math.abs(py) >= 2 * Math.abs(px) && Math.abs(c.zoomPerS) < 0.01;
  const moving = c.kind === 'unsteady' || (c.kind === 'move' && !scroll && (Math.abs(c.zoomPerS) >= 0.005 || Math.hypot(px, py) >= 0.005));
  // In a shot that scrolls, what appears at its top or bottom edge is the page scrolling in, not an element entering.
  const atEdge = (b: readonly number[]): boolean => (b[1] ?? 0) <= 0.02 || (b[1] ?? 0) + (b[3] ?? 0) >= 0.98;
  const enter = s.events.filter((e) => e.kind === 'appear' && !(scroll && atEdge(e.box))).length;
  const how = c.kind === 'unsteady' ? 'the camera is unsteady'
    : Math.abs(c.zoomPerS) >= 0.005 ? 'the camera ' + (c.zoomPerS > 0 ? 'pushes in ' : 'pulls out ') + (Math.abs(c.zoomPerS) * 100).toFixed(1) + '%/s'
    : 'the camera pans ' + (Math.hypot(px, py) * 100).toFixed(1) + '%/s';
  return {
    page: scroll ? 'the picture moves vertically ' + (Math.abs(py) * 100).toFixed(1) + '%/s, as a scroll does' : undefined,
    design: enter ? plural(enter, 'element enters', 'elements enter') : undefined,
    filmed: moving ? how : undefined,
  };
};

const KINDS: ShotKind[] = ['page', 'design', 'filmed'];

/**
 * What a shot most likely is, with the facts it rests on; undefined when the facts do not say. cues: the text read
 * from the video with its roles (undefined when no text was read: the text facts are then unknown, not absent). step:
 * the track's reading step, so that a cue counts only in the shots it is really in (shownIn).
 */
export const shotLooks = (s: ShotMeasure, cues: readonly TextCue[] | undefined, step = 0): ShotLooks | undefined => {
  const text = textFacts(s, cues, step), ground = groundFacts(s), motion = motionFacts(s);
  const facts = Object.fromEntries(KINDS.map((k) => [k, [text[k], ground[k], motion[k]].filter((f): f is string => f !== undefined)])) as Record<ShotKind, string[]>;
  const ranked = [...KINDS].sort((a, b) => facts[b].length - facts[a].length);
  const best = ranked[0] as ShotKind;
  const runnerUp = facts[ranked[1] as ShotKind].length;
  if (facts[best].length < 2 || runnerUp >= facts[best].length) return undefined;
  // A flat or simple ground and a textured one exclude each other: the other side's ground is a fact against.
  if (best === 'filmed' ? ground.design !== undefined : ground.filmed !== undefined) return undefined;
  return { kind: best, facts: facts[best] };
};

/** The line shots/NN.md and the template's card give: what the shot most likely is, and why. */
export const looksText = (l: ShotLooks): string => KIND_WORDS[l.kind] + ' (' + l.facts.join('; ') + ')';
