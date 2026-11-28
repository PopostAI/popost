/**
 * On-screen text read from a video: what it says, when, where, and what job it does (a caption, a title, a
 * watermark, text that is part of the picture). Reading the characters needs a model, which does not live in this
 * package: a TextReader is the interface, and the implementation is a command the developer or the server provides.
 */
import type { Box } from '../types';
import type { BarInfo } from './bar';

/** One line of text found in one frame. partial: read from a strip of the frame, so its box is less exact than one read from the whole frame. */
export interface TextLine { text: string; confidence: number; box: Box; partial?: boolean }

/** What a reader returns for one sampled frame. frame: the frame number in the source video. */
export interface TextSample { frame: number; lines: TextLine[] }

export const TEXT_ROLES = ['caption', 'title', 'label', 'watermark', 'in-picture'] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

export interface TextCue {
  text: string;
  /** Source frames: on screen on start .. end-1. Exact to about half the sampling step. */
  start: number;
  end: number;
  box: Box;
  /**
   * caption: lines that replace one another in one band, in step with speech. watermark: the same text in the same
   * place through most of the video. title: large text outside the caption band. label: other overlaid text.
   * in-picture: text that belongs to the footage (a web page, a document, a sign), not laid on in the edit.
   */
  role: TextRole;
  /** Height of the line as a fraction of the frame's height. */
  size: number;
  /** How many samples saw it, and the mean confidence of the reader. */
  samples: number;
  confidence: number;
  /** Why it has its role, in a few words, so that a wrong role can be understood from the file. Absent in files written before roles had reasons. */
  why?: string;
  /**
   * With a transcript: the share of the line's words that were heard while it was on screen (0..1; see src/text/speech.ts).
   * Absent when nothing was said around it or there was no transcript.
   */
  said?: number;
  /** One word of a bar (bar.ts): words side by side that stay on screen together, laid on in the edit, not a watermark. */
  bar?: BarInfo;
}

/**
 * What is behind a caption's letters, measured on the frames of its caption lines (look.ts): a filled plate, an
 * outline, a shadow, or plain letters. Colours are CSS hex; padding and radius are fractions of the font size, as a
 * TextStyle's background takes them.
 */
export interface CaptionLook {
  kind: 'plate' | 'outline' | 'shadow' | 'plain';
  /** The colour that fills the letters' strokes (inside an outline, not the outline). Absent when it could not be told (see unsure). */
  color?: string;
  /**
   * 0..1 for each part: how sure its colour is (the share of lines it was found on, times how alike it was on them).
   * A part's colour is given only from 0.6 up. Absent in files written before it was measured.
   */
  confidence?: number;
  /** opacity: 1 when the plate hides the picture behind it (or when that could not be told: see unsure). */
  plate?: { color: string; opacity: number; padding: number; radius: number; confidence?: number };
  /** Without a colour: there is an outline (or a shadow), but its colour could not be told. */
  outline?: { color?: string; confidence?: number };
  /** With kind 'outline' too: a shadow under outlined letters (darker below or to the right of the outline on every line). */
  shadow?: { color?: string; confidence?: number };
  /**
   * How thick the strokes are: heavy (bold or heavier) or regular, and the stroke's width as a share of the line's
   * box height (text/core.ts). Absent when it could not be measured (a plate, too few strokes).
   */
  weight?: 'heavy' | 'regular';
  stroke?: number;
  /** How a line comes on screen: whole at once, or built up word by word or character by character (text/reveal.ts). */
  reveal?: CaptionReveal;
  /** A second fill colour on a word or two of some lines: a highlighted keyword. */
  highlight?: CaptionHighlight;
  /** How many caption lines it was measured on. */
  samples: number;
  /** What could not be told, and what was taken instead. */
  unsure?: string[];
}

/** Words of a caption line filled with another colour than the rest (look.ts, highlight.ts). */
export interface CaptionHighlight {
  /** Absent when it could not be told (confidence under 0.6). */
  color?: string;
  confidence: number;
  /** How many of the measured lines had highlighted words. */
  lines: number;
  /** lines / the lines measured: 0.25 is about one line in four. Absent in files written before it was recorded. */
  share?: number;
  /** Those lines as the reader read them, the highlighted words wrapped in asterisks the way a fill marks them. */
  examples?: string[];
}

/**
 * How caption lines come on screen, from the frames around the start of each measured line: 'whole' (the whole line
 * within a frame or two, a fade or a pop included), 'words' (it builds in steps of a word or more) or 'chars' (in
 * steps of about a character).
 */
export interface CaptionReveal {
  kind: 'whole' | 'words' | 'chars';
  /** The lines that came on this way, of the lines whose start could be seen. */
  lines: number;
  of: number;
  /** lines / of. The kind is given only from 0.6 up. */
  confidence: number;
  /** For 'words' and 'chars': the median time a line takes to be complete, in seconds. */
  seconds?: number;
}

export interface TextTrack {
  /** Sampling step in frames. */
  step: number;
  /** How many frames were read. */
  sampled: number;
  cues: TextCue[];
  /** What is behind the caption lines' letters; absent when there are too few captions or it was not measured. */
  captionLook?: CaptionLook;
}

/** Reads the text of frames. files: one picture per sampled frame. */
export interface TextReader {
  read(frames: { frame: number; file: string }[]): Promise<TextSample[]>;
}
