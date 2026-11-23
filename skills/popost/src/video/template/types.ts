/**
 * A template: the structure of a re-created reference, kept so that nobody needs the reference again, and a contract
 * (slots) that says what may change and within which limits. A template is a directory of text files:
 *   template.json   the structure (Template): canvas, shots, transitions, the caption band and its beats
 *   slots.json      the contract (Slots): what fills each shot, how many characters each caption line holds
 *   TEMPLATE.md     one screen for a model with a small context
 *   reference-text.json  the reference's on-screen text by shot (ReferenceTextFile), when a reader read it: the
 *                   reference's content, which template fill copies into the project's record (facts.ts) so that a
 *                   check can tell the reference's words and numbers from the new video's
 *   evidence.json   what the swap tests tried and scored (Evidence)
 * A fill is a RetargetPlan (src/retarget): the same format a retarget takes, so a model learns one format.
 */
import type { CameraAim } from '../describe/aim';
import type { DroppedRole, LayerKind, Mark } from '../elements/types';
import type { Inset } from '../describe/inset';
import type { ShotLooks } from '../describe/kind';
import type { BarPlaces, WordPlace } from '../retarget/titles';
import type { CaptionLook } from '../text/types';
import type { Box, CameraRate, Canvas, Problem, TextStyle, TransitionSpec } from '../types';

export const TEMPLATE_FORMAT = 'popost-video-template';
export const SLOTS_FORMAT = 'popost-video-template-slots';
export const TEMPLATE_VERSION = 1;

/** A card (a title and lines that enter one after another) needs about a second to be read. */
export const CARD_MIN_SECONDS = 1;

/** File names inside a template directory. */
export const FILES = { template: 'template.json', slots: 'slots.json', card: 'TEMPLATE.md', text: 'reference-text.json', evidence: 'evidence.json' } as const;

/** What each shot of the reference shows, one line per shot: written by "template see", read by "plan". */
export const SHOTS_FILE = 'shots.txt';

/** What filled a shot in the source, as far as the measurement tells: footage that keeps changing, a still picture, a flat colour. */
export type SourceKind = 'footage' | 'picture' | 'colour';

/** The kinds of shot fill a template slot can accept ("keep" needs the reference's footage, which a template does not have). */
/** What a fill may put into a shot; a scene (an HTML page of the project that draws the shot) fits every shot. */
export type FillKind = 'footage' | 'picture' | 'color' | 'card' | 'scene';

/** The change into a shot as the reference had it: a TransitionSpec without the keys a measurement does not give. */
export type TemplateTransition = Pick<TransitionSpec, 'transition' | 'frames' | 'direction' | 'mode' | 'via'>;

/** A layer of a shot as the reading of the frames saw it (elements.json): its box, its look, what it showed, how it moved. */
export interface TemplateLayer { id: string; kind: LayerKind; box: Box; look: string; content?: string; enters?: string; moves?: string; leaves?: string }

/** What the reading of the frames (src/video/elements) said of a shot, as the template keeps it. */
export interface TemplateElements {
  /** The kind of picture, in the reader's generic words: a re-make keeps it and finds material of the new subject for it. */
  layout: string;
  job?: string;
  /**
   * full: read as full-frame footage or a recording (a screen or footage layer over most of the frame); designed: a
   * ground or a frame with smaller pictures on it. Absent when the reading says neither clearly.
   */
  frame?: 'full' | 'designed';
  /** Layers whose look a re-make keeps. */
  design: TemplateLayer[];
  /** Places for the new subject, by id: what the reference showed there, which a re-make replaces with its own. */
  content: TemplateLayer[];
  /** The platform's and the author's layers: never re-made. Their words, as the text reader read them, are in reference-text.json. */
  dropped: { id: string; kind: LayerKind; role: DroppedRole; content?: string }[];
  /** The captions' style, and the style of the words drawn differently. */
  captions?: { base: string; highlight?: string; reveal?: string };
  emphasis?: Mark[];
  rebuild?: string;
  /** An animation of this shot runs on across the cut into the next. */
  runsOn?: true;
}

/**
 * The change into a shot when the reading saw an effect no standard transition makes (an object that flies across and
 * pulls the next picture in behind a curved edge). The engine makes a cut there, and a scene draws the effect: the
 * shot's own scene ("this": a fill moves the cut to the effect's start, so the scene begins with it) or the scene of
 * the shot before, whose animation runs on into this one ("before": the cut moves to the effect's end, so that scene
 * runs on over this shot's first frames). Never a preset: what the measurement called it is kept only as "measured".
 */
export interface TemplateEffect {
  transition: 'custom';
  /** Its length on the template's clock: the measured span, or the reading's seconds where the measurement saw a cut. */
  frames: number;
  /** What happens frame by frame, as the reader wrote it. */
  description: string;
  /** The picture of its frames (describe's transitions/NN.jpg), relative to the template directory. */
  picture?: string;
  /** What the measurement labelled it ("slide cover right 25f"). */
  measured: string;
  by: 'this' | 'before';
}

export interface TemplateShot {
  /** Length in frames at canvas.fps. */
  frames: number;
  /**
   * The change into this shot, its frames as measured: a fill gets at most the length of the shorter of the two shots
   * around it (retarget's rule). Absent on the first shot and for a hard cut.
   */
  in?: TemplateTransition;
  /** What filled it in the source (guessed from the measurement). */
  source: SourceKind;
  /** One line about the shot in the source. */
  note: string;
  /** The measured camera of a shot whose camera moved, in CameraRate units. */
  camera?: CameraRate;
  /** Where a clear zoom or pan of the source went (describe/aim.ts): a box of the canvas to aim a capture or a scene camera at. */
  aim?: CameraAim;
  /** What the shot most likely is, with the facts it rests on (describe/kind.ts); absent when the facts do not say. */
  looks?: ShotLooks;
  /** The share of its middle picture that is not ground, 0..1, as describe measured it (ShotMeasure.fill); absent when it did not. */
  fill?: number;
  /**
   * Where the source laid words over the shot (its titles, retarget/titles.ts): the line's box and height as fractions
   * of the canvas, on frames from .. to-1 counted from the shot's start. A fill's shots[k].words[j] is drawn in place j.
   * The words themselves stay in reference-text.json.
   */
  words?: WordPlace[];
  /** What the reading of the frames said of the shot (elements.json), when there was one. */
  elements?: TemplateElements;
  /** The change into the shot is an effect of its own (then "in" is absent: the engine cuts, a scene draws it). */
  effect?: TemplateEffect;
}

/** A shot of the reference the reading dropped whole (the platform's end card): left out, its time in the reference and why. */
export interface DroppedShot { shot: number; seconds: [number, number]; reason: string }

export interface TemplateCaptions {
  /** The band the lines are set in, and their style, exactly as a fill produces them. */
  box: Box;
  style: TextStyle;
  /**
   * Where the source's caption lines sat: the median centre of their boxes and their median height, fractions of the
   * canvas height. The band above is derived from these; a fill derives it again the same way.
   */
  line: { centre: number; size: number };
  /**
   * The beats of the source, in order (src/describe/beats.ts): a fill's captions[i] is the line of beat i, on frames
   * start .. end-1. shown: false marks a beat the source only said (no caption on screen): a fill's line there is
   * spoken and never drawn. Absent means shown, so templates saved before the flag existed load unchanged.
   */
  beats: { start: number; end: number; shown?: false }[];
  /** The script most of the source's caption characters were written in. */
  script: 'cjk' | 'latin';
  /** What was behind the source's caption letters (text/look.ts); style above follows it, and so does a fill's. */
  look?: CaptionLook;
}

export interface Template {
  format: typeof TEMPLATE_FORMAT;
  version: typeof TEMPLATE_VERSION;
  name: string;
  /** Where it came from: a label (never a file name of a private data set) and a content hash of the measurement. */
  source: { label: string; measure: string };
  canvas: Canvas;
  /** Length in frames: the sum of the shots' lengths. */
  frames: number;
  shots: TemplateShot[];
  captions?: TemplateCaptions;
  /** The frame around the content that most of the source's shots showed (describe/inset.ts); absent when none was found. */
  inset?: Inset;
  /**
   * The source's bar (sections laid on through the video, text/bar.ts): its words' places from the left and the word
   * each shot marks (-1: none). A fill's "bar" gives the words. Absent when the source had none.
   */
  bar?: BarPlaces;
  /** Shots of the reference left out because the reading dropped them whole; the last shot here is then the re-make's own closing. */
  dropped?: DroppedShot[];
}

/** How many characters a caption line may have. */
export interface Capacity {
  /** All full-width characters (CJK, kana, hangul, full-width punctuation). */
  cjk: number;
  /** Ordinary Latin text with spaces. */
  latin: number;
  /** Lines the band holds at the style's size and line height. */
  lines: number;
  /** true: measured by laying out probe text in the real band with the real style in Chrome; false: estimated. */
  measured: boolean;
  method: string;
}

export interface ShotSlot {
  /** The fill's JSON path. */
  at: string;
  frames: number;
  seconds: number;
  /** What filled it in the source; the first kind in accepts is the closest to it. */
  source: SourceKind;
  /** The fills it takes, the closest to the source first; "scene" is last and in every shot's list. */
  accepts: FillKind[];
  /**
   * Footage must supply this much from its "in" at speed 1 so that it does not run out: the shot plus the half of the
   * transition out of it that it is still seen in.
   */
  footage: { frames: number; seconds: number };
  /** One per place the source laid words on in the shot (TemplateShot.words), in order. */
  words?: WordSlot[];
}

/** A place for laid-on words: shots[k].words[j]. */
export interface WordSlot {
  at: string;
  /** How long the words are on screen. */
  seconds: number;
  /** Characters one line holds at the source's size, estimated from the box (retarget/titles.ts wordBox). */
  max: { cjk: number; latin: number };
  /** What the source laid there, and its length in characters. */
  example?: { text: string; chars: number };
}

export interface CaptionSlot {
  at: string;
  /** Frames start, end of the beat (end exclusive). */
  beat: [number, number];
  seconds: number;
  max: { cjk: number; latin: number };
  /** The source's own line (a caption's wording, or the recognised words of a beat it only said) and its length in characters. */
  example?: { text: string; chars: number };
  /** false: a beat the source only said; its line is spoken and not drawn. Absent: shown. */
  shown?: false;
  /** true: the reader or the recogniser was not sure of this beat (confidence under 0.6). */
  unsure?: true;
  /** About how many characters the source's speaker said in a beat this long (only with a transcript). */
  spoken?: number;
}

export interface Slots {
  format: typeof SLOTS_FORMAT;
  version: typeof TEMPLATE_VERSION;
  template: string;
  shots: ShotSlot[];
  captions?: { box: Box; size: number; capacity: Capacity; lines: CaptionSlot[] };
  /**
   * A card fill (a title and lines on a ground) as a fill lays it out on this canvas: how many characters its title and
   * each of its lines hold, and how many lines fit on the canvas. Absent when retarget makes no cards.
   */
  card?: { title: Capacity; line: Capacity; lines: number };
  /** The source's bar: a word per place, from the left (fill "bar"), what it said there and about how long a word may be. */
  bar?: { at: 'bar'; words: { max: { cjk: number; latin: number }; example?: { text: string; chars: number } }[]; marked: number[] };
  voice: { optional: true; keys: string[]; note: string; pace?: { charactersPerSecond: number; language: string } };
  colours: { optional: true; keys: string[]; defaults: Record<string, string> };
}

export const TEXT_FORMAT = 'popost-video-template-text';

/** reference-text.json: shots[k] is the text the reference showed in shot k, each line once, in the order it appeared. */
export interface ReferenceTextFile {
  format: typeof TEXT_FORMAT;
  version: typeof TEMPLATE_VERSION;
  shots: string[][];
  /** The words of the platform's and the author's layers (a watermark, an account line), as the text reader read them: a re-make never shows them. */
  dropped?: string[];
}

/**
 * What saveTemplate wrote, as loadTemplate reads it back: with the directory it was read from, and the reference's
 * on-screen text by shot when the template keeps it.
 */
export interface TemplatePackage { template: Template; slots: Slots; dir?: string; text?: string[][]; dropped?: string[] }

export type SwapStage = 'check' | 'fill' | 'project' | 'layout' | 'render' | 'measure' | 'done';

export interface FillEvidence {
  name: string;
  /** What the fill was: the kind of each shot's fill, and the characters of each caption line. */
  tried: { shots: string[]; captions: number[] };
  passed: boolean;
  /** Where the fill stopped; 'done' when every step ran. */
  stage: SwapStage;
  reason: string;
  /** Errors that stopped it (at most five). */
  problems: Problem[];
  /** The structure and transitions dimensions of the render against the template's own structure on the fill's clock. */
  scores?: { structure: number; transitions: number; detail: Record<string, number | string> };
  frames?: number;
  seconds: number;
}

export interface Evidence {
  template: string;
  measure: string;
  /** A fill passes when every check passes and its structure score is at least the best fill's minus this. */
  margin: number;
  scale: number;
  best: number;
  fills: FillEvidence[];
  seconds: number;
}
