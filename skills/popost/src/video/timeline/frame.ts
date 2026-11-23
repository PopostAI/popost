/**
 * What is on screen at frame n, as pure data: which segment layers are shown and in which state, the camera of each,
 * the overlay, and the state of every item. The page runtime only turns this into CSS, so frame n depends on n alone.
 * DOM-free: shared by the browser page and the tests.
 */
import type { Boundary, Resolved, ResolvedItem, ResolvedTransition } from '../types';
import { IDENTITY_LAYER, transitionState, type LayerState } from '../presets/transition';
import { IDENTITY_ELEMENT, motionState, type ElementState } from '../presets/motion';
import { movesAt, movesPeak, STILL_CAMERA, type CameraState } from '../presets/camera';
import { IDENTITY_LOOP, loopState } from '../presets/loop';

export type { CameraState } from '../presets/camera';

export interface LayerView { index: number; state: LayerState; camera: CameraState }
export interface FrameView { layers: LayerView[]; overlay?: { color: string; opacity: number } }

export const clampFrame = (r: Resolved, n: number): number => Math.min(Math.max(0, r.frames - 1), Math.max(0, Math.floor(n)));

/** True on the F mixed frames a .. a+F-1. */
export const inTransition = (tr: ResolvedTransition, n: number): boolean => n >= tr.a && n < tr.a + tr.frames;

/**
 * Both sides: p = (n - a + 1) / (F + 1), never exactly 0 or 1 on a frame of the span. One side: q of the header,
 * (n - a) / F after the boundary (0 on frame S_k) and (n - a + 1) / F before it (1 on frame S_k - 1).
 */
export const transitionProgress = (tr: ResolvedTransition, n: number): number => {
  const side = tr.side ?? 'both';
  if (side === 'after') return (n - tr.a) / tr.frames;
  if (side === 'before') return (n - tr.a + 1) / tr.frames;
  return (n - tr.a + 1) / (tr.frames + 1);
};

/** First and last frame on which segment k is visible, its transitions included (a one-sided one shows only one side). */
export const visibleRange = (r: Resolved, k: number): [number, number] => {
  const seg = r.segments[k];
  const into = seg?.transition;
  const next = r.segments[k + 1]?.transition;
  if (!seg) return [0, 0];
  const first = into && (into.side ?? 'both') === 'both' ? into.a : seg.start;
  const last = next && (next.side ?? 'both') === 'both' ? next.a + next.frames - 1 : seg.end - 1;
  return [first, last];
};

/**
 * Camera of a picture or video base, a linear function of the frame over the whole visible range (transitions included).
 * zoom >= 0: scale 1 at the first visible frame, growing by zoom per second. zoom < 0: shrinking to 1 at the last.
 * pan: the travel is centred on the middle of the range, and the scale is raised by the largest offset on either
 * axis (times two), so no edge of a covering picture shows. The raise is added, so the zoom rate stays as written.
 */
export const cameraAt = (r: Resolved, k: number, n: number): CameraState => {
  const base = r.segments[k]?.base;
  if (!base || base.kind === 'color' || base.kind === 'scene') return STILL_CAMERA;
  // Keyframed moves count from the segment's start and hold their first and last state on the frames around them.
  if (base.moves) return movesAt(base.moves, n);
  if (base.zoom === 0 && base.pan[0] === 0 && base.pan[1] === 0) return STILL_CAMERA;
  const [v0, v1] = visibleRange(r, k);
  const t = (n - v0) / r.canvas.fps;
  const span = (v1 - v0) / r.canvas.fps;
  const zoom = base.zoom >= 0 ? base.zoom * t : -base.zoom * (span - t);
  const raise = Math.max(Math.abs(base.pan[0]), Math.abs(base.pan[1])) * span;
  return { scale: 1 + zoom + raise, translate: [base.pan[0] * (t - span / 2), base.pan[1] * (t - span / 2)] };
};

/** The largest scale a base's camera reaches over its visible range (how large to extract its footage). */
export const cameraPeak = (r: Resolved, k: number): number => {
  const base = r.segments[k]?.base;
  if (base && base.kind !== 'color' && base.kind !== 'scene' && base.moves) return movesPeak(base.moves);
  const [v0, v1] = visibleRange(r, k);
  return Math.max(cameraAt(r, k, v0).scale, cameraAt(r, k, v1).scale);
};

/** Both layers of a two-sided transition; only the shown one of a one-sided transition (the other is not visible). */
const mix = (r: Resolved, from: number, tr: ResolvedTransition, n: number): FrameView => {
  const s = transitionState(tr, transitionProgress(tr, n), r.canvas);
  const side = tr.side ?? 'both';
  const old = { index: from, state: s.old, camera: cameraAt(r, from, n) };
  const next = { index: from + 1, state: s.next, camera: cameraAt(r, from + 1, n) };
  return {
    layers: side === 'both' ? [old, next] : side === 'after' ? [next] : [old],
    ...(s.overlay ? { overlay: s.overlay } : {}),
  };
};

/** The segment layers shown at frame n (clamped to the video): one, or two during a transition. */
export const segmentsAt = (r: Resolved, frame: number): FrameView => {
  const n = clampFrame(r, frame);
  const k = Math.max(0, r.segments.findIndex((s) => n >= s.start && n < s.end));
  const into = r.segments[k]?.transition;
  if (into && inTransition(into, n)) return mix(r, k - 1, into, n);
  const out = r.segments[k + 1]?.transition;
  if (out && inTransition(out, n)) return mix(r, k, out, n);
  return { layers: [{ index: k, state: IDENTITY_LAYER, camera: cameraAt(r, k, n) }] };
};

/** The entrance or exit state at frame n of an item on screen, or the identity between them. */
const motionAt = (item: ResolvedItem, n: number): ElementState => {
  const i = n - item.start;
  const len = item.end - item.start;
  if (item.enter.frames > 0 && i < item.enter.frames) return motionState(item.enter, 'enter', (i + 1) / item.enter.frames);
  if (item.exit.frames > 0 && i >= len - item.exit.frames) return motionState(item.exit, 'exit', (i - (len - item.exit.frames)) / item.exit.frames);
  return IDENTITY_ELEMENT;
};

/** j of the header: frames since the entrance ended, 0 before, held from the exit's first frame on. */
export const loopFrame = (item: ResolvedItem, n: number): number => {
  const hold = item.start + item.enter.frames;
  const exit = Math.max(hold, item.end - item.exit.frames);
  return Math.min(Math.max(0, n - hold), exit - hold);
};

/**
 * State of an item at frame n, or undefined when it is not on screen (outside start .. end-1). The entrance's
 * progress on its i-th frame (0-based) is (i + 1) / enter.frames, so it is complete on its last frame; the exit's on
 * its j-th frame is j / exit.frames, so the exit mirrors the entrance and the item is gone from frame end on. The
 * item's own opacity and rotation and its loop are composed with that state: opacities and scales multiply, offsets
 * and rotations add.
 */
export const itemStateAt = (item: ResolvedItem, n: number): ElementState | undefined => {
  if (n < item.start || n >= item.end) return undefined;
  const m = motionAt(item, n);
  const l = item.loop ? loopState(item.loop, loopFrame(item, n)) : IDENTITY_LOOP;
  if (l === IDENTITY_LOOP && item.opacity === undefined && item.rotate === undefined) return m;
  return {
    ...m,
    opacity: m.opacity * l.opacity * (item.opacity ?? 1),
    scale: m.scale * l.scale,
    translate: [m.translate[0] + l.translate[0], m.translate[1] + l.translate[1]],
    rotate: m.rotate + l.rotate + (item.rotate ?? 0),
  };
};

/** The boundaries a measurement of this video should find (types.ts Boundary), one per segment after the first. */
export const expectedBoundaries = (r: Resolved): Boundary[] =>
  r.segments.slice(1).map((s): Boundary => {
    const tr = s.transition;
    if (!tr) return { frame: s.start, kind: 'cut', start: s.start - 1, end: s.start, confidence: 1 };
    return {
      frame: s.start,
      kind: tr.kind,
      start: tr.a - 1,
      end: tr.a + tr.frames,
      ...(tr.kind === 'wipe' || tr.kind === 'slide' || tr.kind === 'whip' ? { direction: tr.direction } : {}),
      ...(tr.kind === 'slide' ? { mode: tr.mode } : {}),
      ...(tr.kind === 'fade' ? { via: tr.via } : {}),
      confidence: 1,
    };
  });
