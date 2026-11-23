/**
 * A bar: words side by side in one row that stay on screen together through much of the video (the sections of a
 * video, a menu), laid on in the edit, often with the current one marked by another colour or a plate. It is design
 * text a re-make draws, not a watermark. A plain account mark is often words side by side too ("@name · platform"), so a
 * row is a bar when the frames show the mark moving between its words (measureBars), or, with no mark found, when it
 * has three or more words spread over most of the width (the reading alone, in cues.ts) and the picture under it
 * changes while it stays; a row whose look never changes stays a watermark. The frames also say which word was marked
 * when (BarInfo.highlighted).
 *
 * Only words the reader read as separate lines make a row; a bar read as one line ("Intro  Setup  Results") stays one
 * cue and keeps the role the rules give it.
 */
import type { Runtime } from '../../runtime';
import { deltaE, toLab } from '../measure/colour';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { readColour } from '../media/decode';
import { changedShare, smallOf, type Small } from './change';
import type { Lab } from './frame';
import type { TextCue, TextTrack } from './types';

/** A word of a bar: its row (0 for the highest bar), its place in the row from the left, and how many words the row has. */
export interface BarInfo {
  row: number;
  at: number;
  of: number;
  /** Source frames (from, to) on which this word was the marked one, when the frames were looked at. */
  highlighted?: [number, number][];
}

type Bare = Omit<TextCue, 'role'>;
const centreY = (c: Bare): number => c.box[1] + c.box[3] / 2;
const overlap = (a: Bare, b: Bare): number => Math.min(a.end, b.end) - Math.max(a.start, b.start);
const apart = (a: Bare, b: Bare): boolean => a.box[0] + a.box[2] <= b.box[0] + 0.005 || b.box[0] + b.box[2] <= a.box[0] + 0.005;
/** Two words of one row: centres within half a line, alike in size, side by side, on screen together most of the time. */
const sameRow = (a: Bare, b: Bare): boolean =>
  Math.abs(centreY(a) - centreY(b)) <= 0.5 * Math.min(a.size, b.size) && Math.max(a.size, b.size) <= 1.5 * Math.min(a.size, b.size) &&
  apart(a, b) && overlap(a, b) >= 0.8 * Math.min(a.end - a.start, b.end - b.start);

/** Rows of two or more cues side by side, each from left to right, the highest row first. */
export const rowsOf = <T extends Bare>(cues: readonly T[]): T[][] => {
  const rows: T[][] = [];
  for (const c of [...cues].sort((a, b) => centreY(a) - centreY(b))) {
    const row = rows.find((r) => r.every((o) => sameRow(o, c)));
    if (row) row.push(c);
    else rows.push([c]);
  }
  return rows.filter((r) => r.length >= 2).map((r) => [...r].sort((a, b) => a.box[0] - b.box[0]));
};

/** A bar as describe and a re-make read it: its words from the left, and in each shot the word marked there (-1: none). */
export interface Bar { words: TextCue[]; marked: number[] }

/**
 * The bars of a track, the highest first. A shot's marked word is the one marked over more than half of the shot; a bar
 * whose frames were not looked at marks none.
 */
export const barsOf = (cues: readonly TextCue[], shots: readonly { start: number; end: number }[]): Bar[] => {
  const rows = new Map<number, TextCue[]>();
  for (const c of cues) if (c.bar) rows.set(c.bar.row, [...(rows.get(c.bar.row) ?? []), c]);
  return [...rows.keys()].sort((a, b) => a - b).map((r): Bar => {
    const words = [...(rows.get(r) ?? [])].sort((a, b) => (a.bar?.at ?? 0) - (b.bar?.at ?? 0));
    const marked = shots.map((s) => {
      const lit = words.map((w) => (w.bar?.highlighted ?? []).reduce((n, [f, t]) => n + Math.max(0, Math.min(t, s.end) - Math.max(f, s.start)), 0));
      const most = Math.max(0, ...lit);
      return most > 0.5 * (s.end - s.start) ? lit.indexOf(most) : -1;
    });
    return { words, marked };
  });
};

/** Shots by the word they mark, in runs: "Intro" shots 1-3, "Setup" shots 4-6 (shots counted from 1). */
export const markedText = (bar: Bar): string => {
  const runs: { m: number; from: number; to: number }[] = [];
  bar.marked.forEach((m, k) => {
    const last = runs[runs.length - 1];
    if (m >= 0 && last && last.m === m && last.to === k - 1) last.to = k;
    else if (m >= 0) runs.push({ m, from: k, to: k });
  });
  return runs.map((r) => quote(bar.words[r.m]?.text ?? '') + (r.from === r.to ? ' shot ' + (r.from + 1) : ' shots ' + (r.from + 1) + '-' + (r.to + 1))).join(', ');
};

/** Words a reader read apart that may be a bar without a mark: three or more in a row spread over this share of the width. */
export const MIN_BAR_WORDS = 3;
export const BAR_SPREAD = 0.5;

/** The share of the width a row spans, from its first word's left edge to its last word's right edge. */
export const spreadOf = (row: readonly Bare[]): number =>
  Math.max(...row.map((c) => c.box[0] + c.box[2])) - Math.min(...row.map((c) => c.box[0]));

/** A row that is a bar from the reading alone, until the frames say otherwise: three or more words, spread wide. */
export const wideRow = (row: readonly Bare[]): boolean => row.length >= MIN_BAR_WORDS && spreadOf(row) >= BAR_SPREAD;

const quote = (t: string): string => '"' + t.replace(/"/g, "'") + '"';
export const barWhy = (row: readonly Bare[], moves?: string[]): string =>
  'one of ' + row.length + ' words in a row that stay on screen together (' + row.map((c) => quote(c.text)).join(', ') + '): a bar laid on in the edit, not a watermark' +
  (moves?.length ? '; the marked one changes: ' + moves.map(quote).join(', then ') : '');

/** A word is marked when its box (with the room a plate takes) differs from its row's unmarked words by this much (ΔE). */
const MARKED = 10;
/** Frames looked at per bar, at most: one a second over the time its words are on screen together. */
const MAX_LOOKS = 40;

/**
 * Which word of a row is marked at each look: the one whose box differs from every other word's by MARKED or more
 * while the others are alike (within half of it), and whose colour is not weaker than theirs (one plain word among
 * marked ones is not a mark); of two words, the one with the stronger colour when they differ by MARKED. -1 when no
 * word, or more than one, stands out.
 */
export const markedAt = (looks: Lab[][]): number[] =>
  looks.map((words) => {
    const chroma = (l: Lab): number => Math.hypot(l[1], l[2]);
    if (words.length === 2) {
      const [a, b] = words as [Lab, Lab];
      return deltaE(a, b) < MARKED ? -1 : chroma(a) >= chroma(b) ? 0 : 1;
    }
    const out = words.flatMap((w, j) => {
      const others = words.filter((_o, k) => k !== j);
      const far = others.every((o) => deltaE(w, o) >= MARKED);
      const alike = others.every((o) => others.every((p) => deltaE(o, p) < MARKED / 2));
      const weaker = others.every((o) => chroma(o) - chroma(w) >= MARKED);
      return far && alike && !weaker ? [j] : [];
    });
    return out.length === 1 ? (out[0] as number) : -1;
  });

/** Runs of looks marking word j, as source frames: half a look's spacing out on each side. */
const spansOf = (marked: number[], frames: number[], j: number): [number, number][] => {
  const out: [number, number][] = [];
  const half = frames.length > 1 ? Math.round(((frames[1] ?? 0) - (frames[0] ?? 0)) / 2) : 0;
  marked.forEach((m, k) => {
    if (m !== j) return;
    const f = frames[k] ?? 0, last = out[out.length - 1];
    if (last && marked[k - 1] === j) last[1] = f + half;
    else out.push([Math.max(0, f - half), f + half]);
  });
  return out;
};

/** The order in which words were marked, each change once: ["Intro", "Setup", "Results"]. */
const movesOf = (marked: number[], row: readonly Bare[]): string[] =>
  marked.filter((m, k) => m >= 0 && m !== marked.slice(0, k).filter((x) => x >= 0).at(-1)).map((m) => row[m]?.text ?? '');

/** A whole frame's mean colour: what changes when the video moves on under a row that stays. */
const meanOf = (rgb: Uint8Array): Lab => {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < rgb.length; i += 3) { r += rgb[i] ?? 0; g += rgb[i + 1] ?? 0; b += rgb[i + 2] ?? 0; }
  const n = Math.max(1, rgb.length / 3);
  return toLab([r / n, g / n, b / n]);
};
/**
 * The picture under a row moves on while the row stays: two or more pairs of looks in turn differ, by their mean colour
 * (ΔE 10) or by what they show (a twentieth of the cells of a small grey picture or more, the row's band left out; see
 * change.ts). A dark screen recording changes what it shows all the time while its mean colour hardly moves.
 */
const PICTURE_MOVES = 10;
const PICTURE_CHANGE = 0.05;
const pictureMoves = (frames: Uint8Array[], w: number, h: number, row: readonly Bare[]): boolean => {
  const line = Math.max(...row.map((c) => c.box[3]));
  const skip = [Math.min(...row.map((c) => c.box[1])) - line, Math.max(...row.map((c) => c.box[1] + c.box[3])) + line] as const;
  const means = frames.map(meanOf), small = frames.map((f) => smallOf(f, w, h, { skip }));
  return frames.filter((_f, k) => k > 0 && (deltaE(means[k] as Lab, means[k - 1] as Lab) >= PICTURE_MOVES || changedShare(small[k] as Small, small[k - 1] as Small) >= PICTURE_CHANGE)).length >= 2;
};

/**
 * The mean Lab of each word's box on each frame (rgb24, w x h), with room above and below for a plate (a third of a line
 * height); sideways only the word's own width, a twentieth in from each side, so that a neighbour's plate set close
 * does not count as this word's look.
 */
const looksOf = (frames: Uint8Array[], w: number, h: number, row: readonly Bare[]): Lab[][] => {
  const bounds = row.map((c) => {
    const pad = 0.35 * c.box[3], inset = 0.05 * c.box[2];
    return { x0: Math.max(0, Math.floor((c.box[0] + inset) * w)), x1: Math.min(w, Math.ceil((c.box[0] + c.box[2] - inset) * w)), y0: Math.max(0, Math.floor((c.box[1] - pad) * h)), y1: Math.min(h, Math.ceil((c.box[1] + c.box[3] + pad) * h)) };
  });
  return frames.map((rgb) => bounds.map(({ x0, x1, y0, y1 }) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = 3 * (y * w + x);
      r += rgb[i] ?? 0; g += rgb[i + 1] ?? 0; b += rgb[i + 2] ?? 0; n++;
    }
    const k = Math.max(1, n);
    return toLab([r / k, g / k, b / k]);
  }));
};

type Info = Awaited<ReturnType<typeof probe>>;

const grab = async (rt: Runtime, video: string, info: Info, frames: number[]): Promise<{ rgb: Uint8Array[]; w: number; h: number }> => {
  const w = Math.min(640, Math.round(info.width / 2) * 2), h = Math.round((info.height * w) / info.width / 2) * 2;
  const colour = await readColour(rt, video, info);
  const select = "select='" + frames.map((n) => 'eq(n,' + n + ')').join('+') + "'";
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-vf', select + ',scale=' + w + ':' + h + ':in_color_matrix=' + colour.matrix + ':in_range=' + colour.range + ',format=rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const bytes = w * h * 3;
  return { rgb: frames.map((_f, k) => r.stdout.subarray(k * bytes, (k + 1) * bytes)).filter((b) => b.length === bytes), w, h };
};

/**
 * The track with its bars looked at in the frames: a row whose mark moves between its words is a bar, its words with
 * the frames each was marked on; a wide row with no mark stays a bar only when the picture under it changes; any other
 * row is a watermark (the role it has, or the one it gets back).
 */
export const measureBars = async (rt: Runtime, video: string, track: TextTrack): Promise<TextTrack> => {
  const rows = rowsOf(track.cues.filter((c) => c.bar || c.role === 'watermark'));
  if (!rows.length) return track;
  const info = await probe(rt, video);
  const fps = info.fps > 0 ? info.fps : 30;
  const changed = new Map<TextCue, TextCue>();
  let next = Math.max(-1, ...track.cues.map((c) => c.bar?.row ?? -1)) + 1;
  for (const row of rows) {
    const from = Math.max(...row.map((c) => c.start)), to = Math.min(...row.map((c) => c.end));
    const n = Math.min(MAX_LOOKS, Math.max(4, Math.round((to - from) / fps)));
    const frames = Array.from({ length: n }, (_v, k) => Math.round(from + ((k + 0.5) * (to - from)) / n));
    const got = await grab(rt, video, info, frames);
    if (got.rgb.length !== frames.length) continue;
    const marked = markedAt(looksOf(got.rgb, got.w, got.h, row));
    const moves = movesOf(marked, row);
    const moving = new Set(marked.filter((m) => m >= 0)).size >= 2 && marked.filter((m) => m >= 0).length >= 0.6 * n;
    const isBar = row.every((c) => c.bar && c.bar.of === row.length);
    if (!moving && isBar && !pictureMoves(got.rgb, got.w, got.h, row)) {
      row.forEach((c) => {
        const { bar: _bar, ...rest } = c;
        changed.set(c, { ...rest, role: 'watermark', why: 'a row of words that stays on screen and never changes its look, over a picture that does not change either' });
      });
      continue;
    }
    if (!moving && !isBar) continue;
    const id = isBar ? (row[0]?.bar?.row ?? 0) : next++;
    row.forEach((c, j) => {
      const bar: BarInfo = { row: id, at: j, of: row.length, ...(moving ? { highlighted: spansOf(marked, frames, j) } : {}) };
      changed.set(c, { ...c, role: isBar ? c.role : c.size >= 0.06 ? 'title' : 'label', why: barWhy(row, moving ? moves : undefined), bar });
    });
  }
  return changed.size ? { ...track, cues: track.cues.map((c) => changed.get(c) ?? c) } : track;
};
