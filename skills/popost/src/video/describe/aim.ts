/**
 * Where a zoom or a pan of a reference shot goes: the part of the picture the camera ends on, as a box of the canvas,
 * so that a capture plan's zoom or a scene's camera can aim at the same part of the frame. Read from the measured
 * camera (measure/camera.ts): a keyframed move (a scale between two values around a focus point) or a steady rate (the
 * scale grows as 1 + zoom x seconds about the centre while the picture travels pan x canvas per second). Cautious:
 * nothing unless the camera clearly moved (a tenth of the frame or more) and was read with confidence.
 */
import type { Box, ShotMeasure } from '../types';

export interface CameraAim {
  /**
   * 'end': a push-in or a pan; box is what the camera ends on, in the canvas of the shot's first frame (a pan's box
   * lies partly outside 0..1: beyond the first frame). 'start': a pull-out; box is what it starts on, in the canvas of
   * its last frame, where it ends showing everything.
   */
  at: 'end' | 'start';
  box: Box;
}

/** The camera must change the scale or move the picture by this much over the shot to count as a clear zoom or pan. */
const CLEAR = 0.08;
const MIN_CONFIDENCE = 0.5;
const C = 0.5;

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;

/** A zoom of r (the scale at the tight end over the wide end) around focus f: the wide view's part the tight view shows. */
const tight = (r: number, f: [number, number]): Box => [r2(f[0] * (1 - 1 / r)), r2(f[1] * (1 - 1 / r)), r2(1 / r), r2(1 / r)];

export const cameraAim = (s: ShotMeasure, fps: number): CameraAim | undefined => {
  const c = s.camera;
  if (c.kind !== 'move' || c.confidence < MIN_CONFIDENCE) return undefined;
  const move = c.moves?.length === 1 ? c.moves[0] : undefined;
  if (c.moves && !move) return undefined;
  if (move) {
    const r = move.scale[1] / move.scale[0];
    if (!(Math.abs(r - 1) >= CLEAR)) return undefined;
    const f = move.focus ?? [C, C];
    return r > 1 ? { at: 'end', box: tight(r, f) } : { at: 'start', box: tight(1 / r, f) };
  }
  // A steady rate over the whole shot: x_end = c + S (x_start - c) + T (camera.ts).
  const seconds = (s.end - s.start) / fps;
  const S = c.zoomPerS >= 0 ? 1 + c.zoomPerS * seconds : 1 / (1 - c.zoomPerS * seconds);
  const T: [number, number] = [c.panPerS[0] * seconds, c.panPerS[1] * seconds];
  if (!(Math.abs(S - 1) >= CLEAR || Math.hypot(T[0], T[1]) >= CLEAR)) return undefined;
  if (S >= 1) return { at: 'end', box: [r2(C - (C + T[0]) / S), r2(C - (C + T[1]) / S), r2(1 / S), r2(1 / S)] };
  return { at: 'start', box: [r2(C - C * S + T[0]), r2(C - C * S + T[1]), r2(S), r2(S)] };
};

/** In words, for shots/NN.md and TEMPLATE.md: "ends on [0.45, 0.18, 0.4, 0.4] of its first frame". */
export const aimText = (a: CameraAim): string =>
  (a.at === 'end' ? 'ends on ' : 'starts on ') + '[' + a.box.join(', ') + '] of its ' + (a.at === 'end' ? 'first' : 'last') + ' frame';
