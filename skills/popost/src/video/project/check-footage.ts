/**
 * Checks of video footage: in / speed / audio only on a video material, and, with what the build step read from the
 * file (CheckContext.footage), "in" inside the source, the source running out before the use ends, and a gain set on
 * a file that has no sound.
 */
import type { FootageFacts, FootageSpec, Problem } from '../types';
import { error, warning, type CheckContext } from './check-common';

const FOOTAGE_KEYS = ['in', 'speed', 'audio'] as const;

/** Frames start .. end-1 on which a use (a segment's base or a video item) plays, i = 0 at start. */
export interface PlaySpan { start: number; end: number }

const factsOf = (ctx: CheckContext, id: string): FootageFacts | undefined => {
  const f = ctx.footage[id];
  return f && !('error' in f) ? f : undefined;
};

/** The first frame of the span on which the mapping passes the source's last frame (it holds from there), or undefined. */
const runsOutAt = (ctx: CheckContext, spec: FootageSpec, f: FootageFacts, span: PlaySpan): number | undefined => {
  const last = f.frames - 1;
  const raw = (n: number): number => (spec.in ?? 0) + Math.round(((n - span.start) * f.fps * (spec.speed ?? 1)) / ctx.fps);
  if (span.end <= span.start || raw(span.end - 1) <= last) return undefined;
  let n = span.start;
  while (raw(n) <= last) n++;
  return n;
};

const sourceText = (file: string | undefined, f: FootageFacts): string =>
  '"' + (file ?? '?') + '" has ' + f.frames + ' frames (' + (f.frames / f.fps).toFixed(2) + ' s at ' + Number(f.fps.toFixed(3)) + ' fps)';

const soundProblems = (spec: FootageSpec, f: FootageFacts, id: string, at: string): Problem[] => {
  // Left out, the sound is automatic (FootageSpec.audio): a file without sound is then simply silent.
  if (spec.audio === undefined || spec.audio === false) return [];
  if (!f.hasAudio) return [warning(at + '.audio', 'Material "' + id + '" has no sound track, so "audio" has no effect.', 'Remove "audio", or use a file with sound.')];
  return [];
};

/** A bed whose clip has no audio stream (made without sound) plays nothing: a warning, the mix treats it as silence. */
export const silentBedProblems = (ctx: CheckContext, id: string, at: string, track: string): Problem[] =>
  factsOf(ctx, id)?.hasAudio === false
    ? [warning(at, 'The bed "' + track + '" plays the sound of "' + id + '", which has no sound track (a clip made without sound), so it adds nothing to the mix.', 'Remove the bed, or use a clip with sound.')]
    : [];

/** Footage slower than this plays visibly slowed down. */
export const SLOWED = 0.9;

/** A use slowed down: its motion is slower than the footage's own, which a shot that should move as its reference does not want. */
export const slowProblems = (spec: Pick<FootageSpec, 'speed'>, at: string, what: string): Problem[] =>
  typeof spec.speed === 'number' && spec.speed < SLOWED
    ? [warning(at + '.speed', what + ' plays at ' + spec.speed + ' of its speed: everything in it moves slower than it was made, and a clip slowed down to fill a shot looks slowed down.',
      'Set "speed" to 1 or more and give the shot enough footage (a longer clip, a second clip, an earlier "in"); keep a lower speed only when the reference shot itself is in slow motion.')]
    : [];

/** in / speed / audio of one use of material id at the JSON path at. what names the use for messages. */
export const checkPlay = (ctx: CheckContext, spec: FootageSpec, id: string, at: string, what: string, span: PlaySpan | undefined): Problem[] => {
  const m = ctx.materials.get(id);
  if (!m) return [];
  if (m.kind !== 'video')
    return FOOTAGE_KEYS.filter((k) => spec[k] !== undefined).map((k) =>
      error(at + '.' + k, '"' + k + '" applies to a video material, but "' + id + '" is ' + (m.kind === 'image' ? 'an image' : 'a ' + m.kind) + ' material.', 'Remove "' + k + '", or use a video material.'));
  const f = factsOf(ctx, id);
  if (!f) return slowProblems(spec, at, what);
  const sound = [...slowProblems(spec, at, what), ...soundProblems(spec, f, id, at)];
  if ((spec.in ?? 0) > f.frames - 1)
    return [error(at + '.in', what + ' starts at source frame ' + spec.in + ', but ' + sourceText(m.file, f) + '.', 'Set "in" to at most ' + (f.frames - 1) + ' (frames are counted from 0 at the source\'s own rate).'), ...sound];
  const out = span ? runsOutAt(ctx, spec, f, span) : undefined;
  if (out === undefined || !span) return sound;
  return [
    warning(at, what + ' runs out of footage: ' + sourceText(m.file, f) + ', so from project frame ' + out + ' to its end (frame ' + (span.end - 1) + ') its last frame holds.',
      'Make it at most ' + (out - span.start) + ' frames long, lower "in", raise "speed", or keep the held frame on purpose.'),
    ...sound,
  ];
};

/** One error per video material whose file the build step could not read as a video. */
export const checkFootageFiles = (ctx: CheckContext): Problem[] =>
  ctx.project.materials.flatMap((m, i) => {
    const f = ctx.footage[m.id];
    return m.kind === 'video' && f && 'error' in f
      ? [error('materials[' + i + '].file', 'The file "' + (m.file ?? '') + '" of material "' + m.id + '" is not a video this engine can read (' + f.error + ').', 'Use an MP4, MOV or WebM file, for example converted with: ffmpeg -i input -c:v libx264 -pix_fmt yuv420p out.mp4.')]
      : [];
  });
