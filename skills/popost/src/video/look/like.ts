/**
 * The pictures describe wrote of a reference (describe/frames.ts), made again of another video at the matching moments:
 * a render put beside its reference sheet by sheet, the same names in another directory. The other video is placed by
 * share of length (its frame n of N against the reference's frame m of M), as look --against places its frames, so a
 * render of the same length is read at the same frames, and one that is longer or shorter at the same share of it. Its
 * frames are drawn as wide as the reference's, each with its own time.
 */
import type { Runtime } from '../../runtime';
import { pictureSheets } from '../describe/frames';
import { insetPlan } from '../describe/inset';
import { sourceFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import type { Measure } from '../types';
import { writeSheets, type SheetResult } from './sheets';

export interface LikeResult {
  sheets: SheetResult[];
  /** Frames of the other video per frame of the reference. */
  scale: number;
  notes: string[];
}

/** Writes opening.jpg, shots/NN-frames.jpg and transitions/NN.jpg of video into outDir, at the moments of the reference's. */
export const sheetsLike = async (rt: Runtime, video: string, reference: Measure, outDir: string): Promise<LikeResult> => {
  const p = await probe(rt, video);
  const theirs = Math.max(1, reference.source.frames), ours = Math.max(1, sourceFrames(p));
  const scale = ours / theirs;
  const at = (f: number): number => Math.min(ours - 1, Math.max(0, Math.round(f * scale)));
  const specs = pictureSheets(reference).map((s) => ({
    ...s, frames: [...new Set(s.frames.map(at))], marked: (s.marked ?? []).map(([a, b]) => [at(a), at(b)] as const),
  }));
  const fps = p.fps > 0 ? p.fps : 30;
  const notes: string[] = [];
  if (Math.abs(ours / fps - reference.source.duration) > 1 / fps + 1e-6) {
    notes.push('This video lasts ' + (ours / fps).toFixed(2) + ' s and the reference ' + reference.source.duration.toFixed(2) + ' s: each picture is taken at the same share of the length, so a shot whose length changed shows at its share, not at its own time.');
  }
  const w = await writeSheets(rt, video, specs, { width: insetPlan(reference.source).width, outDir, probe: p });
  return { sheets: w.sheets, scale: Math.round(scale * 10000) / 10000, notes };
};
