/**
 * The pictures describe writes beside its text, and when a label does not explain them. A label such as "slide cover
 * right 50f" can stand for an effect no standard transition makes (an object that flies across and pulls the next
 * picture in behind a curved edge), and three frames a shot, cut at the boundaries, never show it. So every effect is
 * shown as consecutive frames in one picture: the opening, every shot from just before the change into it to its end,
 * and every change that is not a plain cut frame by frame. A label the frames do not fit is said to be one, and a very
 * short shot that is part of an effect is shown and named with its transition. Pure: look/sheets.ts draws the sheets.
 */
import type { Boundary, Measure, ShotMeasure } from '../types';
import type { SheetSpec } from '../look/sheets';

/** The opening: its first seconds, so many frames a second. */
export const OPENING_SECONDS = 3;
export const OPENING_PER_SECOND = 6;
/** A shot's sheet: at most this many frames, from LEAD_IN seconds before the change into it to its last frame. */
export const SHOT_FRAMES = 12;
export const LEAD_IN = 0.1;
/** A transition's sheet: AROUND seconds either side of its mixed frames; every frame up to EVERY_FRAME, else every second
 *  (or more, so that the sheet holds at most MOST_FRAMES). */
export const AROUND = 0.2;
export const EVERY_FRAME = 16;
export const MOST_FRAMES = 24;

/**
 * A label does not explain the frames when its model leaves a fifth of the change unexplained (the residual of fits.ts;
 * our own and ffmpeg's transitions stay under 0.15, moving content included), a moving edge stands a tenth of the frame
 * apart across its travel (a curved edge, or one a shape leads: a straight one is in one place), or the measurement was
 * unsure. Shaped wipes are read on 48 blocks, whose soft edges leave about a quarter (POOR_REGION); a zoom's scaled blend
 * tries a few scales only (POOR_ZOOM); a switched kind counts the frames no reading explains (POOR_SWITCH).
 */
export const POOR_RESIDUAL = 0.2;
export const POOR_REGION = 0.3;
export const POOR_ZOOM = 0.45;
export const POOR_SWITCH = 0.34;
export const BENT = 0.1;
const SWITCHED = new Set(['spin', 'shake', 'glitch', 'blur']);

const limitOf = (b: Boundary): number =>
  b.kind === 'zoom' ? POOR_ZOOM : SWITCHED.has(b.kind) ? POOR_SWITCH : b.kind === 'wipe' && b.bend === undefined ? POOR_REGION : POOR_RESIDUAL;

/** Whether the label of a transition does not explain its frames (a cut, or a kind without a fit, never). */
export const fitsPoorly = (b: Boundary): boolean =>
  b.kind !== 'cut' && b.residual !== undefined && (b.confidence < 0.4 || b.residual >= limitOf(b) || (b.bend ?? 0) >= BENT);

/** A very short shot: at most this long (seconds). Its ground is flat when its largest colour covers FLAT of it. */
export const SHORT_SHOT = 1;
const FLAT = 0.45;
/** Something moves in a shot when this share of its picture changes between samples a tenth of a second apart, but not all of it. */
const MOVES = 0.005;
const ALL_CHANGES = 0.6;

const changeIn = (m: Measure, lo: number, hi: number): number[] => {
  const { step, change } = m.rhythm;
  return change.filter((_, k) => k * step >= lo && (k + 1) * step <= hi);
};

/** A shot on a flat ground in which an element moves: events were found, or a part of the picture keeps changing. */
const flatWithMotion = (m: Measure, s: ShotMeasure): boolean => {
  const flat = (s.palette[0]?.share ?? 0) >= FLAT || (s.fill !== undefined && s.fill <= 0.35);
  if (!flat) return false;
  if (s.events.length) return true;
  const c = changeIn(m, s.start, s.end);
  return c.length > 0 && Math.max(...c) >= MOVES && Math.max(...c) < ALL_CHANGES;
};

/**
 * Very short shots that belong to the transition after them (shot k to transition k), by index: a shot of at most
 * SHORT_SHOT seconds on a flat ground with a moving element, right before a change that is not a plain cut, is most
 * likely part of one effect that crosses the boundary (a shape that flies in and pulls the next picture behind it),
 * not a designed picture of its own.
 */
export const joinedShots = (m: Measure): Set<number> =>
  new Set(m.shots.flatMap((s, k) => {
    const next = m.boundaries[k];
    if (!next || next.kind === 'cut' || (s.end - s.start) / m.source.fps > SHORT_SHOT) return [];
    return flatWithMotion(m, s) ? [k] : [];
  }));

const two = (n: number): string => String(n).padStart(2, '0');
export const OPENING_FILE = 'opening.jpg';
/** The sheet of shot n (from 1). */
export const shotSheetFile = (n: number): string => 'shots/' + two(n) + '-frames.jpg';
/** The sheet of the transition into shot n (from 1). */
export const transitionFile = (n: number): string => 'transitions/' + two(n) + '.jpg';

/** n frames spread evenly from lo to hi (both kept), or every frame when there are no more than n. */
export const spreadFrames = (lo: number, hi: number, n: number): number[] => {
  if (hi < lo) return [];
  if (hi - lo + 1 <= n) return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return [...new Set(Array.from({ length: n }, (_, i) => lo + Math.round((i * (hi - lo)) / (n - 1))))];
};

/** Every frame from lo to hi; every second past EVERY_FRAME, or as many as keep the sheet at MOST_FRAMES. */
export const transitionFrames = (lo: number, hi: number): number[] => {
  const n = hi - lo + 1;
  if (n <= EVERY_FRAME) return spreadFrames(lo, hi, n);
  const step = Math.max(2, Math.ceil(n / MOST_FRAMES));
  return spreadFrames(lo, hi, Math.ceil(n / step));
};

export interface PictureSheet extends SheetSpec {
  kind: 'opening' | 'shot' | 'transition';
  /** The shot (from 1) the sheet shows, or the one the transition leads into. */
  shot?: number;
  /** A transition's sheet that starts with the very short shot before it (joinedShots): that shot's number. */
  with?: number;
}

/** The sheets describe writes for a measured video: the opening, one per shot, one per change that is not a plain cut. */
export const pictureSheets = (m: Measure): PictureSheet[] => {
  const fps = m.source.fps, last = m.source.frames - 1;
  const marked = m.boundaries.filter((b) => b.kind !== 'cut' && b.end - b.start > 1).map((b) => [b.start + 1, b.end - 1] as const);
  const opening = [...new Set(Array.from({ length: OPENING_SECONDS * OPENING_PER_SECOND }, (_, i) => Math.round((i * fps) / OPENING_PER_SECOND)).filter((f) => f <= last))];
  const sheets: PictureSheet[] = [{ kind: 'opening', file: OPENING_FILE, frames: opening, marked }];
  m.shots.forEach((s, k) => {
    const into = k > 0 ? m.boundaries[k - 1] : undefined;
    const lo = into ? Math.max(0, into.start + 1 - Math.round(LEAD_IN * fps)) : 0;
    sheets.push({ kind: 'shot', shot: k + 1, file: shotSheetFile(k + 1), frames: spreadFrames(lo, Math.min(last, s.end - 1), SHOT_FRAMES), marked });
  });
  const joined = joinedShots(m);
  m.boundaries.forEach((b, k) => {
    if (b.kind === 'cut') return;
    const around = Math.round(AROUND * fps);
    const short = joined.has(k);
    const from = short ? (m.shots[k]?.start ?? b.start + 1) : b.start + 1;
    const frames = transitionFrames(Math.max(0, from - around), Math.min(last, b.end - 1 + around));
    sheets.push({ kind: 'transition', shot: k + 2, file: transitionFile(k + 2), frames, marked, ...(short ? { with: k + 1 } : {}) });
  });
  return sheets;
};
