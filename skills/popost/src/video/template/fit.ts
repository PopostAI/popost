/**
 * How a picture or footage fill sits in its shot. "cover" (the default) fills the shot and crops what lies outside it;
 * "contain" shows the whole material on a ground. Material made at other proportions than the canvas (a screenshot,
 * a page recorded at another size) loses its edges under cover, text included, and nothing fails: these warnings say
 * so before anything is rendered, with the numbers and the two ways out. Material much smaller than the shot is
 * blown up and looks soft; that is said too. Shown whole with "contain", the rest of the shot is a plain ground: a
 * portrait clip alone in the middle of an empty landscape shot. That is said too, with the way to design the shot.
 */
import type { Runtime } from '../../runtime';
import { decodeFrames } from '../media/decode';
import { probe } from '../media/ffmpeg';
import { deltaE, toLab } from '../measure/colour';
import { toHex } from '../measure/pixels';
import { warning } from '../project/check-common';
import type { Problem } from '../types';

/** Cover may cut this share of the material's width or height before it is worth a warning: about a tenth. */
export const CROP_LIMIT = 0.1;
/** Shown at more than this many times its own pixels, a material looks soft. */
export const BLOW_UP_LIMIT = 1.5;

export type FitMode = 'cover' | 'contain';
interface Size { width: number; height: number }

/** How a material of size m sits in a shot of size c: its scale, and the share of it cover cuts or of the shot contain leaves to the ground. */
export interface Placement {
  fit: FitMode;
  /** Shown size over the material's own size. */
  scale: number;
  /** Which way the proportions differ: the material is wider than the shot, or taller. Absent when they agree. */
  wider?: boolean;
  /** cover: the share of the material's width (wider) or height cut off, both sides together. */
  cut: number;
  /** contain: the share of the shot's height (wider) or width left to the ground, both sides together. */
  ground: number;
}

export const placementOf = (m: Size, c: Size, fit: FitMode): Placement => {
  const sx = c.width / m.width, sy = c.height / m.height;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const shown = { width: m.width * scale, height: m.height * scale };
  const ratio = m.width / m.height / (c.width / c.height);
  const wider = Math.abs(ratio - 1) < 1e-3 ? undefined : ratio > 1;
  const cut = fit === 'cover' ? (wider ? 1 - c.width / shown.width : 1 - c.height / shown.height) : 0;
  const ground = fit === 'contain' ? (wider ? 1 - shown.height / c.height : 1 - shown.width / c.width) : 0;
  return { fit, scale, ...(wider === undefined ? {} : { wider }), cut: wider === undefined ? 0 : Math.max(0, cut), ground: wider === undefined ? 0 : Math.max(0, ground) };
};

const pct = (v: number): string => Math.round(v * 100) + '%';
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** "4:3, for example 960x720" when the proportions have small terms, else the size. */
const proportions = (c: Size): string => {
  const g = gcd(c.width, c.height);
  const a = c.width / g, b = c.height / g;
  return a <= 32 && b <= 32 ? a + ':' + b + ', for example ' + c.width + 'x' + c.height : c.width + 'x' + c.height;
};

/**
 * The colour along a material's edges when most of the edge is one colour (a page's ground, a plain backdrop): a
 * ground of that colour joins the material under contain. undefined when the edges are mixed.
 */
export const edgeColour = (rgb: Uint8Array, w: number, h: number): string | undefined => {
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x > 1 && y > 1 && x < w - 2 && y < h - 2) continue;
    const i = (y * w + x) * 3;
    const r = rgb[i] ?? 0, g = rgb[i + 1] ?? 0, b = rgb[i + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bins.set(key, { n: bin.n + 1, sum: [bin.sum[0] + r, bin.sum[1] + g, bin.sum[2] + b] });
    total++;
  }
  const top = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  if (!top) return undefined;
  const colour = top.sum.map((v) => v / top.n);
  // Neighbouring bins of nearly the same colour count with it (a gradient a level wide, JPEG noise).
  const lab = toLab(colour);
  const near = [...bins.values()].filter((b) => deltaE(toLab(b.sum.map((v) => v / b.n)), lab) < 6).reduce((n, b) => n + b.n, 0);
  return near / Math.max(1, total) >= 0.7 ? toHex(colour) : undefined;
};

const firstFrameEdge = async (rt: Runtime, file: string, frame: number): Promise<string | undefined> => {
  const d = await decodeFrames(rt, file, { width: 64, gray: false, startFrame: frame, frameCount: 1 }).catch(() => undefined);
  const f = d?.frames[0];
  return d && f ? edgeColour(f, d.width, d.height) : undefined;
};

export interface FitInput {
  /** The fill's JSON path of the shot, its key ("picture" or "footage") and the path as the fill writes it. */
  at: string;
  key: 'picture' | 'footage';
  name: string;
  /** The file on disk, the fill's fit and ground, and for footage the first frame shown. */
  file: string;
  fit?: unknown;
  ground?: unknown;
  frame?: number;
}

/** Warnings about how a picture or footage fill will sit in a shot of the canvas: cropped by cover, or blown up. */
export const fitProblems = async (rt: Runtime, canvas: Size, o: FitInput): Promise<Problem[]> => {
  // A vector picture scales without loss and ffmpeg does not read it; one that cannot be read is reported elsewhere.
  if (o.file.toLowerCase().endsWith('.svg')) return [];
  const m = await probe(rt, o.file).catch(() => undefined);
  if (!m || !(m.width > 0 && m.height > 0)) return [];
  const fit: FitMode = o.fit === 'contain' ? 'contain' : 'cover';
  const p = placementOf(m, canvas, fit);
  const what = '"' + o.name + '" is ' + m.width + 'x' + m.height + ' in a ' + canvas.width + 'x' + canvas.height + ' shot';
  const out: Problem[] = [];
  if (p.cut > CROP_LIMIT) {
    const sides = p.wider ? 'its left and its right' : 'its top and its bottom';
    const bands = p.wider ? 'above and below it' : 'left and right of it';
    const contain = placementOf(m, canvas, 'contain');
    const given = typeof o.ground === 'string' && o.ground.trim() ? o.ground.trim() : undefined;
    const edge = given ? undefined : await firstFrameEdge(rt, o.file, o.frame ?? 0);
    const ground = given ? 'its "ground" ' + given
      : 'the default black ground' + (edge ? ', or add "ground": "' + edge + '", the colour along its edges, so that the bands join it' : ', or add "ground": "#rrggbb"');
    out.push(warning(o.at + '.fit',
      what + ': "cover" fills the shot and cuts ' + pct(p.cut / 2) + ' off ' + sides + ' (' + pct(p.cut) + ' of its ' + (p.wider ? 'width' : 'height') + '), with whatever text is there.',
      'Use material made at the canvas\'s proportions (' + proportions(canvas) + '), or write "fit": "contain" to show it whole: it then leaves ' + pct(contain.ground / 2) + ' of the shot ' + bands + ' on ' + ground + '.'));
  }
  if (fit === 'contain' && p.ground > CROP_LIMIT) {
    const bands = p.wider ? 'above and below it' : 'left and right of it';
    const ground = typeof o.ground === 'string' && o.ground.trim() ? 'its "ground" ' + o.ground.trim() : 'the default black ground';
    out.push(warning(o.at + '.fit',
      what + ': "contain" shows it whole and leaves ' + pct(p.ground) + ' of the shot ' + bands + ' to ' + ground + ', a bare ground beside it.',
      'Design the shot instead: make it a scene that draws a ground and a frame, and show "' + o.name + '" in it as ' + (o.key === 'footage' ? 'a video' : 'an image') + ' item in a box of its proportions (' + proportions(m) + ') (video-scenes.md, "A screen inside a scene"); or use material made at the canvas\'s proportions (' + proportions(canvas) + ').'));
  }
  if (p.scale > BLOW_UP_LIMIT) {
    out.push(warning(o.at + '.' + o.key,
      what + ': "' + fit + '" shows it at ' + p.scale.toFixed(1) + ' times its size, so it will look soft.',
      'Use a file of at least ' + Math.round(m.width * p.scale) + 'x' + Math.round(m.height * p.scale) + ' pixels (the size it is shown at)' + (o.key === 'footage' ? ', for a capture record at that size' : '') + ', or show it smaller in a scene.'));
  }
  return out;
};

/** An item's file (fill.json "items") in its box: cropped by cover, or blown up; contain leaves the scene round it, which is fine. */
export const itemFitProblems = async (rt: Runtime, canvas: Size, o: { at: string; key: 'video' | 'image'; name: string; file: string; box: readonly number[]; fit?: unknown }): Promise<Problem[]> => {
  if (o.file.toLowerCase().endsWith('.svg')) return [];
  const m = await probe(rt, o.file).catch(() => undefined);
  const [x = 0, y = 0, w = 0, h = 0] = o.box;
  if (!m || !(m.width > 0 && m.height > 0) || !(w > 0 && h > 0)) return [];
  const box = { width: Math.round(w * canvas.width), height: Math.round(h * canvas.height) };
  const fit: FitMode = o.fit === 'contain' ? 'contain' : 'cover';
  const p = placementOf(m, box, fit);
  const what = '"' + o.name + '" is ' + m.width + 'x' + m.height + ' in a ' + box.width + 'x' + box.height + ' box';
  const out: Problem[] = [];
  if (p.cut > CROP_LIMIT) {
    const width = Math.round(((box.height * m.width) / m.height / canvas.width) * 10000) / 10000;
    out.push(warning(o.at + '.fit', what + ': "cover" fills the box and cuts ' + pct(p.cut / 2) + ' off ' + (p.wider ? 'its left and its right' : 'its top and its bottom') + ' (' + pct(p.cut) + ' of its ' + (p.wider ? 'width' : 'height') + ').',
      'Give the box the file\'s proportions (' + proportions(m) + '): at this height, "box": [' + [x, y, width, h].join(', ') + '], and draw the frame round it in the scene; or "fit": "contain" (the scene shows round it).'));
  }
  if (p.scale > BLOW_UP_LIMIT)
    out.push(warning(o.at + '.' + o.key, what + ': "' + fit + '" shows it at ' + p.scale.toFixed(1) + ' times its size, so it will look soft.', 'Use a file of at least ' + Math.round(m.width * p.scale) + 'x' + Math.round(m.height * p.scale) + ' pixels, or a smaller box.'));
  return out;
};
