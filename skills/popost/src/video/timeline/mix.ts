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
/**
 * One music source at a time (video-sound.md, R2 and R4): while a clip that brings music of its own is heard (an
 * exhibit, or a clip made with music on a recorded basis) the video's music track gives way altogether, over a ramp
 * long enough to be heard as a fade and not as a cut.
 */
export const GIVE_WAY_DB = 60;
export const GIVE_WAY_RAMP_SECONDS = 0.5;
/**
 * A sound effect under a voice comes down a little, not away: it marks what is seen while the words stay clear. An
 * effect that is the lead of its moment (a cue marked "lead") keeps its level.
 */
export const SFX_DUCK_DB = 6;

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

/** 0..1: how far into a lowering a frame is: 1 inside a span, linear on the ramp before and after it. */
const depthAt = (spans: readonly Span[], ramp: number, frame: number): number =>
  spans.reduce((most, [start, end]) => Math.max(most, Math.min(1, Math.max(0, (frame - (start - ramp)) / ramp), Math.max(0, (end + ramp - frame) / ramp))), 0);

/** How far the envelope lowers its sound at a frame, in dB: 0 outside, db inside a span, linear in dB on the ramps; the spans it gives way on are added. */
export const duckAt = (duck: Duck | undefined, frame: number): number => {
  if (!duck) return 0;
  return duck.db * depthAt(duck.spans, duck.ramp, frame) + (duck.away ? duck.away.db * depthAt(duck.away.spans, duck.away.ramp, frame) : 0);
};

/**
 * The envelope of a music track that also gives way on these spans (clips with music of their own); the envelope it
 * had under speech stays. undefined when there is neither.
 */
export const givingWay = (duck: Duck | undefined, spans: readonly Span[], fps: number): Duck | undefined => {
  const ramp = Math.max(1, Math.round(GIVE_WAY_RAMP_SECONDS * fps));
  const joined = joinSpans(spans, 2 * ramp);
  if (!joined.length) return duck;
  return { spans: duck?.spans ?? [], db: duck?.db ?? DUCK_DB, ramp: duck?.ramp ?? Math.max(1, Math.round(DUCK_RAMP_SECONDS * fps)), away: { spans: joined, db: GIVE_WAY_DB, ramp } };
};

/** The frames of the timeline on which a stretch of a clip (seconds of its file) is heard, for a use of the clip; undefined when none is. */
export const heardSpan = (lineSeconds: Span, use: { start: number; end: number; inSeconds: number; speed: number }, fps: number): [number, number] | undefined => {
  const at = (seconds: number): number => use.start + Math.round(((seconds - use.inSeconds) / use.speed) * fps);
  const start = Math.max(use.start, at(lineSeconds[0])), end = Math.min(use.end, at(lineSeconds[1]));
  return end > start ? [start, end] : undefined;
};
