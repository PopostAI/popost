/**
 * The frames readback reads (T014). Readback knows from the project when every text is on screen, so it reads each
 * text item where it stands whole, and each shot the same way, clear of the transitions, for the text its scene draws
 * (legibility.ts measures text per shot). A window wants a frame in the first fifth of a second after it settles and
 * one in the last fifth before it leaves, each in its own half: a line read once is dropped unless the reader is very
 * sure of it (text/cues.ts), and captions of 0.4 s read once were lost that way. The fewest frames that give every
 * window what it wants are read (the greedy on the wants' last frames, which is optimal), so items and shots that
 * meet share them; a frame that only starts windows then moves to the first one they all accept. At most
 * MAX_PER_SECOND frames a second of video are read, spread evenly over the chosen ones when that bites. One step for
 * the whole video, set by its shortest item, read 502 frames of a 100 s video with many captions under a second and
 * took 237 s at a CPU budget of 3.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import type { OnStage } from '../progress';
import type { TextReading } from '../text/index';
import type { TextReader } from '../text/types';
import type { Resolved, ResolvedItem } from '../types';

/** At most this many frames a second of video are read. */
export const MAX_PER_SECOND = 2;

/** Frames where a reading of a window counts (inclusive): the text has settled and has not started to leave. */
export interface Window { lo: number; hi: number }
/** Frames l .. r that a window accepts for one of its readings; start: the one after it settles. */
interface Want { l: number; r: number; start: boolean }

/** Steps of the clock, at fps: past an entrance (a tenth of a second); how far a wanted frame may move (a fifth). */
const clock = (fps: number): { past: number; near: number } => ({ past: Math.max(2, Math.round(fps / 10)), near: Math.max(3, Math.round(fps / 5)) });

/**
 * How many frames a reading stands for (text/cues.ts puts a cue's edges half of it out): the margin a reading keeps
 * from where its text stands whole, and a frame, so that a cue covers its item and stops short of the next one.
 */
export const readingSpan = (fps: number): number => 2 * (clock(fps).past + 1);

/**
 * The frames from .. to-1 where a text stands whole, less "past" at each end, less where that would leave fewer than
 * two frames; its middle when it never stands whole (an entrance and an exit that meet).
 */
const settled = (from: number, to: number, past: number): Window => {
  const span = to - 1 - from;
  if (span < 0) { const mid = Math.floor((from + to - 1) / 2); return { lo: mid, hi: mid }; }
  const p = Math.max(0, Math.min(past, Math.floor((span - 1) / 2)));
  return { lo: from + p, hi: to - 1 - p };
};

/** A text item: after its entrance (and its last word, when its words appear as they are said), before its exit. */
const itemWindow = (item: ResolvedItem, past: number): Window => {
  const lastWord = item.reveal === 'words' && item.words?.length ? Math.max(...item.words.map((w) => w.start)) : item.start;
  return settled(Math.max(item.start + item.enter.frames, lastWord), Math.max(item.start + 1, item.end - item.exit.frames), past);
};

/** A shot: after the transition into it, before the transition out of it. */
const shotWindows = (resolved: Resolved, past: number): Window[] =>
  resolved.segments.map((s, k) => {
    const into = s.transition ? s.transition.a + s.transition.frames : s.start;
    const next = resolved.segments[k + 1]?.transition;
    return settled(Math.min(into, s.end - 1), Math.max(Math.min(into, s.end - 1) + 1, next ? next.a : s.end), past);
  });

/** The text items readback checks: text with words in it. */
export const readTextItems = (resolved: Resolved): ResolvedItem[] => resolved.items.filter((i) => i.type === 'text' && (i.text ?? '').trim());

/** The frames to read, in order: per text item and per shot, shared where they can be, at most MAX_PER_SECOND a second. */
export const readbackFrames = (resolved: Resolved, total: number): number[] => {
  const { past, near } = clock(resolved.canvas.fps);
  const clamp = (f: number): number => Math.min(Math.max(0, total - 1), Math.max(0, f));
  const windows = [...readTextItems(resolved).map((i) => itemWindow(i, past)), ...shotWindows(resolved, past)]
    .map((w) => ({ lo: clamp(w.lo), hi: clamp(w.hi) }));
  // A want is the frames it accepts: near the start of its window, or near its end, in different halves of it.
  const wants = windows.flatMap((w): Want[] => {
    const mid = Math.floor((w.lo + w.hi) / 2);
    return w.hi > w.lo ? [{ l: w.lo, r: Math.min(w.lo + near, mid), start: true }, { l: Math.max(w.hi - near, mid + 1), r: w.hi, start: false }] : [{ l: w.lo, r: w.hi, start: false }];
  }).sort((a, b) => a.r - b.r || a.l - b.l);
  const picks: { at: number; served: Want[] }[] = [];
  for (const want of wants) {
    const last = picks[picks.length - 1];
    if (last && last.at >= want.l) last.served.push(want);
    else picks.push({ at: want.r, served: [want] });
  }
  // A frame that only starts windows is read as early as they all allow: right after they settle.
  const frames = [...new Set(picks.map((p) => (p.served.every((w) => w.start) ? Math.max(...p.served.map((w) => w.l)) : p.at)))].sort((a, b) => a - b);
  const cap = Math.max(1, Math.ceil((MAX_PER_SECOND * total) / resolved.canvas.fps));
  if (frames.length <= cap) return frames;
  return Array.from({ length: cap }, (_, k) => frames[Math.floor(((2 * k + 1) * frames.length) / (2 * cap))] as number);
};

/**
 * Reads the given frames of a video whole (one pass of ffmpeg, the longer side at most 1280 px), as text/index.ts
 * reads its samples. step: how many frames a reading stands for, which puts a cue's edges half of it out.
 */
export const readFrames = async (rt: Runtime, video: string, reader: TextReader, frames: readonly number[], o: { step: number; onStage?: OnStage }): Promise<TextReading> => {
  const info = await probe(rt, video);
  const scale = Math.min(1, 1280 / Math.max(info.width, info.height));
  const size = scale < 1 ? ',scale=' + Math.round((info.width * scale) / 2) * 2 + ':-2' : '';
  const wanted = frames.filter((f) => f >= 0 && f < info.frames);
  if (!wanted.length) return { samples: [], step: o.step, total: info.frames, fps: info.fps, whole: 0, strips: 0 };
  return withTempDir(rt, 'popost-video-frames-', async (root) => {
    o.onStage?.('taking ' + wanted.length + ' frames out');
    const select = "select='" + wanted.map((n) => 'eq(n,' + n + ')').join('+') + "'";
    await runFfmpegOk(rt, ['-y', '-i', video, '-vf', select + size, '-fps_mode', 'passthrough', '-q:v', '2', rt.path.join(root, 'r%06d.jpg')]);
    // ffmpeg numbers its output from 1, in the order of the frames.
    const files = (await rt.fs.readdir(root)).filter((f) => f.startsWith('r') && f.endsWith('.jpg')).sort();
    const listed = files.slice(0, wanted.length).map((f, k) => ({ frame: wanted[k] as number, file: rt.path.join(root, f) }));
    o.onStage?.('the reader is reading ' + listed.length + ' frames');
    const samples = (await reader.read(listed)).sort((a, b) => a.frame - b.frame);
    return { samples, step: o.step, total: info.frames, fps: info.fps, whole: samples.length, strips: 0 };
  });
};
