/**
 * Segment starts and span arithmetic, shared by check and resolve. All values are integer frames.
 */
import type { Project, Span } from '../types';

export interface Timeline {
  /** S_k: the first frame of segment k. */
  starts: number[];
  lengths: number[];
  /** Length of the video: the sum of the segment lengths. */
  total: number;
  /** Segment id -> index (the first segment with that id). */
  index: ReadonlyMap<string, number>;
}

/** A segment without a valid length counts as 0 frames here; check reports it. */
export const timelineOf = (project: Pick<Project, 'segments'>): Timeline => {
  const lengths = project.segments.map((s) => (Number.isInteger(s.frames) && (s.frames ?? 0) > 0 ? (s.frames ?? 0) : 0));
  const starts = lengths.reduce<number[]>((acc, _len, k) => [...acc, k === 0 ? 0 : (acc[k - 1] ?? 0) + (lengths[k - 1] ?? 0)], []);
  const index = new Map<string, number>();
  project.segments.forEach((s, k) => { if (!index.has(s.id)) index.set(s.id, k); });
  return { starts, lengths, total: lengths.reduce((a, b) => a + b, 0), index };
};

export interface SpanFrames {
  /** Before clamping to the video. */
  rawStart: number;
  rawEnd: number;
  /** Clamped to 0..total; the item is on screen on start .. end-1. */
  start: number;
  end: number;
}

/** Raw frames clamped to the video. */
export const framesOf = (tl: Timeline, rawStart: number, rawEnd: number): SpanFrames => ({ rawStart, rawEnd, start: Math.max(0, rawStart), end: Math.min(tl.total, rawEnd) });

/**
 * Absolute frames of a span placed by a segment; undefined when it has no segment or its segment does not exist. A
 * phrase span is placed on the words (timeline/words.ts placeSpan).
 */
export const spanFrames = (tl: Timeline, span: Span): SpanFrames | undefined => {
  const k = span.segment === undefined ? undefined : tl.index.get(span.segment);
  if (k === undefined) return undefined;
  const s = tl.starts[k] ?? 0;
  return framesOf(tl, s + (span.from ?? 0), s + (span.to ?? tl.lengths[k] ?? 0));
};

/** The whole video, for an audio track without "during". */
export const wholeVideo = (tl: Timeline): SpanFrames => ({ rawStart: 0, rawEnd: tl.total, start: 0, end: tl.total });
