/**
 * The layers of a video's sound and how they give way to one another. Speech is never covered: while a person of a
 * clip speaks (a clip made with speech: its receipt gives the times of its lines) that clip is heard at full level;
 * while the voice-over speaks a line (the voice track's "lines") the other clips' own sound is lowered by DUCK_DB and
 * comes back in the pauses; music lies under everything, lowered the same way while any speech is heard. Every time is
 * known to the program, so a sound is lowered over the spans themselves with short ramps: no level is measured.
 * The render writes the envelope as an ffmpeg volume expression (render/encode.ts), the Studio reads it per frame.
 * Pure.
 */
import type { Duck } from '../types';

/** How far a sound is lowered under speech, in dB, and the seconds its level takes to go down and to come back. */
export const DUCK_DB = 18;
export const DUCK_RAMP_SECONDS = 0.2;

export type Span = readonly [number, number];

/** Spans in order, joined where they touch, overlap or lie closer than gap. */
export const joinSpans = (spans: readonly Span[], gap = 0): [number, number][] => {
  const out: [number, number][] = [];
  for (const [start, end] of [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
};

/** Whether two lists of spans share a frame; the first pair that does. */
export const overlapOf = (a: readonly Span[], b: readonly Span[]): [Span, Span] | undefined => {
  for (const x of a) for (const y of b) if (Math.min(x[1], y[1]) > Math.max(x[0], y[0])) return [x, y];
  return undefined;
};

/**
 * The envelope of a sound that gives way to speech on these spans (timeline frames): lowered through each span, the
 * ramps outside it, so that the sound is already down when the first word comes. Spans whose ramps would meet are one
 * (the level does not come up for a pause shorter than two ramps). undefined without spans.
 */
export const duckOf = (spans: readonly Span[], fps: number, db = DUCK_DB, rampSeconds = DUCK_RAMP_SECONDS): Duck | undefined => {
  const ramp = Math.max(1, Math.round(rampSeconds * fps));
  const joined = joinSpans(spans, 2 * ramp);
  return joined.length ? { spans: joined, db, ramp } : undefined;
};

/** How far the envelope lowers its sound at a frame, in dB: 0 outside, db inside a span, linear in dB on the ramps. */
export const duckAt = (duck: Duck | undefined, frame: number): number => {
  if (!duck) return 0;
  const depth = duck.spans.reduce((most, [start, end]) => Math.max(most, Math.min(1, Math.max(0, (frame - (start - duck.ramp)) / duck.ramp), Math.max(0, (end + duck.ramp - frame) / duck.ramp))), 0);
  return duck.db * depth;
};

/** The frames of the timeline on which a stretch of a clip (seconds of its file) is heard, for a use of the clip; undefined when none is. */
export const heardSpan = (lineSeconds: Span, use: { start: number; end: number; inSeconds: number; speed: number }, fps: number): [number, number] | undefined => {
  const at = (seconds: number): number => use.start + Math.round(((seconds - use.inSeconds) / use.speed) * fps);
  const start = Math.max(use.start, at(lineSeconds[0])), end = Math.min(use.end, at(lineSeconds[1]));
  return end > start ? [start, end] : undefined;
};
