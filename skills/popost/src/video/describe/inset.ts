/**
 * A constant frame around the content: a decorated ground with a border, a title strip, or black bars, that every shot
 * (or most of them) shows while the picture inside it changes. A model that is not told re-creates such a video full
 * frame. Read from a few frames of each shot: a pixel belongs to the frame when it keeps its colour from shot to shot;
 * the frame is the bands of such pixels along the edges, and the content is the box inside them, where the pictures
 * change right up to its edges. A shared plain ground behind designed shots is no frame: what changes on it does not
 * fill a rectangle. Nothing is reported unless every one of these facts holds. Captions are drawn over the frame: the
 * pixels of the reader's caption and title lines count as the frame's, or captions on the black under a picture (a
 * new line every shot) stop the bottom band at their rows and no frame is found. Where they sit is reported with it.
 *
 * A frame whose ground moves (an animated backdrop on both sides, the same through the video) has no pixels that keep
 * their colour, and is found the other way round (findMovingInset): the ground changes slowly and smoothly and does
 * not jump where the content cuts, while the content does.
 */
import type { Runtime } from '../../runtime';
import { decodeFrames, readColour, sourceFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { deltaE, toLab } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { thumbWidth } from '../measure/index';
import type { TextTrack } from '../text/types';
import type { Box, Measure, Probe } from '../types';

export interface Inset {
  /** 'bars': the ground is black (a picture of other proportions letterboxed); 'frame': a designed ground. */
  kind: 'frame' | 'bars';
  /** Where the content sits, [x, y, width, height]: fractions of the canvas, and canvas pixels. */
  box: Box;
  pixels: Box;
  /** How many shots show the frame, of the shots looked at (those long enough to sample). */
  shots: number;
  of: number;
  /** The ground's main colours, with the share of the frame's pixels each covers. */
  colours: { hex: string; share: number }[];
  /** Where the caption band sits: on the frame below or above the content, or over it; absent without captions. */
  captions?: 'below' | 'above' | 'over';
  /** Text that stays on the frame through the video (a title strip): the reader's watermark lines outside the box. */
  constantText?: number;
  /** Titles on the frame outside the box (the reader's title lines there), which may change from shot to shot. */
  titles?: number;
  /** The ground moves on its own through the video (an animated backdrop): it changes between samples but not at the content's cuts. */
  moving?: true;
}

/** Where describe writes it, beside measure.json; template save reads it from there. */
export const INSET_FILE = 'inset.json';

/** Frames of a video sampled for the frame, with their numbers. */
export interface InsetSamples { width: number; height: number; frames: { frame: number; rgb: Uint8Array }[] }

/** Pixels of a sample (about 340 x 190 for 16:9): a box is found to within two or three canvas pixels at 720p. */
const SAMPLE_AREA = 65_536;
/** Two samples a second, and at most this many in all, whatever the length. */
const SAMPLES_PER_SECOND = 2;
const MAX_SAMPLES = 160;
/** At most this many samples of one shot go into its picture. */
const PER_SHOT = 5;
/** Levels (0..255, per channel) within which a pixel counts as the same in two shots, after compression and scaling. */
const SAME = 18;
/** A pixel is the frame's when at least this share of the shots agree on its colour. */
const QUORUM = 0.6;
/** A row or column is a band's when this share of its pixels are the frame's. */
const BAND_ROW = 0.9;
/** A band is at least this share of its side (and two sample pixels); a thinner one is an edge of the encoding. */
const MIN_BAND = 0.02;
/** Inside the box, at least this share of the pixels change between shots ... */
const INSIDE_CHANGES = 0.5;
/** ... and along each edge that has a band, this share: the pictures fill the box. */
const EDGE_CHANGES = 0.6;
/** A shot shows the frame when this share of the frame's pixels match it; the frame is reported when most shots do. */
const SHOT_MATCH = 0.9;
const MIN_SHARE = 0.6;
/** Bars: the frame's pixels are this dark (every channel), nearly all of them. */
const BLACK = 32;
const BLACK_SHARE = 0.95;

/**
 * Which frames are sampled (every every-th from the first) and how wide. describe's pictures are drawn at the same
 * width (about 340 x 190 for 16:9, wide enough to read a caption), so that one pass decodes both (parts.ts).
 */
export const insetPlan = (p: Probe): { every: number; width: number } => {
  const fps = p.fps > 0 ? p.fps : 30;
  return {
    every: Math.max(1, Math.round(fps / SAMPLES_PER_SECOND), Math.ceil(sourceFrames(p) / MAX_SAMPLES)),
    width: Math.min(p.width, thumbWidth(p.width, p.height, SAMPLE_AREA)),
  };
};

/** One pass of ffmpeg over the video: a few frames a second at a small size, in colour. */
export const insetSamples = async (rt: Runtime, video: string): Promise<InsetSamples> => {
  const p = await probe(rt, video);
  const { every, width } = insetPlan(p);
  const d = await decodeFrames(rt, video, { width, gray: false, every, probe: p, colour: await readColour(rt, video, p) });
  return { width: d.width, height: d.height, frames: d.frames.map((rgb, i) => ({ frame: i * every, rgb })) };
};

/** The per-byte median of equally long pictures (the lower one of an even count). */
const medianOf = (pictures: readonly Uint8Array[]): Uint8Array => {
  const first = pictures[0] as Uint8Array;
  if (pictures.length === 1) return first;
  const out = new Uint8Array(first.length);
  const values = new Array<number>(pictures.length);
  for (let i = 0; i < first.length; i++) {
    for (let k = 0; k < pictures.length; k++) values[k] = (pictures[k] as Uint8Array)[i] as number;
    values.sort((a, b) => a - b);
    out[i] = values[(pictures.length - 1) >> 1] as number;
  }
  return out;
};

/** Whether pixel p of two pictures has the same colour (within SAME on every channel). */
const same = (a: Uint8Array, b: Uint8Array, p: number): boolean =>
  Math.abs((a[3 * p] as number) - (b[3 * p] as number)) <= SAME && Math.abs((a[3 * p + 1] as number) - (b[3 * p + 1] as number)) <= SAME && Math.abs((a[3 * p + 2] as number) - (b[3 * p + 2] as number)) <= SAME;

/** One picture per shot (the median of up to PER_SHOT samples of its clean interior, clear of the transitions). */
const shotPictures = (s: InsetSamples, m: Measure): Uint8Array[] =>
  m.shots.flatMap((shot, i) => {
    const lo = i > 0 ? (m.boundaries[i - 1]?.end ?? shot.start) : 0;
    const hi = i < m.boundaries.length ? (m.boundaries[i]?.start ?? shot.end - 1) : shot.end - 1;
    const inside = s.frames.filter((f) => f.frame >= lo && f.frame <= hi);
    if (!inside.length) return [];
    const step = inside.length / Math.min(PER_SHOT, inside.length);
    return [medianOf(Array.from({ length: Math.min(PER_SHOT, inside.length) }, (_, k) => (inside[Math.floor(k * step)] as { rgb: Uint8Array }).rgb))];
  });

/** The bands of a mask of frame pixels: rows from the top and the bottom, then columns between them. */
const bandsOf = (frame: Uint8Array, w: number, h: number): { top: number; bottom: number; left: number; right: number } => {
  const row = (y: number): number => { let n = 0; for (let x = 0; x < w; x++) n += frame[y * w + x] as number; return n / w; };
  const column = (x: number, y0: number, y1: number): number => { let n = 0; for (let y = y0; y < y1; y++) n += frame[y * w + x] as number; return n / Math.max(1, y1 - y0); };
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < h && row(top) >= BAND_ROW) top++;
  while (bottom < h - top && row(h - 1 - bottom) >= BAND_ROW) bottom++;
  while (left < w && column(left, top, h - bottom) >= BAND_ROW) left++;
  while (right < w - left && column(w - 1 - right, top, h - bottom) >= BAND_ROW) right++;
  const keep = (n: number, side: number): number => (n >= Math.max(2, MIN_BAND * side) ? n : 0);
  return { top: keep(top, h), bottom: keep(bottom, h), left: keep(left, w), right: keep(right, w) };
};

/** The share of a rectangle's pixels that change between shots (not frame pixels). */
const changing = (frame: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number => {
  let n = 0, all = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; n += 1 - (frame[y * w + x] as number); }
  return all ? n / all : 0;
};

/** The main colours of some pixels: 16-level bins, near ones joined, those over 8% of the pixels, at most three. */
const coloursOf = (rgb: Uint8Array, pixels: readonly number[]): { hex: string; share: number }[] => {
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  for (const p of pixels) {
    const r = rgb[3 * p] as number, g = rgb[3 * p + 1] as number, b = rgb[3 * p + 2] as number;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bins.set(key, { n: bin.n + 1, sum: [bin.sum[0] + r, bin.sum[1] + g, bin.sum[2] + b] });
  }
  const kept: { lab: [number, number, number]; colour: number[]; n: number }[] = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const colour = bin.sum.map((v) => v / bin.n);
    const lab = toLab(colour);
    const near = kept.find((k) => deltaE(k.lab, lab) < 12);
    if (near) near.n += bin.n;
    else kept.push({ lab, colour, n: bin.n });
  }
  return kept.sort((a, b) => b.n - a.n).filter((k) => k.n / Math.max(1, pixels.length) >= 0.08).slice(0, 3)
    .map((k) => ({ hex: toHex(k.colour), share: Math.round((100 * k.n) / pixels.length) / 100 }));
};

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Sample pixels under the reader's caption and title lines, a third of a line height round each. */
const textMask = (text: TextTrack | undefined, w: number, h: number): Uint8Array => {
  const mask = new Uint8Array(w * h);
  for (const c of text?.cues ?? []) {
    if (c.role !== 'caption' && c.role !== 'title') continue;
    const [bx, by, bw, bh] = c.box, m = bh / 3;
    for (let y = Math.max(0, Math.floor((by - m) * h)); y < Math.min(h, Math.ceil((by + bh + m) * h)); y++)
      for (let x = Math.max(0, Math.floor((bx - m) * w)); x < Math.min(w, Math.ceil((bx + bw + m) * w)); x++) mask[y * w + x] = 1;
  }
  return mask;
};

/** Where the caption band is against the content box (fractions of the canvas): below it, above it, or over it. */
const captionPlace = (text: TextTrack | undefined, box: Box): Inset['captions'] => {
  const middles = (text?.cues ?? []).filter((c) => c.role === 'caption').map((c) => c.box[1] + c.box[3] / 2).sort((a, b) => a - b);
  const mid = middles[Math.floor(middles.length / 2)];
  if (mid === undefined) return undefined;
  return mid >= box[1] + box[3] ? 'below' : mid <= box[1] ? 'above' : 'over';
};

/** The frame around the content, or undefined when the facts do not show one. Needs two shots or more. text: what the reader read, when it did. */
export const findInset = (s: InsetSamples, m: Measure, text?: TextTrack): Inset | undefined => {
  const { width: w, height: h } = s;
  const pictures = shotPictures(s, m);
  if (pictures.length < 2) return undefined;
  const median = medianOf(pictures);
  const lines = textMask(text, w, h);
  // frame[p] = 1: most shots agree on pixel p's colour, or a caption is drawn there (over the frame).
  const frame = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    let agree = 0;
    for (const pic of pictures) if (same(pic, median, p)) agree++;
    frame[p] = lines[p] || agree >= QUORUM * pictures.length ? 1 : 0;
  }
  const b = bandsOf(frame, w, h);
  const x0 = b.left, y0 = b.top, x1 = w - b.right, y1 = h - b.bottom;
  if (!(b.top || b.bottom || b.left || b.right) || (x1 - x0) * (y1 - y0) < 0.2 * w * h) return undefined;
  if (changing(frame, w, x0, y0, x1, y1) < INSIDE_CHANGES) return undefined;
  // Along every edge that has a band, the pictures change right up to it (a strip of two pixels, one pixel in).
  const edges = [
    b.top ? changing(frame, w, x0, y0 + 1, x1, Math.min(y1, y0 + 3)) : 1, b.bottom ? changing(frame, w, x0, Math.max(y0, y1 - 3), x1, y1 - 1) : 1,
    b.left ? changing(frame, w, x0 + 1, y0, Math.min(x1, x0 + 3), y1) : 1, b.right ? changing(frame, w, Math.max(x0, x1 - 3), y0, x1 - 1, y1) : 1,
  ];
  if (edges.some((e) => e < EDGE_CHANGES)) return undefined;
  const ring: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x < x0 || x >= x1 || y < y0 || y >= y1) && !lines[y * w + x]) ring.push(y * w + x);
  const shows = pictures.filter((pic) => ring.filter((p) => same(pic, median, p)).length >= SHOT_MATCH * ring.length).length;
  if (shows < 2 || shows < MIN_SHARE * pictures.length) return undefined;
  const dark = ring.filter((p) => Math.max(median[3 * p] as number, median[3 * p + 1] as number, median[3 * p + 2] as number) <= BLACK).length;
  const W = m.source.width, H = m.source.height, sx = W / w, sy = H / h;
  const pixels: Box = [Math.round(x0 * sx), Math.round(y0 * sy), Math.round((x1 - x0) * sx), Math.round((y1 - y0) * sy)];
  const box: Box = [r3(pixels[0] / W), r3(pixels[1] / H), r3(pixels[2] / W), r3(pixels[3] / H)];
  const outside = (c: { box: Box }): boolean => c.box[1] + c.box[3] <= box[1] + 0.005 || c.box[1] >= box[1] + box[3] - 0.005;
  const onFrame = (role: string): number => new Set((text?.cues ?? []).filter((c) => c.role === role && outside(c)).map((c) => c.text)).size;
  const constant = onFrame('watermark'), titles = onFrame('title');
  const captions = captionPlace(text, box);
  return {
    kind: dark >= BLACK_SHARE * ring.length ? 'bars' : 'frame', box, pixels,
    shots: shows, of: pictures.length, colours: coloursOf(median, ring),
    ...(captions ? { captions } : {}), ...(constant ? { constantText: constant } : {}), ...(titles ? { titles } : {}),
  };
};

/** A pixel's change between two samples: the largest of its three channels. */
const diffAt = (a: Uint8Array, b: Uint8Array, p: number): number =>
  Math.max(Math.abs((a[3 * p] as number) - (b[3 * p] as number)), Math.abs((a[3 * p + 1] as number) - (b[3 * p + 1] as number)), Math.abs((a[3 * p + 2] as number) - (b[3 * p + 2] as number)));
/** The median of each pixel's change over pairs of samples (at most MAX_PAIRS pairs, evenly chosen). */
const MAX_PAIRS = 48;
const medianChange = (pairs: readonly [Uint8Array, Uint8Array][], n: number): Float32Array => {
  const step = Math.max(1, pairs.length / MAX_PAIRS), picked = Array.from({ length: Math.min(MAX_PAIRS, pairs.length) }, (_v, k) => pairs[Math.floor(k * step)] as [Uint8Array, Uint8Array]);
  const out = new Float32Array(n), values = new Array<number>(picked.length);
  for (let p = 0; p < n; p++) {
    picked.forEach(([a, b], k) => { values[k] = diffAt(a, b, p); });
    values.sort((x, y) => x - y);
    out[p] = values[(picked.length - 1) >> 1] ?? 0;
  }
  return out;
};
/** A ground pixel jumps across the content's cuts no more than twice its own change between samples, and this much. */
const GROUND_SLACK = 8;
/** The ground moves: at least this share of its pixels change by this many levels between samples, as a median. */
const GROUND_MOVES = 3;
const MOVING_SHARE = 0.3;

/**
 * The frame around the content when its ground moves, or undefined. The samples just before and just after each
 * boundary that the samples reach within a second are compared: the content jumps there; a pixel of the ground does
 * not jump more than it changes between two samples inside a shot. The ground is the bands of such pixels along the
 * edges (and the reader's caption and title lines, drawn over it), the content the box inside them, jumping right up
 * to its edges; a good part of the ground must move, and it must hold over most of the cuts.
 */
export const findMovingInset = (s: InsetSamples, m: Measure, text?: TextTrack): Inset | undefined => {
  const { width: w, height: h, frames } = s;
  const gap = frames.length > 1 ? (frames[1]?.frame ?? 0) - (frames[0]?.frame ?? 0) : 0;
  const across = (a: number, b: number): boolean => m.boundaries.some((x) => x.end >= a && x.start <= b);
  const cuts = m.boundaries.flatMap((b): [Uint8Array, Uint8Array][] => {
    const before = [...frames].reverse().find((f) => f.frame <= b.start), after = frames.find((f) => f.frame >= b.end);
    return before && after && after.frame - before.frame <= 2 * gap ? [[before.rgb, after.rgb]] : [];
  });
  const inside = frames.slice(1).flatMap((f, k): [Uint8Array, Uint8Array][] => {
    const prev = frames[k];
    return prev && !across(prev.frame, f.frame) ? [[prev.rgb, f.rgb]] : [];
  });
  if (cuts.length < 2 || inside.length < 2) return undefined;
  const jump = medianChange(cuts, w * h), drift = medianChange(inside, w * h);
  const lines = textMask(text, w, h);
  const ground = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) ground[p] = lines[p] || (jump[p] as number) <= Math.max(SAME, 2 * (drift[p] as number) + GROUND_SLACK) ? 1 : 0;
  const b = bandsOf(ground, w, h);
  const x0 = b.left, y0 = b.top, x1 = w - b.right, y1 = h - b.bottom;
  if (!(b.top || b.bottom || b.left || b.right) || (x1 - x0) * (y1 - y0) < 0.2 * w * h) return undefined;
  if (changing(ground, w, x0, y0, x1, y1) < INSIDE_CHANGES) return undefined;
  // Along every edge that has a band, the content jumps right up to it (as findInset asks of a still frame).
  const edges = [
    b.top ? changing(ground, w, x0, y0 + 1, x1, Math.min(y1, y0 + 3)) : 1, b.bottom ? changing(ground, w, x0, Math.max(y0, y1 - 3), x1, y1 - 1) : 1,
    b.left ? changing(ground, w, x0 + 1, y0, Math.min(x1, x0 + 3), y1) : 1, b.right ? changing(ground, w, Math.max(x0, x1 - 3), y0, x1 - 1, y1) : 1,
  ];
  if (edges.some((e) => e < EDGE_CHANGES)) return undefined;
  const ring: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x < x0 || x >= x1 || y < y0 || y >= y1) && !lines[y * w + x]) ring.push(y * w + x);
  // A ground that holds still is findInset's; this one moves over a good part of it.
  if (ring.filter((p) => (drift[p] as number) >= GROUND_MOVES).length < MOVING_SHARE * ring.length) return undefined;
  // The cuts the ground holds over: nearly all of its pixels change no more than they do inside a shot.
  const held = cuts.filter(([a, c]) => ring.filter((p) => diffAt(a, c, p) <= Math.max(SAME, 2 * (drift[p] as number) + GROUND_SLACK)).length >= SHOT_MATCH * ring.length).length;
  if (held < 2 || held < MIN_SHARE * cuts.length) return undefined;
  const W = m.source.width, H = m.source.height, sx = W / w, sy = H / h;
  const pixels: Box = [Math.round(x0 * sx), Math.round(y0 * sy), Math.round((x1 - x0) * sx), Math.round((y1 - y0) * sy)];
  const box: Box = [r3(pixels[0] / W), r3(pixels[1] / H), r3(pixels[2] / W), r3(pixels[3] / H)];
  const captions = captionPlace(text, box);
  return {
    kind: 'frame', box, pixels, shots: held + 1, of: cuts.length + 1, colours: coloursOf(medianOf(frames.map((f) => f.rgb)), ring), moving: true,
    ...(captions ? { captions } : {}),
  };
};

/**
 * The frame around the content, whichever way it shows: on a moving ground first (that reading needs a good part of
 * the ground to move, and a slow ground can still pass the constant reading's tolerance along two sides only, with the
 * box too tall), else constant.
 */
export const frameOf = (s: InsetSamples, m: Measure, text?: TextTrack): Inset | undefined => findMovingInset(s, m, text) ?? findInset(s, m, text);

const listed = (b: Box): string => '[' + b.join(', ') + ']';
const shotsText = (i: Inset, total: number): string =>
  (i.shots === i.of ? (i.of === total ? 'all ' + total + ' shots' : 'all ' + i.of + ' shots long enough to look at (of ' + total + ')') : i.shots + ' of the ' + i.of + ' shots' + (i.of === total ? '' : ' long enough to look at'));

/**
 * The facts of a frame in one line, and what to do about it: for REFERENCE.md and TEMPLATE.md. total: the reference's
 * shots. A designed frame is drawn once by a scene and the clips go into its box; black bars are space around a
 * picture of other proportions, not a design.
 */
export const insetText = (i: Inset, total: number): string => {
  const where = listed(i.box) + ' of the canvas (x ' + i.pixels[0] + ', y ' + i.pixels[1] + ', ' + i.pixels[2] + 'x' + i.pixels[3] + ' px)';
  const bars = i.kind === 'bars', onFrame = i.captions === 'below' || i.captions === 'above';
  const captions = onFrame ? '; the captions sit on the ' + (bars ? 'black' : 'frame') + ' ' + i.captions + ' it' : '';
  const constant = i.constantText ? ' Text that stays all through sits on the ' + (bars ? 'bars' : 'frame') + ' too (a watermark in text.json): the scene draws it.' : '';
  const titles = i.titles ? ' Titles sit on the ' + (bars ? 'black' : 'frame') + ' outside the picture too (' + i.titles + ' in text.json): the scene draws them.' : '';
  if (bars && !onFrame && !i.constantText && !i.titles)
    return 'Black bars: in ' + shotsText(i, total) + ' the picture fills only ' + where + ', black around it (a picture of other proportions). To re-create: fill the canvas, the bars are no design; to keep them, show material with "fit": "contain" on a black "ground".';
  if (bars)
    return 'Black bars: in ' + shotsText(i, total) + ' the picture fills only ' + where + ', black around it' + captions + '.' + constant + titles +
      ' To re-create: every shot is a scene on black with the clip or picture as an item in that box (video-scenes.md, "Footage inside a scene"); filling the canvas would put ' + (onFrame ? 'the captions' : 'that text') + ' over the picture.';
  if (i.moving)
    return 'Frame on a moving ground: in ' + shotsText(i, total) + ' the content sits in ' + where + ', over a ground that moves on its own through the whole video (an animated backdrop: it changes slowly and does not cut where the content cuts), mostly ' + i.colours.map((c) => c.hex).join(', ') + captions + '.' +
      ' To re-create: one scene draws the moving ground in every shot and keeps its motion going across the cuts (each shot starts the animation where the shot before left it: a negative delay of the shot\'s start), and each clip or picture goes into the box as a video or image item (video-scenes.md, "A screen inside a scene"); filling the canvas loses the ground.';
  return 'Frame: in ' + shotsText(i, total) + ' the content sits inside the same frame, in ' + where + ', on a ground of ' + i.colours.map((c) => c.hex + ' (' + Math.round(c.share * 100) + '%)').join(', ') + captions + '.' + constant + titles +
    ' To re-create: one scene draws the ground and the frame in every shot, and each clip or picture goes into the box as a video or image item (video-scenes.md, "A screen inside a scene"); a designed shot keeps its content in the box.';
};
