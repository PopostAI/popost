/** The object the page exposes as window.__popostVideo (see README.md in this directory). Types only. */
import type { Box, Resolved } from '../types';

/** What layout() reports for one text item, measured in its own box before rotation and motion. */
export interface LayoutFact {
  id: string;
  /** The text's lines fit inside the item's box, in width and in height. */
  fits: boolean;
  lines: number;
  /** Where the glyphs are drawn, half the stroke included, as fractions of the canvas. */
  ink: Box;
  /** The laid-out lines: the widest line by the height of all lines, as fractions of the canvas. */
  block: Box;
}

/** A side of a box. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * A marked place (data-slot) whose text is not drawn whole: its glyphs leave the box by px CSS pixels at most, on
 * side. ancestor: the element around it that cuts the text off (tag, then id or classes), when its own box holds it.
 */
export interface SceneSpill { slot: string; text: string; side: Side; px: number; ancestor?: string }

/**
 * An element of a scene with text of its own, at the frame applied. Visible: a viewer can see it, which needs the
 * product of the opacities up to the scene's root at least 0.5, no visibility hidden, a box (no display none) at
 * least partly inside the canvas and inside every box around it that hides its overflow, and a scale of at least a
 * third (page/texts.ts).
 */
export interface SceneText {
  /** The element's place among the elements of the scene's body, in document order: the same element in every frame. */
  index: number;
  /** Its whole text, spaces collapsed, at most 80 characters. */
  text: string;
  visible: boolean;
}

/** One scene base, read by scenes() after a frame was applied. */
export interface SceneFact {
  /** The index of the segment whose base it is. */
  segment: number;
  /** The scene's file as the segment names it. */
  src: string;
  /** The size its content needs, in CSS pixels; larger than the canvas means something sticks out. */
  width: number;
  height: number;
  /** Marked places whose glyphs leave their own element's box. */
  overflowing: SceneSpill[];
  /** Marked places whose glyphs fit their own element but are cut off by an element around it that hides its overflow. */
  clipped: SceneSpill[];
  /** Elements the scene has in all; none means an empty page. */
  elements: number;
  /** Every element with text of its own, and whether it can be seen at this frame. */
  texts: SceneText[];
}

/**
 * A file of a scene that did not load, as prepare() reports it: the scene's page itself, or one of its pictures.
 * The renderer turns it into a Problem at the scene's segment (render/session.ts).
 */
export interface SceneFailure {
  /** The index of the segment whose base the scene is. */
  segment: number;
  /** The scene's file as the segment names it. */
  scene: string;
  /**
   * The picture that did not load: its src as the scene (or the segment's slot) wrote it, the address the browser
   * resolved it to (against the scene file), and the slot when the segment's "slots" gave the path. Absent when the
   * scene's page itself did not load.
   */
  picture?: { src: string; url: string; slot?: string };
}

export interface PopostVideoPage {
  /** Total frames, frame rate and canvas size in CSS pixels (before the page's scale). */
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** The viewport is width*scale x height*scale pixels; the stage is scaled to fit it. */
  scale: number;
  /**
   * Resolves when every image is decoded, every declared font (font materials) and every text font is loaded and the
   * pictures of the current frame are ready; rejects naming the image or font that failed, or the video material
   * whose frames were not extracted. When scenes did not load (their page or a picture in them), the Error it rejects
   * with has `failures`: every SceneFailure, of every scene, not only the first.
   */
  prepare(): Promise<void>;
  /** Sets the whole picture to frame n (clamped to 0..frames-1). A pure function of n. */
  applyFrame(n: number): void;
  /**
   * Resolves when every picture the last applyFrame call referenced (video frames) is loaded and decoded, ready to
   * paint; rejects naming a picture that could not be loaded. Await it after applyFrame and before reading the picture.
   */
  settle(): Promise<void>;
  /**
   * After prepare(): for every text item, whether its text fits its box, its lines and the size of its ink. Reads the
   * layout and leaves the picture as it was.
   */
  layout(): LayoutFact[];
  /**
   * Whether the picture differs from the one at the previous call of changed(). It compares the stage's markup:
   * every inline style, text and picture address, which is all a frame sets, so equal markup is an equal picture
   * (after settle()). The first call answers true. The renderer uses it to skip a screenshot.
   */
  changed(): boolean;
  /**
   * Every scene base as it is drawn now (after applyFrame and settle): the room its content needs and the marked places
   * whose text is not drawn whole, and its texts. Only a scene whose segment is on screen is laid out. segment: only
   * the scene of that segment (its index), which is all a check of one shot needs.
   */
  scenes(segment?: number): SceneFact[];
}

/** What compilePage embeds in the page as JSON. */
export interface PageData {
  resolved: Resolved;
  scale: number;
}

declare global {
  interface Window {
    __popostVideo?: PopostVideoPage;
  }
}
