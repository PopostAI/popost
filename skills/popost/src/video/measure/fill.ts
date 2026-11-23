/**
 * How much of a picture is not ground: the share of the frame that differs clearly from the colour at the picture's
 * edge and from everything that shades smoothly into it. A ground of a gradient with soft blurred blobs on it is all
 * ground, however many colours it has; a card, a picture, a line of text or an icon stands out of it by an edge.
 * The scene check (scene/check.ts) warns about a shot that is nearly all ground: a window with nothing in it passes
 * every other check. describe measures the reference's shots with the same function, so that a scene can be held to its
 * reference shot. Pure: a PNG or RGB pixels in, a number out.
 */
import { unzlibSync } from 'fflate';

/**
 * A part of the picture that stands out whatever its pixels: a rectangle [x, y, width, height] in fractions of the
 * picture, with round corners (radius in pixels) or the ellipse inside it. The scene check gives the clips and pictures
 * a project lays over a scene: footage shades smoothly into the frame it sits in, as photographs do, and the ground
 * would grow into it.
 */
export interface Region {
  box: readonly [number, number, number, number];
  radius?: number;
  ellipse?: boolean;
}

/** Whether the point (x, y), in pixels of a picture width x height, lies in the region. */
export const inRegion = (r: Region, x: number, y: number, width: number, height: number): boolean => {
  const w = r.box[2] * width, h = r.box[3] * height;
  const dx = x - r.box[0] * width - w / 2, dy = y - r.box[1] * height - h / 2;
  if (w <= 0 || h <= 0 || Math.abs(dx) > w / 2 || Math.abs(dy) > h / 2) return false;
  if (r.ellipse) return (dx / (w / 2)) ** 2 + (dy / (h / 2)) ** 2 <= 1;
  const radius = Math.min(r.radius ?? 0, w / 2, h / 2);
  // Past the straight part of both sides, the point must lie in the corner's circle.
  const cx = Math.abs(dx) - (w / 2 - radius), cy = Math.abs(dy) - (h / 2 - radius);
  return cx <= 0 || cy <= 0 || cx * cx + cy * cy <= radius * radius;
};

/** Cells along the picture's longer side: each the mean of the pixels it covers, which is the small blur. */
const CELLS = 160;
/** Neighbouring cells closer than this (largest difference of a channel, 0..255) shade into each other. */
const STEP = 18;
/** Cells on the edge this close to its most common colour are where the ground starts. */
const SEED = 40;

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undoes the PNG filter of one row (src without its filter byte) into cur, prev being the row above; false on a bad filter. */
const unfilterRow = (kind: number, src: Uint8Array, prev: Uint8Array, cur: Uint8Array, bpp: number): boolean => {
  const n = cur.length;
  if (kind === 0) cur.set(src);
  else if (kind === 1) for (let i = 0; i < n; i++) cur[i] = ((src[i] ?? 0) + (i >= bpp ? (cur[i - bpp] ?? 0) : 0)) & 255;
  else if (kind === 2) for (let i = 0; i < n; i++) cur[i] = ((src[i] ?? 0) + (prev[i] ?? 0)) & 255;
  else if (kind === 3) for (let i = 0; i < n; i++) cur[i] = ((src[i] ?? 0) + (((i >= bpp ? (cur[i - bpp] ?? 0) : 0) + (prev[i] ?? 0)) >> 1)) & 255;
  else if (kind === 4) for (let i = 0; i < n; i++) cur[i] = ((src[i] ?? 0) + (i >= bpp ? paeth(cur[i - bpp] ?? 0, prev[i] ?? 0, prev[i - bpp] ?? 0) : (prev[i] ?? 0))) & 255;
  else return false;
  return true;
};

/** A PNG's header and its image data inflated, when it is a PNG of 8 bits per channel, not interlaced, grey or colour. */
const openPng = (png: Uint8Array): { width: number; height: number; channels: number; raw: Uint8Array } | undefined => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return undefined;
  const width = view.getUint32(16), height = view.getUint32(20);
  const channels = CHANNELS[png[25] ?? -1];
  if (png[24] !== 8 || png[28] !== 0 || channels === undefined || width === 0 || height === 0) return undefined;
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4] ?? 0, png[at + 5] ?? 0, png[at + 6] ?? 0, png[at + 7] ?? 0);
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { joined.set(p, at); return at + p.length; }, 0);
  try {
    const raw = unzlibSync(joined);
    return raw.length >= (width * channels + 1) * height ? { width, height, channels, raw } : undefined;
  } catch {
    return undefined;
  }
};

/** w x h cells of size x size pixels of a picture width x height, and their colours. */
type Cells = { w: number; h: number; c: Float32Array; size: number; width: number; height: number };

/**
 * A picture as cells of CELLS along its longer side (the mean colour of each, red, green, blue), softened once more by
 * a 3 x 3 mean. rowAt(y) gives row y of the picture, channels bytes a pixel; it is asked for every row in order (a
 * PNG's row is undone from the one above), and undefined stops the reading.
 */
const cellsFrom = (width: number, height: number, channels: number, rowAt: (y: number) => Uint8Array | undefined): Cells | undefined => {
  const size = Math.max(1, Math.round(Math.max(width, height) / CELLS));
  const w = Math.ceil(width / size), h = Math.ceil(height / size);
  const sum = new Float64Array(w * h * 3), count = new Float64Array(w * h);
  const column = Int32Array.from({ length: width }, (_x, x) => Math.floor(x / size));
  // A grey picture has one channel (and alpha): it gives red, green and blue alike.
  const offsets = channels < 3 ? [0, 0, 0] : [0, 1, 2];
  // In a cell of 4 x 4 pixels or more, every other pixel of every other row tells its mean as well.
  const every = size >= 4 ? 2 : 1;
  for (let y = 0; y < height; y++) {
    // Every row is read (a PNG's filter may refer to the row above); only the rows sampled are added up.
    const pixels = rowAt(y);
    if (!pixels) return undefined;
    if (y % every !== 0) continue;
    const row = Math.floor(y / size) * w;
    for (let x = 0; x < width; x += every) {
      const cell = row + (column[x] ?? 0), p = x * channels;
      sum[cell * 3] = (sum[cell * 3] ?? 0) + (pixels[p + (offsets[0] ?? 0)] ?? 0);
      sum[cell * 3 + 1] = (sum[cell * 3 + 1] ?? 0) + (pixels[p + (offsets[1] ?? 0)] ?? 0);
      sum[cell * 3 + 2] = (sum[cell * 3 + 2] ?? 0) + (pixels[p + (offsets[2] ?? 0)] ?? 0);
      count[cell] = (count[cell] ?? 0) + 1;
    }
  }
  const c = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const cell = yy * w + xx, m = count[cell] || 1;
      r += (sum[cell * 3] ?? 0) / m;
      g += (sum[cell * 3 + 1] ?? 0) / m;
      b += (sum[cell * 3 + 2] ?? 0) / m;
      n++;
    }
    c.set([r / n, g / n, b / n], (y * w + x) * 3);
  }
  return { w, h, c, size, width, height };
};

/** The cells of a PNG, read row by row: the full picture is never kept. Undefined for a PNG of another kind (16 bits, a palette, interlaced) or for bytes that are not one. */
const cellsOfPng = (png: Uint8Array): Cells | undefined => {
  const open = openPng(png);
  if (!open) return undefined;
  const { width, height, channels, raw } = open;
  const stride = width * channels;
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  return cellsFrom(width, height, channels, (y) => {
    const from = y * (stride + 1);
    if (!unfilterRow(raw[from] ?? -1, raw.subarray(from + 1, from + 1 + stride), prev, cur, channels)) return undefined;
    [prev, cur] = [cur, prev];
    return prev;
  });
};

const apart = (c: Float32Array, a: number, b: number): number =>
  Math.max(Math.abs((c[a * 3] ?? 0) - (c[b * 3] ?? 0)), Math.abs((c[a * 3 + 1] ?? 0) - (c[b * 3 + 1] ?? 0)), Math.abs((c[a * 3 + 2] ?? 0) - (c[b * 3 + 2] ?? 0)));

/** The cells of the picture's edge whose colour is near the edge's most common one (8 levels a channel); cells marked in fixed are left out. */
const seedsOf = (w: number, h: number, c: Float32Array, fixed: Uint8Array): number[] => {
  const all: number[] = [];
  for (let x = 0; x < w; x++) all.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) all.push(y * w, y * w + w - 1);
  const edge = all.filter((cell) => !fixed[cell]);
  const bins = new Map<number, number[]>();
  for (const cell of edge) {
    const key = ((c[cell * 3] ?? 0) >> 5) * 64 + ((c[cell * 3 + 1] ?? 0) >> 5) * 8 + ((c[cell * 3 + 2] ?? 0) >> 5);
    const bin = bins.get(key);
    if (bin) bin.push(cell); else bins.set(key, [cell]);
  }
  const common = [...bins.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
  const mean = [0, 1, 2].map((k) => common.reduce((s, cell) => s + (c[cell * 3 + k] ?? 0), 0) / Math.max(1, common.length));
  return edge.filter((cell) => [0, 1, 2].every((k) => Math.abs((c[cell * 3 + k] ?? 0) - (mean[k] ?? 0)) <= SEED));
};

/** The cells whose centre lies in one of the regions, marked 1. */
const regionCells = ({ w, h, size, width, height }: Cells, regions: readonly Region[]): Uint8Array => {
  const marked = new Uint8Array(w * h);
  if (!regions.length) return marked;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = Math.min(width, (x + 0.5) * size), py = Math.min(height, (y + 0.5) * size);
    if (regions.some((r) => inRegion(r, px, py, width, height))) marked[y * w + x] = 1;
  }
  return marked;
};

/**
 * The share of the cells, 0..1, that are not ground. The ground is grown from the edge's most common colour to every
 * neighbour that differs from it by less than a small step, so it follows a gradient or a soft blob as far as they go
 * and stops at an edge. The cells of the regions are never ground, and the ground does not grow through them.
 */
const fillOfCells = (cells: Cells, regions: readonly Region[]): number => {
  const { w, h, c } = cells;
  const fixed = regionCells(cells, regions);
  const ground = new Uint8Array(w * h);
  const queue = seedsOf(w, h, c, fixed);
  for (const cell of queue) ground[cell] = 1;
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i] ?? 0, x = cell % w;
    for (const next of [x > 0 ? cell - 1 : -1, x < w - 1 ? cell + 1 : -1, cell - w, cell + w]) {
      if (next < 0 || next >= w * h || ground[next] || fixed[next] || apart(c, cell, next) > STEP) continue;
      ground[next] = 1;
      queue.push(next);
    }
  }
  const grown = ground.reduce((n, g) => n + g, 0);
  return 1 - grown / (w * h);
};

/**
 * The share of a PNG's picture, 0..1, that is not ground; undefined for a PNG of a kind it does not read. regions: parts
 * that count as not ground whatever their pixels.
 */
export const fillOfPng = (png: Uint8Array, regions: readonly Region[] = []): number | undefined => {
  const cells = cellsOfPng(png);
  return cells ? fillOfCells(cells, regions) : undefined;
};

/** The same share of a picture given as RGB bytes, row by row (a decoded frame); undefined when the bytes are too few. */
export const fillOfRgb = (width: number, height: number, rgb: Uint8Array): number | undefined => {
  if (width < 1 || height < 1 || rgb.length < width * height * 3) return undefined;
  const cells = cellsFrom(width, height, 3, (y) => rgb.subarray(y * width * 3, (y + 1) * width * 3));
  return cells ? fillOfCells(cells, []) : undefined;
};
