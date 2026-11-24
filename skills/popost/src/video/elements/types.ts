/**
 * elements.json: what a model read from describe's frame pictures, shot by shot. Programs measure when and where (cuts,
 * spans, text boxes, colours); they cannot say what a thing is or how it looks. So a model that looks at the pictures
 * writes, for every measured shot, its layers (each with a box, a look precise enough to redraw it, what it shows and
 * its role), the change into it, its captions, its marks and why each is there. `popost video elements check` holds
 * the file to the measurement, `template save` carries it into the template, and the checks of a fill and a project
 * use it. Nothing here names a kind of video: a screen, a product or a platform is one kind of layer among others.
 */
import type { Box, KnownAs, TransitionKind } from '../types';

/** The file, in the directory describe wrote. */
export const ELEMENTS_FILE = 'elements.json';

/** What a layer is. */
export const LAYER_KINDS = ['ground', 'frame', 'screen', 'footage', 'picture', 'person', 'product', 'caption', 'title', 'sticker', 'highlight', 'pointer', 'object', 'platform', 'other'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/**
 * What a re-make does with a layer. design: keeps its look. content: shows the new subject in its place. platform: the
 * watermark, the account, the platform's own pages and buttons; creator: the original author's face, name or avatar.
 * Neither of the last two is ever re-made.
 */
export const ROLES = ['design', 'content', 'platform', 'creator'] as const;
export type LayerRole = (typeof ROLES)[number];
export type DroppedRole = Extract<LayerRole, 'platform' | 'creator'>;
export const isDropped = (role: LayerRole): role is DroppedRole => role === 'platform' || role === 'creator';

/** The kinds of mark a shot puts on something. */
export const MARKS = ['box', 'zoom', 'pointer', 'circle', 'underline', 'arrow', 'other'] as const;
export type MarkKind = (typeof MARKS)[number];

/** The change into a shot as the reader saw it: one of the engine's kinds, or "custom" for an effect of its own. */
export type ReadKind = TransitionKind | 'custom';

/**
 * How the fields of an entry are known, by field name: "measured" (copied from the reading: shots/NN.md, timeline.md),
 * "inferred" (seen in the frames by the model that wrote the entry) or "unknown" (could not be told; the value is a
 * guess or is left out). With a note when it needs one: { "status": "inferred", "note": "why it differs from the
 * measured value" }. A field without a label is unlabelled, as in every file written before labels existed.
 */
export type FieldLabel = KnownAs | { status: KnownAs; note?: string };
export type FieldStatus = Record<string, FieldLabel>;
export const labelOf = (s: FieldStatus | undefined, field: string): { status?: KnownAs; note?: string } => {
  const v = s?.[field];
  return v === undefined ? {} : typeof v === 'string' ? { status: v } : { status: v.status, ...(v.note ? { note: v.note } : {}) };
};
/** The fields of each object that may be labelled, and those of them the reading measures (the others are never "measured"). */
export const STATUS_FIELDS = {
  shot: ['time', 'job', 'layout', 'captions', 'emphasis'],
  layer: ['box', 'look', 'content', 'enters', 'moves', 'leaves'],
  transition: ['kind', 'seconds', 'description'],
} as const;
export const MEASURABLE: readonly string[] = ['time', 'captions', 'box', 'look', 'enters', 'moves', 'leaves', 'kind', 'seconds'];

export interface Layer {
  /** Unique in its shot; the template names content places by it. */
  id: string;
  kind: LayerKind;
  /** [x, y, width, height] as shares of the frame. */
  box: Box;
  /** Precise enough to redraw: colours, shape, weight, outline, plate, angle. */
  look: string;
  /** What it shows or says. */
  content?: string;
  role: LayerRole;
  /** How and when (seconds of the video) it enters, moves and leaves. */
  enters?: string;
  moves?: string;
  leaves?: string;
  /** How box, look, content, enters, moves and leaves are known. */
  status?: FieldStatus;
}

export interface ReadTransition {
  kind: ReadKind;
  /** How long it lasts. */
  seconds?: number;
  /** Frame by frame what happens (which object moves, its path, the shape of the edge, what is revealed); for "custom", or a standard kind the measurement doubted, why it is that kind. */
  description?: string;
  /** How kind, seconds and description are known. */
  status?: FieldStatus;
}

/** A mark on something: what kind, on what, and what the line at that moment says that makes it worth marking. */
export interface Mark { what: MarkKind; on: string; why?: string }

export interface ShotReading {
  /** The measured shot, from 1, and its time in seconds as the measurement gives it. */
  shot: number;
  time: [number, number];
  /** What the shot does in the story, in free words (a hook, a proof, a demo, a call to action). */
  job?: string;
  /** The kind of picture in generic words: a full-frame screen recording, a window on a designed ground, a title card, a person to camera. */
  layout: string;
  /** An animation of this shot runs across the boundary into the next one. */
  sameEffectAsNext?: boolean;
  /** The change into the shot; absent on the first. */
  transitionIn?: ReadTransition;
  layers: Layer[];
  /** The captions' style, the style of the words drawn differently and which words ("none" when there are none), and how a line appears (at once, word by word, letter by letter, wipes on). */
  captions?: { base: string; highlight?: string; reveal?: string; /** Visually confirmed caption lines; [] means no captions in this shot. OCR supplies their times. */ lines?: string[] };
  emphasis?: Mark[];
  /** Two or three sentences on how to draw the shot. */
  rebuild?: string;
  /** The whole shot is not re-made (the platform's end card, the author's sign-off), and why; only shots at the end. */
  drop?: string;
  /** How time, job, layout, captions and emphasis are known. */
  status?: FieldStatus;
}

export interface Elements { shots: ShotReading[] }
