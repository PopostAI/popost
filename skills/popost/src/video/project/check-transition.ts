/**
 * Checks of transitions: where one is allowed, its direction, its side and strength, its length against the segments
 * it touches, and two transitions that would need the same frames of one segment.
 */
import type { Problem, Segment, TransitionSpec } from '../types';
import { DIRECTED_TRANSITIONS, ONE_SIDED_TRANSITIONS, transitionFrames, type TransitionName } from '../presets/transition';
import { error, warning, type CheckContext } from './check-common';

const ONE_SIDED_LIST = ONE_SIDED_TRANSITIONS.join(', ');

/** Frames of a segment that the transition into it ('into') or out of it ('out') covers. */
export const framesUsed = (tr: TransitionSpec | undefined, fps: number, role: 'into' | 'out'): number => {
  if (!tr || tr.transition === 'cut') return 0;
  const frames = tr.frames ?? transitionFrames(tr.transition, fps);
  const side = tr.side ?? 'both';
  if (side === 'both') return role === 'into' ? Math.ceil(frames / 2) : Math.floor(frames / 2);
  return (side === 'after') === (role === 'into') ? frames : 0;
};

const sideProblems = (tr: TransitionSpec, at: string): Problem[] => {
  const out: Problem[] = [];
  if (tr.transition === 'cut') {
    for (const key of ['side', 'strength'] as const)
      if (tr[key] !== undefined) out.push(warning(at + '.' + key, 'A cut has no effect, so "' + key + '" does nothing.', 'Remove "' + key + '", or use a kind with an effect, for example "blur".'));
    return out;
  }
  const kind = tr.transition as TransitionName;
  const oneSided = ONE_SIDED_TRANSITIONS.includes(kind);
  if ((tr.side ?? 'both') !== 'both' && !oneSided)
    out.push(error(at + '.side', 'A ' + kind + ' mixes the old and the new picture, so it cannot lie on one side ("' + tr.side + '") of the cut.',
      'Remove "side" to let the ' + kind + ' straddle the boundary, or use a kind that changes one picture: ' + ONE_SIDED_LIST + '.', ['both']));
  if (tr.strength !== undefined && !oneSided)
    out.push(warning(at + '.strength', 'A ' + kind + ' has no amount to scale, so "strength" does nothing.', 'Remove "strength"; it scales ' + ONE_SIDED_LIST + '.'));
  return out;
};

/** The segment(s) whose frames the span takes: both neighbours, or only the one on its side. */
const lengthProblem = (ctx: CheckContext, tr: TransitionSpec, k: number, at: string, id: string): Problem[] => {
  const frames = tr.frames ?? transitionFrames(tr.transition as TransitionName, ctx.fps);
  const side = tr.side ?? 'both';
  const sides = side === 'both' ? [k - 1, k] : side === 'after' ? [k] : [k - 1];
  // Segments without a valid length are reported by checkFrames; they do not take part here.
  const shortest = sides
    .map((j) => ({ id: ctx.project.segments[j]?.id ?? '', len: ctx.tl.lengths[j] ?? 0 }))
    .filter((n) => n.len >= 1)
    .sort((a, b) => a.len - b.len)[0];
  if (!shortest || frames <= shortest.len) return [];
  return [error(tr.frames === undefined ? at : at + '.frames', 'The ' + tr.transition + (side === 'both' ? '' : ' (' + side + ')') + ' into "' + id + '" lasts ' + frames + ' frames' +
    (tr.frames === undefined ? ' (the default at ' + ctx.fps + ' fps)' : '') + ', longer than segment "' + shortest.id + '" (' + shortest.len + ' frames).',
    'Set "frames" in ' + at + ' to at most ' + shortest.len + ', or make the segments longer.')];
};

export const checkTransition = (ctx: CheckContext, s: Segment, k: number): Problem[] => {
  const tr = s.in;
  const at = 'segments[' + k + '].in';
  if (!tr) return [];
  if (k === 0) return [error(at, 'The first segment has a transition ("in"), but no segment comes before it.', 'Remove "in" from segments[0].')];
  if (tr.transition === 'cut') return sideProblems(tr, at);
  const out = sideProblems(tr, at);
  if (DIRECTED_TRANSITIONS.includes(tr.transition) && (tr.direction === 'center-out' || tr.direction === 'edges-in'))
    out.push(error(at + '.direction', '"' + tr.direction + '" is a wipe direction; a ' + tr.transition + ' travels left, right, up or down.', 'Use "left", "right", "up" or "down".', ['left', 'right', 'up', 'down']));
  return [...out, ...lengthProblem(ctx, tr, k, at, s.id)];
};

/** The transition into a segment and the one out of it must not need more frames of it than it has. */
export const checkTransitionOverlaps = (ctx: CheckContext): Problem[] =>
  ctx.project.segments.flatMap((s, j) => {
    const next = ctx.project.segments[j + 1];
    const len = ctx.tl.lengths[j] ?? 0;
    const into = j === 0 ? 0 : framesUsed(s.in, ctx.fps, 'into');
    const out = framesUsed(next?.in, ctx.fps, 'out');
    if (len < 1 || into === 0 || out === 0 || into + out <= len) return [];
    return [error('segments[' + (j + 1) + '].in', 'The transition into "' + s.id + '" covers its first ' + into + ' frames and the one out of it its last ' + out +
      ', but "' + s.id + '" has only ' + len + ' frames, so the two would overlap.',
      'Make "' + s.id + '" at least ' + (into + out) + ' frames long, or shorten one of the two transitions (segments[' + j + '].in or segments[' + (j + 1) + '].in).')];
  });
