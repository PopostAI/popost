/**
 * Whether a caption stands out from what is behind it. A text reader is no judge of that: on synthetic renders it read
 * white letters on a #f5f5f5 page (1.1:1) and black letters over a page full of black text, which a viewer barely
 * makes out. So the frame is measured as a viewer's eye takes it, against the colour the project gives the letters:
 * - What is behind the letters: an outline at least a pixel wide outside the glyphs (half of style.stroke) is; else
 *   the pixels of the frame in a ring around the line (ringOf), which are the plate when the caption has one, as it
 *   was drawn, and the picture when it has none. A shadow does not count: white letters with a soft dark shadow over
 *   a page of text were as hard to make out as without it (the reader missed three of four).
 * - A reading is a caption in one frame: the median WCAG contrast ratio of the letters to the ring, the share of the
 *   ring under LOW_CONTRAST, and how busy the ring is (changes between "about as light as the letters" and "not" per
 *   em along its rows). Three samples per caption and shot; the median of each counts.
 * - A caption does not stand out when its median ratio is under CALM, the share is PART or more, or the ring is BUSY
 *   or busier: one warning per shot, with the worst caption.
 * Thresholds, from 78 synthetic captions (1280x720, bold CJK at 4 to 6.5% of the height; plain white, black and
 * yellow, an outline, two plates, a shadow; over flat colours, pages full of text at 14, 20 and 28 px, a white window
 * with text over a dark desktop, a sky, colourful blocks), judged by eye on full-size crops:
 * - letters and background of about one colour came out at 1.0 to 2.1:1, yellow on mid grey or over the colourful
 *   blocks (weak but readable) at 2.84, white on mid grey (fine) at 4.06: CALM is 3, WCAG's ratio for large text;
 * - page text running behind or through a plain caption gave 0.78 to 5.95 changes per em, flat backgrounds and a
 *   caption on a dark band under a window full of text 0, the colourful blocks 0.19 to 0.23: BUSY is 0.6;
 * - plain white or black over the colourful blocks (readable) left 25 to 28% of the ring under 3:1; a caption half
 *   over a light area and half over a dark one leaves about half, which the median alone may pass: PART is 0.4.
 * The reader read 19 of the 41 captions warned about. One warning is too strict: white letters with a soft shadow
 *   over a light sky (1.79:1) read well.
 */
import type { Runtime } from '../../runtime';
import { readColour } from '../media/decode';
import { probe, runFfmpegOk } from '../media/ffmpeg';
import type { Problem, Resolved, ResolvedItem } from '../types';

/** A pixel this close to the letters' colour (WCAG ratio) does not set them apart. */
export const LOW_CONTRAST = 3;
/** Under this median ratio to what is behind them, the letters are drawn too close to its colour. */
export const CALM = 3;
/** From this share of what is around them under LOW_CONTRAST, the letters sit in part on something like themselves. */
export const PART = 0.4;
/** From this many changes per em around the line, text or fine detail of the picture runs behind it. */
export const BUSY = 0.6;
/** Samples per caption and shot, spread over the time it is up. */
const SAMPLES = 3;

type Rgb = [number, number, number];
export interface Rgba { rgb: Rgb; alpha: number }

const NAMED: Readonly<Record<string, Rgba>> = {
  black: { rgb: [0, 0, 0], alpha: 1 }, white: { rgb: [255, 255, 255], alpha: 1 }, red: { rgb: [255, 0, 0], alpha: 1 }, green: { rgb: [0, 128, 0], alpha: 1 },
  blue: { rgb: [0, 0, 255], alpha: 1 }, yellow: { rgb: [255, 255, 0], alpha: 1 }, orange: { rgb: [255, 165, 0], alpha: 1 }, purple: { rgb: [128, 0, 128], alpha: 1 },
  pink: { rgb: [255, 192, 203], alpha: 1 }, gray: { rgb: [128, 128, 128], alpha: 1 }, grey: { rgb: [128, 128, 128], alpha: 1 }, transparent: { rgb: [0, 0, 0], alpha: 0 },
};

const hsl = (h: number, s: number, l: number): Rgb => {
  const k = (n: number): number => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number): number => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
};

/** A colour the project schema accepts (hex, rgb(), rgba(), hsl(), hsla(), a few names); undefined for anything else. */
export const parseColour = (text: string): Rgba | undefined => {
  const s = text.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? Array.from(hex).map((c) => c + c).join('') : hex;
    const n = (i: number): number => parseInt(full.slice(2 * i, 2 * i + 2), 16);
    return { rgb: [n(0), n(1), n(2)], alpha: full.length === 8 ? n(3) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s);
  if (!fn) return undefined;
  const parts = (fn[2] ?? '').split(/[\s,/]+/).filter(Boolean);
  const num = (p: string | undefined, scale: number): number => (p === undefined ? NaN : p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
  const rgb: Rgb = (fn[1] ?? '').startsWith('rgb')
    ? [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)]
    : hsl(parseFloat(parts[0] ?? ''), num(parts[1], 1), num(parts[2], 1));
  return [...rgb, alpha].every(Number.isFinite) ? { rgb: rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as Rgb, alpha: Math.max(0, Math.min(1, alpha)) } : undefined;
};

const linear = (c: number): number => (c <= 10.31475 ? c / 3294.6 : ((c / 255 + 0.055) / 1.055) ** 2.4);
/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export const luminance = (c: readonly number[]): number => 0.2126 * linear(c[0] ?? 0) + 0.7152 * linear(c[1] ?? 0) + 0.0722 * linear(c[2] ?? 0);
/** The WCAG contrast ratio of two luminances, 1 (the same) to 21 (black on white). */
export const ratioOf = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const WIDE = /[\u{1100}-\u{11ff}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7af}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ffef}]/u;
/** Ems of a character that is not full-width, set wide so that the line's ends stay out of the ring. */
const NARROW_EM = 0.6;

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Where the glyphs of a text item are, in pixels of the canvas: its lines set in its box, centred across it, aligned along it. */
export const textExtent = (item: ResolvedItem, canvas: { width: number; height: number }): Rect | undefined => {
  const style = item.style;
  const text = (item.text ?? '').trim();
  if (!style || !text) return undefined;
  const em = style.size * canvas.height;
  const [bx, by, bw, bh] = item.box.map((v, i) => v * (i % 2 ? canvas.height : canvas.width)) as [number, number, number, number];
  const lines = text.split('\n');
  const widths = lines.map((l) => Array.from(l).reduce((n, c) => n + (WIDE.test(c) ? 1 : NARROW_EM) + (style.letterSpacing ?? 0), 0) * em);
  const rows = widths.reduce((n, w) => n + Math.max(1, Math.ceil(w / bw)), 0);
  const width = Math.min(bw, Math.max(...widths));
  const height = ((rows - 1) * (style.lineHeight ?? 1.25) + 1) * em;
  const x0 = style.align === 'left' ? bx : style.align === 'right' ? bx + bw - width : bx + (bw - width) / 2;
  const y0 = by + (bh - height) / 2;
  return { x0, y0, x1: x0 + width, y1: y0 + height };
};

export type Behind = 'outline' | 'shadow' | 'plate' | 'picture';

/** How a caption is drawn apart from the picture: an outline wide enough to see, a plate, a tight shadow (measured as the picture), or none. */
export const behindOf = (item: ResolvedItem, canvas: { height: number }): { behind: Behind; colour?: Rgba; pad: number } => {
  const style = item.style, em = (style?.size ?? 0) * canvas.height;
  const stroke = style?.stroke ? parseColour(style.stroke.color) : undefined;
  if (style?.stroke && stroke && stroke.alpha > 0.5 && (style.stroke.width / 2) * em >= 1) return { behind: 'outline', colour: stroke, pad: 0 };
  const shadow = style?.shadow ? parseColour(style.shadow.color) : undefined;
  if (style?.shadow && shadow && shadow.alpha > 0.5 && style.shadow.blur <= 0.3) return { behind: 'shadow', colour: shadow, pad: 0 };
  const plate = style?.background ? parseColour(style.background.color) : undefined;
  if (style?.background && plate && plate.alpha > 0) return { behind: 'plate', colour: plate, pad: (style.background.padding ?? 0.25) * em };
  return { behind: 'picture', pad: 0 };
};

/**
 * The ring around a line where what is behind its letters is read: from just past its glyphs to half an em above and
 * below and an em to each side (where a line of the picture's own text that runs through the caption shows), or the
 * inside of its plate when it has one.
 */
export const ringOf = (extent: Rect, em: number, pad: number): { inner: Rect; outer: Rect } => {
  const grow = (dx: number, dy = dx): Rect => ({ x0: extent.x0 - dx, y0: extent.y0 - dy, x1: extent.x1 + dx, y1: extent.y1 + dy });
  const start = pad ? Math.min(0.1 * em, pad / 3) : Math.max(2, 0.12 * em);
  const near = pad ? Math.max(start + 1, 0.9 * pad) : Math.max(start + 4, 0.5 * em);
  return { inner: grow(start), outer: pad ? grow(near) : grow(Math.max(start + 4, em), near) };
};

export interface ContrastReading {
  /** Median WCAG ratio of the letters to the ring, and the share of the ring under LOW_CONTRAST. */
  ratio: number;
  low: number;
  /** Changes between "about as light as the letters" and "not", per em along the rows of the ring: text or fine detail behind the line. */
  busy: number;
}

/**
 * The contrast of a caption over a frame (rgb rows from top, width w; rectangles in the frame's pixels). Letters drawn
 * at an opacity under 1 are blended with each pixel. With an outline, the outline is what is behind.
 */
export const readContrast = (o: { rgb: Uint8Array; w: number; h: number; top: number; letters: Rgba; opacity: number; inner: Rect; outer: Rect; em: number; outline?: Rgba }): ContrastReading | undefined => {
  const a = o.letters.alpha * o.opacity;
  const ratioTo = (bg: readonly number[]): number => ratioOf(luminance([0, 1, 2].map((c) => a * (o.letters.rgb[c] ?? 0) + (1 - a) * (bg[c] ?? 0))), luminance(bg));
  if (o.outline) {
    const r = ratioTo(o.outline.rgb);
    return { ratio: Math.round(r * 100) / 100, low: r < LOW_CONTRAST ? 1 : 0, busy: 0 };
  }
  const ratios: number[] = [];
  let changes = 0;
  const y0 = Math.max(o.top, Math.round(o.outer.y0)), y1 = Math.min(o.top + o.h, Math.round(o.outer.y1));
  const x0 = Math.max(0, Math.round(o.outer.x0)), x1 = Math.min(o.w, Math.round(o.outer.x1));
  for (let y = y0; y < y1; y++) {
    let last: boolean | undefined;
    for (let x = x0; x < x1; x++) {
      if (x >= o.inner.x0 && x < o.inner.x1 && y >= o.inner.y0 && y < o.inner.y1) { last = undefined; continue; }
      const i = 3 * ((y - o.top) * o.w + x);
      const r = ratioTo([o.rgb[i] ?? 0, o.rgb[i + 1] ?? 0, o.rgb[i + 2] ?? 0]);
      const like = r < LOW_CONTRAST;
      if (last !== undefined && like !== last) changes++;
      last = like;
      ratios.push(r);
    }
  }
  if (ratios.length < 20) return undefined;
  const n = ratios.length;
  ratios.sort((p, q) => p - q);
  return {
    ratio: Math.round((ratios[Math.floor(n / 2)] ?? 0) * 100) / 100,
    low: Math.round((ratios.filter((r) => r < LOW_CONTRAST).length / n) * 100) / 100,
    busy: Math.round(((changes * o.em) / n) * 100) / 100,
  };
};

/** One caption in one shot: what is behind its letters and how far they stand out, the median over its samples. */
export interface CaptionContrast {
  id: string;
  text: string;
  /** The shot (segments[i]) and the seconds of it the caption is up in. */
  at: string;
  seconds: [number, number];
  behind: Behind;
  /** Median WCAG ratio of the letters to what is behind them; share of that under LOW_CONTRAST. */
  ratio: number;
  low: number;
  /** Texture behind the line (ContrastReading.busy). */
  busy: number;
  samples: number;
}

interface Sample { item: ResolvedItem; segment: number; frame: number; seconds: [number, number] }

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** The frames to look at: SAMPLES per caption and shot it stays a second or more in, past its entrance and before its exit. */
export const contrastSamples = (resolved: Resolved, most = 120): Sample[] => {
  const { fps } = resolved.canvas;
  const parts = resolved.items.filter((i) => i.type === 'text' && i.cue && (i.text ?? '').trim()).flatMap((item) => resolved.segments.flatMap((s) => {
    const from = Math.max(s.start, item.start + item.enter.frames), to = Math.min(s.end, item.end - item.exit.frames);
    return Math.min(s.end, item.end) - Math.max(s.start, item.start) >= fps && to > from ? [{ item, segment: s.index, from, to, seconds: [r1(Math.max(s.start, item.start) / fps), r1(Math.min(s.end, item.end) / fps)] as [number, number] }] : [];
  }));
  const each = parts.length * SAMPLES <= most ? SAMPLES : 1;
  return parts.flatMap((p) => Array.from({ length: each }, (_, k) => ({ item: p.item, segment: p.segment, seconds: p.seconds, frame: Math.floor(p.from + ((k + 1) * (p.to - p.from)) / (each + 1)) })));
};

/** Measures every caption of a render against what is behind it (contrastSamples), one ffmpeg pass over the band the captions sit in. */
export const measureContrast = async (rt: Runtime, video: string, resolved: Resolved): Promise<CaptionContrast[]> => {
  const samples = contrastSamples(resolved);
  if (!samples.length) return [];
  const info = await probe(rt, video);
  const W = info.width, H = info.height, sx = W / resolved.canvas.width, sy = H / resolved.canvas.height;
  const scaled = (r: Rect): Rect => ({ x0: r.x0 * sx, y0: r.y0 * sy, x1: r.x1 * sx, y1: r.y1 * sy });
  const plans = samples.flatMap((s) => {
    const extent = textExtent(s.item, resolved.canvas), letters = parseColour(s.item.style?.color ?? '');
    if (!extent || !letters) return [];
    const how = behindOf(s.item, resolved.canvas), em = (s.item.style?.size ?? 0) * resolved.canvas.height;
    const ring = ringOf(extent, em, how.pad);
    return [{ ...s, how, letters, em: em * sy, inner: scaled(ring.inner), outer: scaled(ring.outer) }];
  });
  if (!plans.length) return [];
  const top = Math.max(0, Math.floor(Math.min(...plans.map((p) => p.outer.y0))));
  const bottom = Math.min(H, Math.ceil(Math.max(...plans.map((p) => p.outer.y1))));
  const h = bottom - top;
  if (h <= 0) return [];
  const frames = [...new Set(plans.map((p) => p.frame))].sort((a, b) => a - b);
  const colour = await readColour(rt, video, info);
  const select = "select='" + frames.map((n) => 'eq(n,' + n + ')').join('+') + "'";
  const out = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-vf', select + ',scale=' + W + ':' + H + ':in_color_matrix=' + colour.matrix + ':in_range=' + colour.range + ':flags=accurate_rnd,format=rgb24,crop=' + W + ':' + h + ':0:' + top, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  const bytes = W * h * 3;
  const at = new Map(frames.map((n, k) => [n, out.stdout.subarray(k * bytes, (k + 1) * bytes)] as const));
  const readings = plans.flatMap((p) => {
    const rgb = at.get(p.frame);
    const r = rgb && rgb.length === bytes ? readContrast({ rgb, w: W, h, top, letters: p.letters, opacity: p.item.style?.opacity ?? 1, inner: p.inner, outer: p.outer, em: p.em, ...(p.how.behind === 'outline' && p.how.colour ? { outline: p.how.colour } : {}) }) : undefined;
    return r ? [{ p, r }] : [];
  });
  const groups = new Map<string, typeof readings>();
  for (const x of readings) groups.set(x.p.item.id + '@' + x.p.segment, [...(groups.get(x.p.item.id + '@' + x.p.segment) ?? []), x]);
  const mid = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] ?? 0;
  return [...groups.values()].map((g) => {
    const p = (g[0] as (typeof readings)[number]).p;
    return { id: p.item.id, text: (p.item.text ?? '').trim(), at: 'segments[' + p.segment + ']', seconds: p.seconds, behind: p.how.behind, ratio: mid(g.map((x) => x.r.ratio)), low: mid(g.map((x) => x.r.low)), busy: mid(g.map((x) => x.r.busy)), samples: g.length };
  });
};

const clip = (t: string): string => (Array.from(t).length > 30 ? Array.from(t).slice(0, 30).join('') + '…' : t);
const pct = (v: number): string => Math.round(v * 100) + '%';

/** Whether a caption stands out from what is behind it (see the thresholds above). */
export const standsOut = (c: Pick<CaptionContrast, 'ratio' | 'low' | 'busy'>): boolean => c.ratio >= CALM && c.low < PART && c.busy < BUSY;

const FIX: Readonly<Record<Behind, string>> = {
  picture: 'Set the captions apart from the picture: a plate behind them (the caption style\'s background, such as rgba(0,0,0,0.6) behind white letters), an outline (stroke, width 0.12 or more), another colour, or move the band to a calm part of the frame, or frame the page so that the band lies on one (capture\'s --caption-band).',
  plate: 'Make the plate darker or lighter than the letters, or more opaque, or change the letters\' colour.',
  outline: 'Give the outline a colour far from the letters\' (dark around light letters, light around dark ones).',
  shadow: 'A shadow does not set letters apart from a picture this light or this busy: give them an outline (stroke, width 0.12 or more) or a plate, change their colour, or move the band to a calm part of the frame.',
};
const DRAWN: Readonly<Record<Behind, string>> = { picture: 'plain letters over the picture', plate: 'letters on a plate', outline: 'outlined letters', shadow: 'letters with a shadow' };

const whyNot = (c: CaptionContrast): string =>
  c.ratio < CALM ? 'its letters are ' + c.ratio + ':1 against what is behind them, under the ' + CALM + ':1 a viewer needs'
  : c.busy >= BUSY ? 'text or fine detail of the picture runs right behind it (' + c.busy + ' changes per em around the line, from ' + BUSY + ' it is busy)'
  : pct(c.low) + ' of what is right around its letters is under ' + LOW_CONTRAST + ':1 against them';

/** One warning per shot with a caption that does not stand out from what is behind it; the lowest ratio first. */
export const contrastProblems = (resolved: Resolved, captions: readonly CaptionContrast[]): Problem[] =>
  resolved.segments.flatMap((s): Problem[] => {
    const at = 'segments[' + s.index + ']';
    const weak = captions.filter((c) => c.at === at && !standsOut(c)).sort((a, b) => a.ratio - b.ratio || b.busy - a.busy);
    const worst = weak[0];
    if (!worst) return [];
    return [{
      level: 'warning', at,
      message: 'Shot ' + s.id + ' (' + worst.seconds[0] + '-' + worst.seconds[1] + ' s): ' + weak.length + ' caption(s) do not stand out from what is behind them. "' + clip(worst.text) + '" (' + DRAWN[worst.behind] + '): ' + whyNot(worst) + '.',
      fix: FIX[worst.behind],
    }];
  });

/** Per shot with captions, for the command's summary: how many, how many do not stand out, the lowest ratio and the busiest ring. */
export const contrastByShot = (captions: readonly CaptionContrast[]): { at: string; captions: number; weak: number; lowestRatio: number; busiest: number }[] => {
  const shots = [...new Set(captions.map((c) => c.at))];
  return shots.map((at) => {
    const of = captions.filter((c) => c.at === at);
    return { at, captions: of.length, weak: of.filter((c) => !standsOut(c)).length, lowestRatio: Math.min(...of.map((c) => c.ratio)), busiest: Math.max(...of.map((c) => c.busy)) };
  });
};
