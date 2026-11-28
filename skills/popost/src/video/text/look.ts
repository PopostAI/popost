/**
 * What is behind a caption's letters: a filled plate (a box of one colour around the line, clearly not the picture
 * around it), an outline, a shadow, or nothing; the colour that fills the letters; and a second fill colour on a word
 * or two of some lines (a highlight). Measured on the frames the text reader looked at, one per caption line (up to
 * MAX_SAMPLES), around the box the reader gave the line:
 * - a plate is a thin ring around the line's box of nearly one colour (its spread at most half the spread of the
 *   picture just outside it) that differs from that picture by ΔE 15 or more, ends within a line height above and
 *   below, and does so on most samples. Its colour and opacity: over a moving picture a see-through plate changes
 *   with what is behind it, so the plate's colour is fitted against the picture around it, sample by sample; padding
 *   and corner radius are read from where it ends and how much its corners are cut;
 * - without a plate, letters.ts tells the fill from an outline, a shadow or the picture: the fill is the colour that
 *   another colour encloses on all four sides, not the darkest or the most frequent pixels;
 * - highlight.ts finds words of another fill colour, and which words they were.
 * Every part has a confidence, and a colour only when it is sure (SURE). The style a fill gives its captions follows
 * it (retarget): the reference's plate, outline or plain letters, and its highlight colour for the words a fill marks.
 */
import type { Runtime } from '../../runtime';
import { readColour } from '../media/decode';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import { deltaE, toLab } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { CHANNELS, area, clamp, grow, inside, labMedian, labOf, median, medianRgb, r2, rgbMedian, rgbOf, ring, spreadOf, type Channel, type Frame, type Lab, type Rect, type Rgb } from './frame';
import { coreOf, farEnd, weightOf } from './core';
import { highlightOf } from './highlight';
import { candidatesOf, lettersOf, pictureAround, SURE, type Letters } from './letters';
import { measureReveal } from './reveal';
import type { CaptionHighlight, CaptionLook, TextCue, TextTrack } from './types';

export type { Frame, Rect } from './frame';

/** Lines measured at most: one frame each, the longest-lived first. */
export const MAX_SAMPLES = 20;
/** Fewer caption lines than this are not enough to tell a plate from the picture. */
export const MIN_SAMPLES = 3;
/** Share of the samples that must show a plate. */
const PLATE_SHARE = 0.6;
/** The font size retarget gives a caption, as a share of the height of the reader's box (captionLayout). */
const FONT_OF_BOX = 0.92;

type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * Where a plate's side is, beyond one side of a line's box: a plate's edge is a straight line along the whole side,
 * so the colour change between neighbouring rows (or columns), averaged along the side, peaks there, while the
 * changes of a picture average out. Pixels from the box to the edge, or undefined when no such edge stands out.
 */
const edgeBeyond = (f: Frame, box: Rect, side: Side, max: number): number | undefined => {
  const across = side === 'top' || side === 'bottom';
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  // Away from the box's corners, where a rounded plate's side bends.
  const lo = Math.round(across ? box.x0 + 0.1 * w : box.y0 + 0.15 * h), hi = Math.round(across ? box.x1 - 0.1 * w : box.y1 - 0.15 * h);
  const at = (d: number, u: number): number | undefined => {
    const x = across ? u : side === 'left' ? Math.round(box.x0) - 1 - d : Math.round(box.x1) + d;
    const y = !across ? u : side === 'top' ? Math.round(box.y0) - 1 - d : Math.round(box.y1) + d;
    return inside(f, x, y) ? y * f.w + x : undefined;
  };
  const profile: number[] = [];
  for (let d = 0; d < max; d++) {
    let sum = 0, n = 0;
    for (let u = lo; u < hi; u++) {
      const a = at(d, u), b = at(d + 1, u);
      if (a === undefined || b === undefined) continue;
      sum += deltaE(labOf(f, a), labOf(f, b));
      n++;
    }
    if (!n) break;
    profile.push(sum / n);
  }
  if (profile.length < 4) return undefined;
  const peak = profile.indexOf(Math.max(...profile));
  const strong = (profile[peak] ?? 0) >= 8 && (profile[peak] ?? 0) >= 2.5 * median(profile);
  return strong ? peak + 1 : undefined;
};

/** How far in from a rectangle's corner, along the diagonal, the plate's colour starts: a rounded corner's cut. */
const cornerCut = (f: Frame, r: Rect, lab: Lab, tol: number): number => {
  const corners: [number, number, number, number][] = [[r.x0, r.y0, 1, 1], [r.x1 - 1, r.y0, -1, 1], [r.x0, r.y1 - 1, 1, -1], [r.x1 - 1, r.y1 - 1, -1, -1]];
  const max = Math.round(Math.min(r.x1 - r.x0, r.y1 - r.y0) / 2);
  return median(corners.map(([x, y, dx, dy]) => {
    for (let k = 0; k < max; k++) {
      const px = Math.round(x + dx * k), py = Math.round(y + dy * k);
      if (inside(f, px, py) && deltaE(labOf(f, py * f.w + px), lab) <= tol) return k;
    }
    return max;
  }));
};

/** pairs: a pixel just inside the plate's edge and one just outside it, on the same line across the edge. */
interface PlateReading { plate: boolean; colour: Rgb; around: Rgb; letters?: Rgb; pad: number; cut: number; height: number; pairs: [Rgb, Rgb][] }

const rgbAt = (f: Frame, x: number, y: number): Rgb | undefined => {
  const px = Math.round(x), py = Math.round(y);
  return inside(f, px, py) ? rgbOf(f, py * f.w + px) : undefined;
};

/** Pixels two inside a plate's edge and three outside it, along its four sides, away from the corners. */
const edgePairs = (f: Frame, plate: Rect): [Rgb, Rgb][] => {
  const out: [Rgb, Rgb][] = [];
  const w = plate.x1 - plate.x0, h = plate.y1 - plate.y0;
  const add = (a: Rgb | undefined, b: Rgb | undefined): void => { if (a && b) out.push([a, b]); };
  for (let x = Math.round(plate.x0 + 0.15 * w); x < plate.x1 - 0.15 * w; x++) {
    add(rgbAt(f, x, plate.y0 + 2), rgbAt(f, x, plate.y0 - 3));
    add(rgbAt(f, x, plate.y1 - 3), rgbAt(f, x, plate.y1 + 2));
  }
  for (let y = Math.round(plate.y0 + 0.3 * h); y < plate.y1 - 0.3 * h; y++) {
    add(rgbAt(f, plate.x0 + 2, y), rgbAt(f, plate.x0 - 3, y));
    add(rgbAt(f, plate.x1 - 3, y), rgbAt(f, plate.x1 + 2, y));
  }
  return out;
};

/** One sample: is the line on a plate, and if so its colour, the picture around it, its letters, padding and corner cut. */
export const plateOf = (f: Frame, box: Rect): PlateReading => {
  const h = box.y1 - box.y0;
  const max = Math.round(1.2 * h);
  const pads = { top: edgeBeyond(f, box, 'top', max), bottom: edgeBeyond(f, box, 'bottom', max), left: edgeBeyond(f, box, 'left', max), right: edgeBeyond(f, box, 'right', max) };
  const edges = pads.top !== undefined && pads.bottom !== undefined && pads.left !== undefined && pads.right !== undefined;
  // Without four edges, the ring just around the box stands in for a plate, to be found not one.
  const pad = { top: pads.top ?? 2, bottom: pads.bottom ?? 2, left: pads.left ?? 2, right: pads.right ?? 2 };
  const plate = { x0: box.x0 - pad.left, y0: box.y0 - pad.top, x1: box.x1 + pad.right, y1: box.y1 + pad.bottom };
  const within = ring(f, box, { ...plate, x0: plate.x0 + 1, y0: plate.y0 + 1, x1: plate.x1 - 1, y1: plate.y1 - 1 });
  const colour = medianRgb(f, within.length ? within : ring(f, box, grow(box, 2))), lab = toLab(colour);
  const outside = ring(f, grow(plate, 2), grow(plate, Math.max(3, Math.round(0.4 * h))));
  const around = medianRgb(f, outside), aroundLab = toLab(around);
  const spread = spreadOf(f, within, lab);
  const isPlate = edges && within.length > 0 && outside.length > 0 && spread <= Math.max(6, 0.6 * spreadOf(f, outside, aroundLab)) && deltaE(lab, aroundLab) >= 12;
  // The letters: the pixels of the box farthest from the plate in lightness, a tenth of them (light letters on a dark plate).
  const px = area(f, box).sort((a, b) => (f.lab[3 * a] ?? 0) - (f.lab[3 * b] ?? 0));
  const tenth = Math.max(1, Math.round(px.length / 10));
  const ink = lab[0] < 50 ? px.slice(px.length - tenth) : px.slice(0, tenth);
  const letters = ink.filter((i) => deltaE(labOf(f, i), lab) > 35);
  return {
    plate: isPlate, colour, around, ...(letters.length >= ink.length / 2 ? { letters: medianRgb(f, letters) } : {}),
    pad: (pad.left + pad.right) / 2, cut: cornerCut(f, plate, lab, Math.max(10, 2.5 * spread)), height: h, pairs: isPlate ? edgePairs(f, plate) : [],
  };
};

/**
 * A see-through plate: seen = opacity x colour + (1 - opacity) x what is behind it. Just inside the plate's edge, what
 * is behind is nearly what is seen just outside it, so the pixels across the edge are fitted, inside against outside,
 * one slope for the three channels: the slope is how much shows through. When the picture along the edges hardly
 * changes, the opacity cannot be told and the plate is taken as it is seen.
 */
const plateColour = (pairs: [Rgb, Rgb][], seen: Rgb[]): { colour: Rgb; opacity?: number } => {
  const typical = CHANNELS.map((c) => median(seen.map((s) => s[c]))) as Rgb;
  const mean = (c: Channel, side: 0 | 1): number => pairs.reduce((n, p) => n + p[side][c], 0) / Math.max(1, pairs.length);
  let cov = 0, vary = 0;
  for (const c of CHANNELS) {
    const mi = mean(c, 0), mo = mean(c, 1);
    for (const [a, b] of pairs) { cov += (a[c] - mi) * (b[c] - mo); vary += (b[c] - mo) ** 2; }
  }
  if (pairs.length < 30 || vary / pairs.length < 3 * 15 * 15) return { colour: typical };
  const slope = clamp(cov / vary, 0, 0.85);
  const colour = CHANNELS.map((c) => clamp((mean(c, 0) - slope * mean(c, 1)) / (1 - slope), 0, 255)) as Rgb;
  return { colour, opacity: Math.round((1 - slope) * 20) / 20 };
};

/** The plate's look from the samples that showed one. */
const plateLook = (n: number, plates: PlateReading[]): CaptionLook => {
  const fit = plateColour(plates.flatMap((p) => p.pairs), plates.map((p) => p.colour));
  const font = median(plates.map((p) => p.height)) * FONT_OF_BOX;
  // The letters: the colour most samples agree on, and how many do.
  const seen = plates.flatMap((p) => (p.letters ? [toLab(p.letters)] : []));
  const mid = seen.length ? labMedian(seen) : undefined;
  const alike = mid ? seen.filter((l) => deltaE(l, mid) <= 15).length / plates.length : 0;
  const letters = mid ? plates.flatMap((p) => (p.letters && deltaE(toLab(p.letters), mid) <= 15 ? [p.letters] : [])) : [];
  const confidence = r2(alike);
  // A rounded corner of radius r leaves r (1 - 1/sqrt 2) uncovered along the diagonal.
  const radius = median(plates.map((p) => p.cut)) / (1 - Math.SQRT1_2);
  const unsure = [
    ...(confidence < SURE ? ['fill: the letters on the plate were not one colour from line to line, so their colour is not given'] : []),
    ...(fit.opacity === undefined ? ['opacity: the picture around the plate hardly changed, so the plate is taken as it is seen'] : []),
  ];
  return {
    kind: 'plate', ...(confidence >= SURE ? { color: toHex(rgbMedian(letters)) } : {}), confidence, samples: n,
    plate: { color: toHex(fit.colour), opacity: fit.opacity ?? 1, padding: r2(clamp(median(plates.map((p) => p.pad)) / font, 0.05, 1.5)), radius: r2(clamp(radius / font, 0, 1)), confidence: r2(plates.length / n) },
    ...(unsure.length ? { unsure } : {}),
  };
};

/**
 * Letters without a plate, as small or soft video shows them (core.ts): the fill is the core of the strokes, not the
 * blend at their edges; the outline's colour is its far end from the fill; the weight is the stroke's width; and a
 * shadow under an outline is kept beside it.
 */
const refined = (frames: Frame[], boxes: Rect[], { look, fill, part }: Letters): CaptionLook => {
  if (!fill || look.kind === 'plate') return look;
  const core = look.color ? coreOf(frames, boxes, fill.group.at, fill.around) : undefined;
  const coreLab = core && core.share >= SURE ? core.lab : fill.group.lab;
  const edge = part?.edge ?? [...fill.edges.up, ...fill.edges.down, ...fill.edges.left, ...fill.edges.right];
  const far = look.kind === 'outline' && look.outline?.color ? farEnd(edge, coreLab) : undefined;
  const weight = weightOf(frames, boxes, coreLab, far?.lab ?? fill.around, part?.lines);
  const under = look.kind === 'outline' && fill.shadowBeyond ? { shadow: { confidence: r2(fill.group.lines / frames.length) } } : {};
  return {
    ...look,
    ...(core && core.share >= SURE && look.color ? { color: toHex(core.rgb) } : {}),
    ...(far && look.outline ? { outline: { ...look.outline, color: toHex(far.rgb) } } : {}),
    ...under,
    ...(weight ?? {}),
  };
};

const shared = (h: CaptionHighlight | undefined, n: number): CaptionHighlight | undefined => (h ? { ...h, share: r2(h.lines / Math.max(1, n)) } : undefined);

/**
 * The look of the captions from frames already taken out, one per caption line, with each line's box in pixels and
 * what the reader read on it (for the words a highlight covers).
 */
export const lookOf = (frames: Frame[], boxes: Rect[], texts: string[] = []): CaptionLook | undefined => {
  if (frames.length < MIN_SAMPLES) return undefined;
  const readings = frames.map((f, k) => plateOf(f, boxes[k] as Rect));
  const plates = readings.filter((r) => r.plate);
  const around = pictureAround(frames, boxes);
  // A colour on a sixth of the lines can still be a highlight (one line in four or five has one in many videos).
  const candidates = candidatesOf(frames, boxes, Math.max(2, Math.ceil(frames.length / 6)));
  if (plates.length >= PLATE_SHARE * readings.length) {
    const look = plateLook(frames.length, plates);
    const fill = readings.map((r) => (r.plate && r.letters ? toLab(r.letters) : undefined));
    // The plate as it is seen, the picture showing through it, is what surrounds the letters.
    const highlight = shared(highlightOf(frames, boxes, texts, { fill, around: labMedian(plates.map((p) => toLab(p.colour))) }, candidates, around), frames.length);
    return highlight ? { ...look, highlight } : look;
  }
  const letters = lettersOf(frames, boxes, candidates, around);
  const { fill } = letters;
  const look = refined(frames, boxes, letters);
  const ctx = fill ? { fill: fill.group.at, px: fill.px, ...(look.kind === 'outline' || look.kind === 'plate' ? { around: fill.around } : {}) } : undefined;
  const highlight = shared(ctx ? highlightOf(frames, boxes, texts, ctx, candidates, around) : undefined, frames.length);
  return highlight ? { ...look, highlight } : look;
};

/** The caption lines to look at: up to MAX_SAMPLES, the longest first, each at a frame the reader read in its middle. */
const samplesOf = (track: TextTrack): { cue: TextCue; frame: number }[] => {
  const step = Math.max(1, track.step);
  return track.cues.filter((c) => c.role === 'caption').sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start).slice(0, MAX_SAMPLES)
    .map((cue) => ({ cue, frame: clamp(Math.round((cue.start + cue.end) / 2 / step) * step, cue.start, Math.max(cue.start, cue.end - 1)) }))
    .sort((a, b) => a.frame - b.frame);
};

/** The frames of a video's caption lines (one each, cropped to the band they sit in) and each line's box in them, in pixels. */
export const captionFrames = async (rt: Runtime, video: string, track: TextTrack): Promise<{ frames: Frame[]; boxes: Rect[]; texts: string[] }> => {
  const picked = samplesOf(track);
  if (picked.length < MIN_SAMPLES) return { frames: [], boxes: [], texts: [] };
  const info = await probe(rt, video);
  const W = info.width, H = info.height;
  const size = median(picked.map((p) => p.cue.box[3])) * H;
  const top = Math.max(0, Math.floor(Math.min(...picked.map((p) => p.cue.box[1])) * H - 2.5 * size));
  const bottom = Math.min(H, Math.ceil(Math.max(...picked.map((p) => p.cue.box[1] + p.cue.box[3])) * H + 2.5 * size));
  const h = bottom - top;
  const frames = [...new Set(picked.map((p) => p.frame))];
  const colour = await readColour(rt, video, info);
  const select = "select='" + frames.map((n) => 'eq(n,' + n + ')').join('+') + "'";
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-vf', select + ',scale=' + W + ':' + H + ':in_color_matrix=' + colour.matrix + ':in_range=' + colour.range + ':flags=accurate_rnd,format=rgb24,crop=' + W + ':' + h + ':0:' + top, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const bytes = W * h * 3;
  const decoded = new Map(frames.map((n, k) => [n, r.stdout.subarray(k * bytes, (k + 1) * bytes)] as const));
  const out: { frames: Frame[]; boxes: Rect[]; texts: string[] } = { frames: [], boxes: [], texts: [] };
  for (const p of picked) {
    const rgb = decoded.get(p.frame);
    if (!rgb || rgb.length < bytes) continue;
    const lab = new Float32Array(W * h * 3);
    for (let i = 0; i < W * h; i++) lab.set(toLab([rgb[3 * i] ?? 0, rgb[3 * i + 1] ?? 0, rgb[3 * i + 2] ?? 0]), 3 * i);
    out.frames.push({ w: W, h, rgb, lab });
    const [x, y, bw, bh] = p.cue.box;
    out.boxes.push({ x0: Math.round(x * W), y0: Math.round(y * H) - top, x1: Math.round((x + bw) * W), y1: Math.round((y + bh) * H) - top });
    out.texts.push(p.cue.text);
  }
  return out;
};

/**
 * The look of a video's captions, from the frames of its caption lines; undefined with fewer than MIN_SAMPLES lines.
 * The frames are taken at the video's own size, cropped to the band the lines sit in with room around it.
 */
export const measureCaptionLook = async (rt: Runtime, video: string, track: TextTrack): Promise<CaptionLook | undefined> => {
  const { frames, boxes, texts } = await captionFrames(rt, video, track);
  const look = lookOf(frames, boxes, texts);
  if (!look) return undefined;
  const reveal = await measureReveal(rt, video, track, look);
  return reveal ? { ...look, reveal } : look;
};
