/**
 * Contact sheets of a video: runs of its frames laid out in one picture, each frame with its time under it, so that
 * whoever looks sees an effect across its frames rather than a few moments of a shot. One pass of ffmpeg decodes every
 * frame any sheet needs, picked by number (the measurement's numbering, as extractFrame counts) at the size of a tile;
 * each sheet is drawn as its frames arrive and written as a JPEG once its last frame is in, so memory holds the sheets
 * being drawn, never the decoded video. Frames the caller wants as they are (the frame around the content reads a few
 * a second) come out of the same pass.
 */
import type { Runtime } from '../../runtime';
import { readColour, sourceFrames, thumbSize } from '../media/decode';
import type { FootageColour } from '../media/footage';
import { FfmpegError, probe, runFfmpeg, runFfmpegOk } from '../media/ffmpeg';
import type { Probe } from '../types';

/** One sheet to draw: where it goes (relative to the output directory) and the frames it shows, in order. */
export interface SheetSpec {
  file: string;
  frames: number[];
  /** Frame ranges (first, last; inclusive) inside a measured transition: their times are written on an orange band. */
  marked?: readonly (readonly [number, number])[];
}

/** A sheet as written: its file, its frames with their times (seconds), and its grid. */
export interface SheetResult {
  file: string;
  frames: number[];
  seconds: number[];
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export interface SheetOptions {
  /** Width of one frame in pixels; the height keeps the video's proportions (thumbSize). */
  width: number;
  outDir: string;
  /** Seconds written under a frame (default: its number over the video's rate). */
  secondsOf?: (frame: number) => number;
  /** Frames to hand back as they are (rgb24 at the tile size), decoded in the same pass. */
  keep?: readonly number[];
  probe?: Probe;
  colour?: FootageColour;
}

export interface SheetsWritten {
  sheets: SheetResult[];
  /** The frames asked for with keep, by number, and their size. */
  kept: Map<number, Uint8Array>;
  size: { width: number; height: number };
}

/** Pixels between tiles and round the edge, the height of the band a time is written on, and the widest sheet. */
const GAP = 4;
const BAND = 18;
const MAX_WIDTH = 1400;
const GROUND: readonly [number, number, number] = [26, 26, 26];
const INK: readonly [number, number, number] = [240, 240, 240];
const MARK: readonly [number, number, number] = [232, 160, 32];
const MARK_INK: readonly [number, number, number] = [16, 16, 16];

/** Digits and the few signs of a time, 5 x 7 cells, row by row: drawtext needs a font library many ffmpeg builds lack. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
};

/** Rows and columns for n tiles of a given width: as few rows as the widest sheet allows, the tiles spread evenly over them. */
export const gridOf = (n: number, tileWidth: number): { columns: number; rows: number } => {
  const most = Math.max(1, Math.floor((MAX_WIDTH - GAP) / (tileWidth + GAP)));
  const rows = Math.max(1, Math.ceil(n / most));
  return { columns: Math.max(1, Math.ceil(n / rows)), rows };
};

/** The time written under a frame: seconds to a hundredth, as "12.34s". */
export const timeLabel = (seconds: number): string => seconds.toFixed(2) + 's';

interface Canvas { width: number; height: number; data: Uint8Array }

const fill = (c: Canvas, x: number, y: number, w: number, h: number, rgb: readonly [number, number, number]): void => {
  for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) {
      const i = (yy * c.width + xx) * 3;
      c.data[i] = rgb[0];
      c.data[i + 1] = rgb[1];
      c.data[i + 2] = rgb[2];
    }
  }
};

/** Writes text in the glyph cells, s pixels a cell, with its top left corner at x, y. */
const write = (c: Canvas, text: string, x: number, y: number, s: number, rgb: readonly [number, number, number]): void => {
  [...text].forEach((ch, k) => {
    const rows = GLYPHS[ch];
    if (!rows) return;
    rows.forEach((row, r) => [...row].forEach((cell, q) => { if (cell === '#') fill(c, x + (k * 6 + q) * s, y + r * s, s, s, rgb); }));
  });
};

const blit = (c: Canvas, tile: Uint8Array, tw: number, th: number, x: number, y: number): void => {
  for (let r = 0; r < th; r++) c.data.set(tile.subarray(r * tw * 3, (r + 1) * tw * 3), ((y + r) * c.width + x) * 3);
};

/** A select expression that passes exactly these frames (sorted, distinct): runs of neighbours become one between(). */
export const pickExpression = (frames: readonly number[]): string => {
  const terms: string[] = [];
  for (let i = 0; i < frames.length;) {
    let j = i;
    while (j + 1 < frames.length && (frames[j + 1] as number) === (frames[j] as number) + 1) j++;
    terms.push(i === j ? 'eq(n,' + frames[i] + ')' : 'between(n,' + frames[i] + ',' + frames[j] + ')');
    i = j + 1;
  }
  return terms.join('+');
};

/** Pieces of a sorted frame list whose select expressions stay well under the length one argument may have. */
const pieces = (frames: readonly number[], most = 50_000): number[][] => {
  const out: number[][] = [];
  let cur: number[] = [];
  let length = 0;
  for (const f of frames) {
    if (length > most && cur.length && f !== (cur[cur.length - 1] as number) + 1) { out.push(cur); cur = []; length = 0; }
    cur.push(f);
    length += 16;
  }
  if (cur.length) out.push(cur);
  return out;
};

/**
 * Decodes the given frames (sorted, distinct) at a size, with the source's own colour matrix and range as the
 * measurement reads them, and hands each to onFrame in order. Frames past the end of the video never come.
 */
const decodePicked = async (rt: Runtime, video: string, frames: readonly number[], size: { width: number; height: number }, colour: FootageColour, onFrame: (frame: number, rgb: Uint8Array) => void): Promise<void> => {
  const bytes = size.width * size.height * 3;
  for (const part of pieces(frames)) {
    let k = 0, filled = 0;
    let current = new Uint8Array(bytes);
    const vf = "select='" + pickExpression(part) + "',scale=" + size.width + ':' + size.height + ':in_color_matrix=' + colour.matrix + ':in_range=' + colour.range + ':flags=area+accurate_rnd,format=rgb24';
    const r = await runFfmpeg(rt, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-an', '-sn', '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], undefined, (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(bytes - filled, chunk.length - off);
        current.set(chunk.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled < bytes) continue;
        if (k < part.length) onFrame(part[k] as number, current);
        k++;
        current = new Uint8Array(bytes);
        filled = 0;
      }
    });
    if (r.code !== 0) throw new FfmpegError('ffmpeg exited with ' + r.code + ' while decoding frames for the sheets: ' + r.stderr.trim().split('\n').slice(-3).join(' | '), r.stderr);
  }
};

interface Drawing { spec: SheetSpec; grid: { columns: number; rows: number }; canvas?: Canvas; left: number; result: SheetResult; written?: true }

/** Draws one frame into its place on a sheet: the picture, and its time on a band (orange inside a transition). */
const place = (d: Drawing, slot: number, rgb: Uint8Array, tw: number, th: number, label: string, marked: boolean): void => {
  const { width, height } = d.result;
  d.canvas ??= (() => { const c = { width, height, data: new Uint8Array(width * height * 3) }; fill(c, 0, 0, width, height, GROUND); return c; })();
  const x = GAP + (slot % d.grid.columns) * (tw + GAP), y = GAP + Math.floor(slot / d.grid.columns) * (th + BAND + GAP);
  blit(d.canvas, rgb, tw, th, x, y);
  if (marked) fill(d.canvas, x, y + th, tw, BAND, MARK);
  const s = 2, w = (label.length * 6 - 1) * s;
  write(d.canvas, label, x + Math.max(0, Math.round((tw - w) / 2)), y + th + 2, s, marked ? MARK_INK : INK);
};

const encodeJpeg = async (rt: Runtime, c: Canvas, file: string): Promise<void> => {
  await rt.fs.mkdir(rt.path.dirname(file));
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', c.width + 'x' + c.height, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', file], c.data);
};

/** Writes every sheet into outDir in one decoding pass; returns them with their frames and times, and the frames kept. */
export const writeSheets = async (rt: Runtime, video: string, specs: readonly SheetSpec[], o: SheetOptions): Promise<SheetsWritten> => {
  const p = o.probe ?? (await probe(rt, video));
  const colour = o.colour ?? (await readColour(rt, video, p));
  const size = thumbSize(p.width, p.height, Math.min(o.width, p.width));
  const fps = p.fps > 0 ? p.fps : 30;
  const secondsOf = o.secondsOf ?? ((f: number): number => f / fps);
  const last = Math.max(0, sourceFrames(p) - 1);
  const drawings: Drawing[] = specs.map((spec) => {
    const frames = spec.frames.filter((f) => f >= 0 && f <= last);
    const grid = gridOf(Math.max(1, frames.length), size.width);
    const width = GAP + grid.columns * (size.width + GAP), height = GAP + grid.rows * (size.height + BAND + GAP);
    const result: SheetResult = { file: rt.path.join(o.outDir, spec.file), frames, seconds: frames.map((f) => Math.round(secondsOf(f) * 1000) / 1000), ...grid, width, height };
    return { spec: { ...spec, frames }, grid, left: frames.length, result };
  });
  const wanted = new Map<number, Array<{ d: Drawing; slot: number }>>();
  for (const d of drawings) d.spec.frames.forEach((f, slot) => { wanted.set(f, [...(wanted.get(f) ?? []), { d, slot }]); });
  const keep = new Set((o.keep ?? []).filter((f) => f >= 0 && f <= last));
  const kept = new Map<number, Uint8Array>();
  // A finished sheet is encoded while the decoding goes on, one at a time, and let go once written. A failure is kept
  // and thrown once the decoding is over (a rejection nobody awaits yet would end the process).
  let written: Promise<void> = Promise.resolve();
  let failed: { error: unknown } | undefined;
  const finish = (d: Drawing): void => {
    const canvas = d.canvas;
    d.canvas = undefined;
    if (!canvas) return;
    d.written = true;
    written = written.then(() => (failed ? undefined : encodeJpeg(rt, canvas, d.result.file))).catch((error: unknown) => { failed ??= { error }; });
  };
  const frames = [...new Set([...wanted.keys(), ...keep])].sort((a, b) => a - b);
  await decodePicked(rt, video, frames, size, colour, (frame, rgb) => {
    if (keep.has(frame)) kept.set(frame, rgb);
    for (const { d, slot } of wanted.get(frame) ?? []) {
      const marked = (d.spec.marked ?? []).some(([a, b]) => frame >= a && frame <= b);
      place(d, slot, rgb, size.width, size.height, timeLabel(secondsOf(frame)), marked);
      if (--d.left === 0) finish(d);
    }
  });
  // A sheet whose last frames never came (the video ended early) is written with what it has.
  for (const d of drawings) if (d.left > 0 && d.canvas) finish(d);
  await written;
  if (failed) throw failed.error;
  return { sheets: drawings.filter((d) => d.written).map((d) => d.result), kept, size };
};
