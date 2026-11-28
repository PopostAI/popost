/**
 * Caption lines drawn into pixel buffers for the tests of the caption look (no font, no browser, no file): block
 * letters from a 5x7 table, heavy or regular strokes, an outline (the strokes grown), a soft shadow (the grown strokes
 * moved and blurred), a rounded plate behind the line, a word in another colour, and only the first characters of a
 * line (a line that builds up). The
 * line is drawn at three times the size and averaged down, then its colour is averaged over 2x2 blocks as a 4:2:0
 * video keeps it, so strokes have the soft edges and the bled colour of a small video.
 */
import { toLab } from '../../src/video/measure/colour';
import type { Frame, Rect, Rgb } from '../../src/video/text/frame';

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

export interface SynthStyle {
  fill: Rgb;
  /** Stroke width as a share of a cell of the 5x7 table (default 1.15, heavy); about 0.55 is regular. */
  stroke?: number;
  outline?: { color: Rgb; width: number };
  shadow?: { color: Rgb; dx: number; dy: number; blur: number; opacity?: number };
  /** A plate behind the line: padding and corner radius as shares of the letters' height. */
  plate?: { color: Rgb; padding: number; radius: number };
}

export interface SynthLine {
  text: string;
  /** Height of the letters in pixels of the finished frame. */
  glyph: number;
  style: SynthStyle;
  /** The picture behind the line at a pixel of the finished frame. */
  ground: (x: number, y: number) => Rgb;
  /** Characters [from, to) drawn in another colour. */
  lit?: { from: number; to: number; color: Rgb };
  /** Only the first characters are drawn (the box is still the whole line's). */
  shown?: number;
  width?: number;
  height?: number;
  /** Passes of a 3x3 blur over the finished frame: a video enlarged from a smaller one, or compressed hard. */
  soften?: number;
}

const SS = 3;

/** A separable box blur of a coverage map, radius in pixels. */
const blur = (m: Float32Array, w: number, h: number, r: number): Float32Array => {
  if (r < 1) return m;
  const pass = (src: Float32Array, step: number, len: number, lines: number, next: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let l = 0; l < lines; l++) {
      for (let s = 0; s < len; s++) {
        let sum = 0, n = 0;
        for (let k = -r; k <= r; k++) { const j = s + k; if (j >= 0 && j < len) { sum += src[l * next + j * step] ?? 0; n++; } }
        out[l * next + s * step] = sum / n;
      }
    }
    return out;
  };
  return pass(pass(m, 1, w, h, w), w, h, w, 1);
};

/** Grows a mask by r pixels (a disc). */
const grown = (m: Float32Array, w: number, h: number, r: number): Float32Array => {
  const out = new Float32Array(m.length);
  const R = Math.ceil(r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!(m[y * w + x] ?? 0)) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const px = x + dx, py = y + dy;
      if (dx * dx + dy * dy <= r * r && px >= 0 && py >= 0 && px < w && py < h) out[py * w + px] = 1;
    }
  }
  return out;
};

/** A rounded rectangle around [x0, y0, x1, y1] grown by pad, corners of radius r: 1 inside. */
const rounded = (w: number, h: number, [x0, y0, x1, y1]: [number, number, number, number], pad: number, r: number): Float32Array => {
  const m = new Float32Array(w * h);
  const a = [x0 - pad, y0 - pad, x1 + pad, y1 + pad] as const;
  for (let y = Math.max(0, Math.floor(a[1])); y < Math.min(h, Math.ceil(a[3])); y++) for (let x = Math.max(0, Math.floor(a[0])); x < Math.min(w, Math.ceil(a[2])); x++) {
    const dx = Math.max(a[0] + r - x, 0, x - (a[2] - r)), dy = Math.max(a[1] + r - y, 0, y - (a[3] - r));
    if (dx * dx + dy * dy <= r * r) m[y * w + x] = 1;
  }
  return m;
};

/** One caption line as a frame and the box a text reader would give it, in pixels. */
export const drawLine = (o: SynthLine): { frame: Frame; box: Rect } => {
  const W = o.width ?? 480, H = o.height ?? Math.round(o.glyph * 4);
  const w = W * SS, h = H * SS;
  const cell = (o.glyph * SS) / 7, stroke = (o.style.stroke ?? 1.15) * cell;
  const chars = Array.from(o.text);
  // A letter advances six cells, a space three.
  const starts: number[] = [];
  let pen = 0;
  for (const ch of chars) { starts.push(pen); pen += (ch === ' ' ? 3 : 6) * cell; }
  const total = pen - cell;
  const left = Math.round((w - total) / 2), top = Math.round((h - 7 * cell) / 2);
  const ink = new Float32Array(w * h), lit = new Float32Array(w * h);
  const rect = (m: Float32Array, x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(h, Math.round(y1)); y++) for (let x = Math.max(0, Math.round(x0)); x < Math.min(w, Math.round(x1)); x++) m[y * w + x] = 1;
  };
  chars.forEach((ch, i) => {
    const rows = FONT[ch.toUpperCase()];
    if (!rows || (o.shown !== undefined && i >= o.shown)) return;
    const into = o.lit && i >= o.lit.from && i < o.lit.to ? lit : ink;
    const pad = (cell - stroke) / 2;
    rows.forEach((row, r) => Array.from(row).forEach((on, c) => {
      if (on !== '1') return;
      const x = left + (starts[i] ?? 0) + c * cell, y = top + r * cell;
      rect(into, x + pad, y + pad, x + cell - pad, y + cell - pad);
      // Thin strokes are joined to the neighbours on the right and below, so that a letter stays one shape.
      if (rows[r]?.[c + 1] === '1') rect(into, x + pad, y + pad, x + cell + cell - pad, y + cell - pad);
      if (rows[r + 1]?.[c] === '1') rect(into, x + pad, y + pad, x + cell - pad, y + cell + cell - pad);
    }));
  });
  const plate = o.style.plate ? rounded(w, h, [left, top, left + total, top + 7 * cell], o.style.plate.padding * o.glyph * SS, o.style.plate.radius * o.glyph * SS) : undefined;
  const both = ink.map((v, i) => Math.max(v, lit[i] ?? 0));
  const line = o.style.outline ? grown(both, w, h, o.style.outline.width * SS) : undefined;
  const sh = o.style.shadow;
  const shade = sh ? blur((() => {
    const src = line ?? both, moved = new Float32Array(w * h);
    const dx = Math.round(sh.dx * SS), dy = Math.round(sh.dy * SS);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (src[y * w + x]) { const px = x + dx, py = y + dy; if (px >= 0 && py >= 0 && px < w && py < h) moved[py * w + px] = 1; }
    return moved;
  })(), w, h, Math.round(sh.blur * SS)) : undefined;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sum = [0, 0, 0];
    const g = o.ground(x, y);
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const j = (y * SS + sy) * w + x * SS + sx;
      let c: Rgb = g;
      if (plate?.[j] && o.style.plate) c = o.style.plate.color;
      const a = (shade?.[j] ?? 0) * (sh?.opacity ?? 0.8);
      if (sh && a > 0) c = [c[0] + (sh.color[0] - c[0]) * a, c[1] + (sh.color[1] - c[1]) * a, c[2] + (sh.color[2] - c[2]) * a];
      if (line?.[j] && o.style.outline) c = o.style.outline.color;
      if (ink[j]) c = o.style.fill;
      if (lit[j] && o.lit) c = o.lit.color;
      sum[0] = (sum[0] ?? 0) + c[0]; sum[1] = (sum[1] ?? 0) + c[1]; sum[2] = (sum[2] ?? 0) + c[2];
    }
    for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = Math.round((sum[c] ?? 0) / (SS * SS));
  }
  for (let pass = 0; pass < (o.soften ?? 0); pass++) {
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) plane[i] = rgb[3 * i + c] ?? 0;
      const soft = blur(plane, W, H, 1);
      for (let i = 0; i < W * H; i++) rgb[3 * i + c] = Math.round(soft[i] ?? 0);
    }
  }
  // Colour at half the resolution of lightness, as 4:2:0 video keeps it.
  for (let y = 0; y + 1 < H; y += 2) for (let x = 0; x + 1 < W; x += 2) {
    const at = [y * W + x, y * W + x + 1, (y + 1) * W + x, (y + 1) * W + x + 1];
    const px = at.map((i) => [rgb[3 * i] ?? 0, rgb[3 * i + 1] ?? 0, rgb[3 * i + 2] ?? 0]);
    const luma = px.map((p) => 0.299 * (p[0] ?? 0) + 0.587 * (p[1] ?? 0) + 0.114 * (p[2] ?? 0));
    const mean = [0, 1, 2].map((c) => px.reduce((s, p) => s + (p[c] ?? 0), 0) / 4);
    const meanLuma = luma.reduce((s, v) => s + v, 0) / 4;
    at.forEach((i, k) => { for (let c = 0; c < 3; c++) rgb[3 * i + c] = Math.max(0, Math.min(255, Math.round((mean[c] ?? 0) + (luma[k] ?? 0) - meanLuma))); });
  }
  const lab = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) lab.set(toLab([rgb[3 * i] ?? 0, rgb[3 * i + 1] ?? 0, rgb[3 * i + 2] ?? 0]), 3 * i);
  const pad = 0.15 * o.glyph;
  // A reader's box: a little room above and beside the letters, and the room of the descenders below them.
  const box = { x0: Math.round(left / SS - pad), y0: Math.round(top / SS - pad), x1: Math.round((left + total) / SS + pad), y1: Math.round((top + 7 * cell) / SS + 2 * pad) };
  return { frame: { w: W, h: H, rgb, lab }, box };
};

/** A picture that changes everywhere and from line to line: k is the line. */
export const movingGround = (k: number, base = 128, swing = 90): ((x: number, y: number) => Rgb) => (x, y) => [
  base + swing * Math.sin(x / 23 + k * 1.7), base + swing * Math.sin(y / 17 - k * 1.1), base + swing * Math.cos((x + y) / 31 + k * 2.3),
].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as Rgb;
