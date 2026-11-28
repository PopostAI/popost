/**
 * How a caption line comes on screen: whole at once, or built up word by word or character by character. Measured,
 * not read from a description: the frames around the start of a few lines are held against the line as it stands
 * later (the frame the look was measured on). For every column of the finished line's letters, a frame has it when
 * most of that column's letter pixels already have the letters' colour:
 * - whole: from nothing to nine tenths of the columns within WHOLE_SECONDS (a cut, a fade, a pop);
 * - built: the columns arrive from one side in steps. Steps of about a character each are 'chars', larger ones
 *   'words';
 * - a line that moves or grows in (its columns come in no order) is 'whole': it is one line entering, not a build.
 * A line that is already there on the first frame looked at, or whose colour the picture behind it has too, says
 * nothing and is left out. The kind is the one most lines agree on, with the share that do.
 */
import type { Runtime } from '../../runtime';
import { readColour } from '../media/decode';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { deltaE, hexToRgb, toLab } from '../measure/colour';
import { median, r2, type Frame, type Lab, type Rect } from './frame';
import type { CaptionLook, CaptionReveal, TextCue, TextTrack } from './types';

/** Lines looked at, at most: the ones with the most characters. */
export const REVEAL_LINES = 6;
/** A line complete this soon after its first letters is whole. */
const WHOLE_SECONDS = 0.1;
/** ΔE within which a pixel has the letters' colour: wide, the frames may be scaled down. */
const INK = 32;
/** Width the frames are scaled down to, at most. */
const MAX_WIDTH = 800;

/** Per frame: the share of the finished line's ink columns that are there, and whether they fill it from one side. */
export interface Coverage { share: number; ordered: boolean }

const near = (f: Frame, i: number, colours: Lab[]): boolean =>
  colours.some((c) => deltaE([f.lab[3 * i] ?? 0, f.lab[3 * i + 1] ?? 0, f.lab[3 * i + 2] ?? 0], c) <= INK);

/** The coverage of each frame against the finished line (final), inside the line's box; undefined when the finished line shows too little ink. */
export const coverageOf = (frames: Frame[], final: Frame, box: Rect, colours: Lab[]): Coverage[] | undefined => {
  const x0 = Math.max(0, Math.round(box.x0)), x1 = Math.min(final.w, Math.round(box.x1)), y0 = Math.max(0, Math.round(box.y0)), y1 = Math.min(final.h, Math.round(box.y1));
  const columns: number[][] = [];
  for (let x = x0; x < x1; x++) {
    const ink: number[] = [];
    for (let y = y0; y < y1; y++) if (near(final, y * final.w + x, colours)) ink.push(y * final.w + x);
    // A column that is nearly all ink is the picture's, not a letter's.
    if (ink.length >= 2 && ink.length <= 0.8 * (y1 - y0)) columns.push(ink);
  }
  if (columns.length < 12) return undefined;
  return frames.map((f) => {
    const has = columns.map((ink) => ink.filter((i) => near(f, i, colours)).length >= 0.5 * ink.length);
    const count = has.filter(Boolean).length;
    // From one side: the columns that are there are nearly a run from the left end, or from the right end.
    const last = has.lastIndexOf(true), first = has.indexOf(true);
    const ordered = count > 0 && (count >= 0.85 * (last + 1) || count >= 0.85 * (has.length - first));
    return { share: count / columns.length, ordered };
  });
};

export type LineReveal = { kind: CaptionReveal['kind']; frames?: number } | undefined;

/** One line from its coverage, frame by frame; chars: its characters without spaces. Undefined when its start was not seen. */
export const lineReveal = (cover: Coverage[], chars: number, fps: number): LineReveal => {
  const first = cover.findIndex((c) => c.share >= 0.08);
  if (first <= 0) return undefined;
  if (cover.slice(0, first).some((c) => c.share >= 0.08)) return undefined;
  const full = cover.findIndex((c, k) => k >= first && c.share >= 0.9);
  const wholeFrames = Math.max(2, Math.ceil(WHOLE_SECONDS * fps));
  if (full >= 0 && full - first <= wholeFrames) return { kind: 'whole' };
  const end = full >= 0 ? full : cover.length - 1;
  const span = cover.slice(first, end + 1);
  // Seen for too short a time to tell a build from a slow fade.
  if (full < 0 && span.length < wholeFrames + 2) return undefined;
  if (span.filter((c) => c.ordered).length < 0.7 * span.length) return { kind: 'whole' };
  let steps = 1, at = span[0]?.share ?? 0;
  for (const c of span.slice(1)) if (c.share - at > 0.03) { steps++; at = c.share; }
  const reached = Math.max(0.08, span[span.length - 1]?.share ?? 1);
  // Characters per step, over the part of the line that has arrived.
  const perStep = (chars * reached) / steps;
  return { kind: perStep >= 1.6 ? 'words' : 'chars', ...(full >= 0 ? { frames: full - first } : {}) };
};

/** The reveal most lines agree on. */
export const revealOf = (lines: LineReveal[], fps: number): CaptionReveal | undefined => {
  const seen = lines.flatMap((l) => (l ? [l] : []));
  if (seen.length < 2) return undefined;
  const kinds: CaptionReveal['kind'][] = ['whole', 'words', 'chars'];
  const kind = [...kinds].sort((a, b) => seen.filter((l) => l.kind === b).length - seen.filter((l) => l.kind === a).length || kinds.indexOf(a) - kinds.indexOf(b))[0] ?? 'whole';
  const mine = seen.filter((l) => l.kind === kind);
  const took = mine.flatMap((l) => (l.frames !== undefined ? [l.frames] : []));
  return { kind, lines: mine.length, of: seen.length, confidence: r2(mine.length / seen.length), ...(kind !== 'whole' && took.length ? { seconds: r2(median(took) / fps) } : {}) };
};

const charsOf = (text: string): number => Array.from(text.replace(/\s+/g, '')).length;

const picked = (track: TextTrack): TextCue[] =>
  track.cues.filter((c) => c.role === 'caption' && c.start > 0 && c.end - c.start >= 3).sort((a, b) => charsOf(b.text) - charsOf(a.text) || a.start - b.start).slice(0, REVEAL_LINES).sort((a, b) => a.start - b.start);

/**
 * How the caption lines of a video come on screen, from the frames around the start of up to REVEAL_LINES lines; one
 * ffmpeg pass, the caption band only. Undefined when the letters' colour is not known or fewer than two starts are seen.
 */
export const measureReveal = async (rt: Runtime, video: string, track: TextTrack, look: CaptionLook): Promise<CaptionReveal | undefined> => {
  const cues = picked(track);
  const colours = [look.color, look.highlight?.color].flatMap((c) => (c ? [toLab(hexToRgb(c))] : []));
  if (cues.length < 2 || !look.color) return undefined;
  const info = await probe(rt, video);
  const step = Math.max(1, track.step), after = Math.min(24, Math.round(0.6 * info.fps));
  // Each line: the frames from before the reader first saw it until a little after, and one frame from its middle.
  const spans = cues.map((c) => ({ from: Math.max(0, c.start - step - 2), to: Math.min(info.frames - 1, c.start + step + after), mid: Math.min(info.frames - 1, Math.round((c.start + c.end) / 2)) }));
  const wanted = [...new Set(spans.flatMap((s) => [...Array.from({ length: s.to - s.from + 1 }, (_v, k) => s.from + k), s.mid]))].sort((a, b) => a - b);
  const scale = Math.min(1, MAX_WIDTH / info.width);
  const W = Math.round((info.width * scale) / 2) * 2, H = Math.round((info.height * scale) / 2) * 2;
  const size = median(cues.map((c) => c.box[3])) * H;
  const top = Math.max(0, Math.floor(Math.min(...cues.map((c) => c.box[1])) * H - size)), bottom = Math.min(H, Math.ceil(Math.max(...cues.map((c) => c.box[1] + c.box[3])) * H + size));
  const h = bottom - top;
  if (h <= 0) return undefined;
  const colour = await readColour(rt, video, info);
  const select = "select='" + [...spans.map((s) => 'between(n,' + s.from + ',' + s.to + ')'), ...spans.map((s) => 'eq(n,' + s.mid + ')')].join('+') + "'";
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-vf', select + ',scale=' + W + ':' + H + ':in_color_matrix=' + colour.matrix + ':in_range=' + colour.range + ':flags=area,format=rgb24,crop=' + W + ':' + h + ':0:' + top, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const bytes = W * h * 3;
  const frameAt = (n: number): Frame | undefined => {
    const k = wanted.indexOf(n);
    const rgb = k < 0 ? undefined : r.stdout.subarray(k * bytes, (k + 1) * bytes);
    if (!rgb || rgb.length < bytes) return undefined;
    const lab = new Float32Array(W * h * 3);
    for (let i = 0; i < W * h; i++) lab.set(toLab([rgb[3 * i] ?? 0, rgb[3 * i + 1] ?? 0, rgb[3 * i + 2] ?? 0]), 3 * i);
    return { w: W, h, rgb, lab };
  };
  const lines = cues.map((c, k): LineReveal => {
    const s = spans[k];
    const final = s ? frameAt(s.mid) : undefined;
    if (!s || !final) return undefined;
    const frames = Array.from({ length: s.to - s.from + 1 }, (_v, j) => frameAt(s.from + j)).flatMap((f) => (f ? [f] : []));
    const [x, y, bw, bh] = c.box;
    const cover = coverageOf(frames, final, { x0: x * W, y0: y * H - top, x1: (x + bw) * W, y1: (y + bh) * H - top }, colours);
    return cover ? lineReveal(cover, charsOf(c.text), info.fps) : undefined;
  });
  return revealOf(lines, info.fps);
};
