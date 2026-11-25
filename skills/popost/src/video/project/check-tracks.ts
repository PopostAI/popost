/**
 * Checks of tracks: spans, boxes, entrance and exit lengths, text, look, material references; caption tracks in
 * check-caption.ts.
 */
import type { AudioTrack, Problem, VideoTrack, VisualTrack } from '../types';
import type { SpanFrames } from '../timeline/spans';
import { checkBox, error, materialRef, motionLength, warning, type CheckContext } from './check-common';
import { checkSpan } from './check-span';
import { checkPlay } from './check-footage';
import { checkLook, checkTextStyle } from './check-look';
import { checkCaption } from './check-caption';

export { MIN_TEXT_SIZE } from './check-look';

const checkMotion = (ctx: CheckContext, t: VisualTrack, at: string, frames: SpanFrames | undefined): Problem[] => {
  const out: Problem[] = [];
  for (const phase of ['enter', 'exit'] as const)
    if (t[phase]?.preset === 'type' && t.type !== 'text')
      out.push(error(at + '.' + phase + '.preset', '"type" reveals characters, so it only works on text items; "' + t.id + '" is ' + (t.type === 'image' ? 'an ' : 'a ') + t.type + ' item.', 'Use "fade", "pop", "scale-in", "slide", "wipe" or "blur".', ['none', 'fade', 'pop', 'scale-in', 'slide', 'wipe', 'blur']));
  const enter = motionLength(t.enter, ctx.fps);
  const exit = motionLength(t.exit, ctx.fps);
  const len = frames ? frames.end - frames.start : 0;
  if (frames && len > 0 && enter + exit > len)
    out.push(error(at + (t.enter ? '.enter' : '.exit'), 'The entrance (' + enter + ' frames) and exit (' + exit + ' frames) of "' + t.id + '" together are longer than the item, which is on screen for ' + len + ' frames.', 'Set shorter "frames" on enter or exit (together at most ' + len + '), or lengthen the span.'));
  return out;
};

const checkVideo = (ctx: CheckContext, t: VideoTrack, at: string, frames: SpanFrames | undefined): Problem[] => {
  const ref = materialRef(ctx, t.material, at + '.material', 'video', 'video item "' + t.id + '"');
  return ref.length > 0 ? ref : checkPlay(ctx, t, t.material, at, 'Video item "' + t.id + '"', frames);
};

const checkVisual = (ctx: CheckContext, t: VisualTrack, i: number): Problem[] => {
  const at = 'tracks[' + i + ']';
  const span = checkSpan(ctx, t.during, at + '.during', 'Item "' + t.id + '"');
  const frames = span.problems.some((p) => p.level === 'error') ? undefined : span.frames;
  return [
    ...span.problems,
    ...checkBox(t.box, t.id, at),
    ...checkMotion(ctx, t, at, frames),
    ...(t.type === 'text' ? checkTextStyle(ctx, t.style, t.text, at + '.style', 'Text "' + t.id + '"') : []),
    ...(t.type === 'text' && typeof t.style === 'object' && t.style.spoken
      ? [warning(at + '.style.spoken', '"spoken" has no effect on text item "' + t.id + '": only a caption track that follows the words has a word being spoken.', 'Remove "spoken", or make it a caption track with "words": true.')]
      : []),
    ...checkLook(t, at),
    ...(t.type === 'image' ? materialRef(ctx, t.material, at + '.material', 'image', 'image item "' + t.id + '"') : []),
    ...(t.type === 'video' ? checkVideo(ctx, t, at, frames) : []),
    ...(t.sound !== undefined ? materialRef(ctx, t.sound, at + '.sound', 'audio', 'the sound of "' + t.id + '"') : []),
  ];
};

const audioSpan = (ctx: CheckContext, t: AudioTrack, at: string): Problem[] => {
  if (!t.during) return [];
  if (t.during.phrase !== undefined)
    return [error(at + '.during.phrase', 'Audio "' + t.id + '" is placed by a phrase, but an audio track is placed by frames: phrases are found in the words of audio tracks.', 'Use "segment" and "from", or leave "during" out to play from the start of the video.')];
  return checkSpan(ctx, t.during, at + '.during', 'Audio "' + t.id + '"').problems;
};

const checkAudio = (ctx: CheckContext, t: AudioTrack, i: number): Problem[] => {
  const at = 'tracks[' + i + ']';
  const span = audioSpan(ctx, t, at);
  // A bed plays the sound of a clip: its material is the video material the shots are cut from.
  return [...span, ...materialRef(ctx, t.material, at + '.material', t.bed ? 'video' : 'audio', (t.bed ? 'bed "' : 'audio track "') + t.id + '"')];
};

export const checkTracks = (ctx: CheckContext): Problem[] =>
  ctx.project.tracks.flatMap((t, i) => {
    if (t.type === 'audio') return checkAudio(ctx, t, i);
    if (t.type === 'caption') return checkCaption(ctx, t, i);
    return checkVisual(ctx, t, i);
  });
