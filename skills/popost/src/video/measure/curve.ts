/**
 * measureCurve: one element in one region over one range of frames, measured on demand at a larger size than the
 * full pass: when it starts and stops changing, how (scale, slide, fade), its direction, overshoot and easing.
 */
import type { Runtime } from '../../runtime';
import type { Box, Direction, Ease } from '../types';
import { decodeFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { profileCrop } from './profile';
import { clamp } from './pixels';

export interface CurveOptions {
  /** Native frames: the element is at rest on startFrame (before) and on endFrame (after). */
  startFrame: number;
  endFrame: number;
  /** Region to look at, fractions of the frame; it should hold the element's whole path. */
  box: Box;
  /** Decode width; default 360 pixels. */
  width?: number;
}

export interface Curve {
  /** First frame that differs from startFrame, and one past the first frame in the final state (native frames). */
  start: number;
  end: number;
  /** end - start: the length to give a motion preset. */
  frames: number;
  overshoot: number;
  ease: Ease | 'instant';
  direction?: Direction;
  kind: 'scale' | 'slide' | 'fade' | 'unknown';
  /** Progress 0..1 of each frame from start - 1 to end - 1. */
  progress: number[];
}

export const measureCurve = async (rt: Runtime, file: string, opts: CurveOptions): Promise<Curve> => {
  if (!(opts.endFrame > opts.startFrame)) throw new Error('measureCurve: endFrame (' + opts.endFrame + ') must be after startFrame (' + opts.startFrame + '). Pass the frame before the move as startFrame and one after it as endFrame.');
  const p = await probe(rt, file);
  const d = await decodeFrames(rt, file, { width: Math.min(opts.width ?? 360, p.width), gray: false, startFrame: opts.startFrame, frameCount: opts.endFrame - opts.startFrame + 1, probe: p });
  const [bx, by, bw, bh] = opts.box;
  const x0 = clamp(Math.floor(bx * d.width), 0, d.width - 1), y0 = clamp(Math.floor(by * d.height), 0, d.height - 1);
  const x1 = clamp(Math.ceil((bx + bw) * d.width), x0 + 1, d.width), y1 = clamp(Math.ceil((by + bh) * d.height), y0 + 1, d.height);
  const w = x1 - x0, h = y1 - y0;
  const frames = d.frames.map((f) => {
    const out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) out.set(f.subarray(((y0 + y) * d.width + x0) * 3, ((y0 + y) * d.width + x1) * 3), y * w * 3);
    return out;
  });
  const pr = profileCrop({ w, h, frames });
  if (!pr) return { start: opts.startFrame, end: opts.startFrame, frames: 0, overshoot: 0, ease: 'instant', kind: 'unknown', progress: [] };
  const kind = pr.how === 'scale' || pr.how === 'slide' || pr.how === 'fade' ? pr.how : 'unknown';
  return {
    start: opts.startFrame + pr.start, end: opts.startFrame + pr.end, frames: pr.end - pr.start, overshoot: pr.overshoot ?? 0, ease: pr.ease,
    ...(pr.direction ? { direction: pr.direction } : {}), kind, progress: pr.progress.map((v) => Math.round(v * 1000) / 1000),
  };
};
