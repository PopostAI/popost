/**
 * measureVideo: any video file to a Measure (types.ts). Two decodes run side by side: every frame as a small rgb
 * thumbnail (boundaries, rhythm, signature, colour, event timing) and up to 15 frames per second at four times the
 * area (camera, motion events). The same file always gives the same Measure, byte for byte as JSON.
 */
import type { Runtime } from '../../runtime';
import type { OnStage } from '../progress';
import type { Boundary, Measure, MotionEvent, Probe, ShotMeasure } from '../types';
import { heavyJobs } from '../host';
import { probe } from '../media/ffmpeg';
import type { Decoded } from '../media/decode';
import { decodeFrames, readColour, sourceFrames } from '../media/decode';
import type { Thumbs } from './pixels';
import { grayOf, thumbsOf, round } from './pixels';
import { computeSignals } from './signals';
import { detectBoundaries } from './boundaries';
import { cropThumbs, liveBox } from './bars';
import { measureCamera } from './camera';
import { measureColour } from './colour';
import { measureEvents } from './motion';
import { measureAmount } from './amount';
import { measureRhythm } from './rhythm';
import { measureSignature } from './signature';

/** Pixels of the every-frame thumbnail (72 x 128 for a portrait 9:16 video) and of the detail pass (144 x 256). */
export const THUMB_AREA = 9216;
export const DETAIL_AREA = 36864;
/** The detail pass keeps every k-th frame, k = ceil(fps / 15). */
export const DETAIL_FPS = 15;

export interface MeasureOptions {
  /** Measure only the first this many seconds; source then describes the measured part. */
  maxSeconds?: number;
  /** Told what is being done (decoding, the cuts, shot k of n), for a progress line. */
  onStage?: OnStage;
}

/** Lets the event loop run between long stretches of computing: the other parts of a command and its progress timer. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const thumbWidth = (w: number, h: number, area: number): number => Math.max(16, Math.round(Math.sqrt((area * w) / h) / 2) * 2);

/** Frames of shot i's clean interior: after the transition into it ends, before the one out of it starts. */
const interior = (bs: readonly Boundary[], i: number, n: number): [number, number] => {
  const lo = i > 0 ? (bs[i - 1] as Boundary).end : 0;
  const hi = i < bs.length ? (bs[i] as Boundary).start : n - 1;
  const s = i > 0 ? (bs[i - 1] as Boundary).frame : 0, e = i < bs.length ? (bs[i] as Boundary).frame : n;
  return hi >= lo ? [lo, hi] : [s, Math.max(s, e - 1)];
};

/** Frames by which an element event must stay clear of a gradual transition's span: an eased transition keeps moving
 *  the picture for a few frames after the span measured by its change, and those last moves read as small events. */
const TRANSITION_GUARD = 2;

/** Events that do not touch a gradual transition (within TRANSITION_GUARD frames of its span). */
const clearOfTransitions = (events: MotionEvent[], bs: readonly Boundary[]): MotionEvent[] =>
  events.filter((e) => !bs.some((b) => b.kind !== 'cut' && e.start <= b.end + TRANSITION_GUARD && e.end >= b.start - TRANSITION_GUARD));

const spreadFrames = (lo: number, hi: number, k: number): number[] =>
  [...new Set(Array.from({ length: Math.min(k, hi - lo + 1) }, (_, i) => lo + Math.round((i * (hi - lo)) / Math.max(1, Math.min(k, hi - lo + 1) - 1))))];

const shotOf = (t: Thumbs, d2: Decoded, every: number, bs: readonly Boundary[], i: number): ShotMeasure => {
  const n = t.rgb.length;
  const [lo, hi] = interior(bs, i, n);
  const idx: number[] = [];
  for (let j = Math.ceil(lo / every); j * every <= hi && j < d2.frames.length; j++) idx.push(j);
  const rgb2 = idx.map((j) => d2.frames[j] as Uint8Array);
  const start = i > 0 ? (bs[i - 1] as Boundary).frame : 0, end = i < bs.length ? (bs[i] as Boundary).frame : n;
  const camera = measureCamera({ width: d2.width, height: d2.height, gray: rgb2.map(grayOf), times: idx.map((j) => ((j - (idx[0] as number)) * every) / t.fps), frames: idx.map((j) => j * every), seconds: (end - start) / t.fps });
  const colour = measureColour(spreadFrames(lo, hi, 5).map((f) => t.rgb[f] as Uint8Array), t.width, t.height);
  const moving = camera.kind === 'move' || camera.kind === 'unsteady';
  const events = measureEvents({ w: d2.width, h: d2.height, rgb: rgb2, frames: idx.map((j) => j * every), tw: t.width, th: t.height, thumbs: t.rgb, fps: t.fps, moving });
  return {
    index: i, start, end,
    camera, background: colour.background, palette: colour.palette, events: clearOfTransitions(events, bs),
  };
};

export const measureVideo = async (rt: Runtime, file: string, opts: MeasureOptions = {}): Promise<Measure> => {
  const p: Probe = await probe(rt, file);
  const fps = p.fps > 0 ? p.fps : 30;
  const frameCount = opts.maxSeconds !== undefined ? Math.max(1, Math.round(opts.maxSeconds * fps)) : undefined;
  const every = Math.max(1, Math.ceil(fps / DETAIL_FPS));
  // both decodes read the YUV with the source's matrix and range (asked of ffmpeg once)
  const common = { gray: false, probe: p, colour: await readColour(rt, file, p), ...(frameCount !== undefined ? { frameCount } : {}) };
  opts.onStage?.('decoding the frames');
  const thumbs = (): Promise<Decoded> => decodeFrames(rt, file, { ...common, width: thumbWidth(p.width, p.height, THUMB_AREA) });
  const detail = (): Promise<Decoded> => decodeFrames(rt, file, { ...common, width: thumbWidth(p.width, p.height, DETAIL_AREA), every });
  // Two decodes, side by side when the CPU budget has room for two heavy jobs.
  const [d1, d2] = heavyJobs(rt) >= 2 ? await Promise.all([thumbs(), detail()]) : [await thumbs(), await detail()] as const;
  opts.onStage?.('finding the cuts');
  await breathe();
  const t = thumbsOf({ ...d1, fps });
  const n = t.rgb.length;
  // Bars round a picture of other proportions never change: the cuts are judged inside them (bars.ts).
  const live = liveBox(t);
  const judged = live ? cropThumbs(t, live) : t;
  const boundaries = detectBoundaries(judged, computeSignals(judged));
  const shots: ShotMeasure[] = [];
  for (let i = 0; i <= boundaries.length; i++) {
    opts.onStage?.('measuring the shots', i, boundaries.length + 1);
    await breathe();
    shots.push(shotOf(t, d2, every, boundaries, i));
  }
  opts.onStage?.('rhythm and signature');
  await breathe();
  const frames = frameCount !== undefined ? n : Math.max(n, sourceFrames(p) > 0 && p.frames > 0 ? p.frames : n);
  return {
    version: 1,
    source: { width: p.width, height: p.height, fps: round(fps, 4), frames, duration: round(frames / fps, 4), hasAudio: p.hasAudio },
    boundaries, shots,
    rhythm: measureRhythm(t.rgb, fps),
    motion: measureAmount(t.gray, fps),
    signature: measureSignature(t.gray, t.width, t.height),
  };
};

/**
 * The motion amount of a whole clip (amount.ts), from its every-frame thumbnails alone: what a clip that was just made
 * is held against, the amount of the reference shot it is for. No cuts are looked for: a clip is one shot.
 */
export const clipAmount = async (rt: Runtime, file: string): Promise<number | undefined> => {
  const p = await probe(rt, file);
  const fps = p.fps > 0 ? p.fps : 30;
  const d = await decodeFrames(rt, file, { gray: false, probe: p, colour: await readColour(rt, file, p), width: thumbWidth(p.width, p.height, THUMB_AREA) });
  const curve = measureAmount(d.frames.map(grayOf), fps);
  return curve.amount.length ? round(curve.amount.reduce((a, b) => a + b, 0) / curve.amount.length, 2) : undefined;
};

export { detectBoundaries };
