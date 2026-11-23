/**
 * The clips and pictures a project lays over a scene (its video and image items, "Footage inside a scene" in
 * video-scenes.md), as the scene check sees them. The page draws them over the scene, so they are in the check's
 * pictures, but footage shades smoothly into the frame it sits in, as photographs do, and the measure of what stands
 * out from the ground (measure/fill.ts) would grow the ground into it. They are what the shot shows, so the check counts
 * their boxes as standing out whatever their pixels. Pure.
 */
import { inRegion, type Region } from '../measure/fill';
import { itemStateAt } from '../timeline/frame';
import type { Resolved, ResolvedItem } from '../types';

/** An item entering or leaving counts from this opacity on. */
const VISIBLE = 0.5;
/** Points along the canvas' longer side at which the share it covers is sampled. */
const SAMPLES = 200;

/**
 * Where a video or image item is on frame n, in fractions of the canvas: its box with its motion's clip, scale and
 * offset (its rotation left out), its corners or its ellipse; undefined when it is not on screen there or too faint.
 */
export const itemRegion = (r: Resolved, item: ResolvedItem, n: number): Region | undefined => {
  if (item.type !== 'video' && item.type !== 'image') return undefined;
  const s = itemStateAt(item, n);
  if (!s || s.opacity < VISIBLE) return undefined;
  const { width: W, height: H } = r.canvas;
  const [x, y, w, h] = item.box;
  const [top, right, bottom, left] = s.clip;
  // The clip hides parts of the item's own box; the scale is about the box's centre, the offset in the canvas' smaller side.
  const cx = x + w / 2 + (s.translate[0] * Math.min(W, H)) / W, cy = y + h / 2 + (s.translate[1] * Math.min(W, H)) / H;
  const x0 = cx + (w * left - w / 2) * s.scale, x1 = cx + (w / 2 - w * right) * s.scale;
  const y0 = cy + (h * top - h / 2) * s.scale, y1 = cy + (h / 2 - h * bottom) * s.scale;
  if (x1 <= Math.max(0, x0) || y1 <= Math.max(0, y0) || x0 >= 1 || y0 >= 1) return undefined;
  const ellipse = item.mask === 'ellipse' || item.shape === 'ellipse';
  const radius = (item.radius ?? 0) * Math.min(w * W, h * H) * s.scale;
  return { box: [x0, y0, x1 - x0, y1 - y0], ...(ellipse ? { ellipse } : radius > 0 ? { radius } : {}) };
};

/** The share of a canvas width x height that the regions cover together, 0..1, sampled on a grid. */
export const coverOf = (regions: readonly Region[], width: number, height: number): number => {
  if (!regions.length) return 0;
  const step = Math.max(width, height) / SAMPLES;
  let all = 0, inside = 0;
  for (let y = step / 2; y < height; y += step) for (let x = step / 2; x < width; x += step) {
    all++;
    if (regions.some((g) => inRegion(g, x, y, width, height))) inside++;
  }
  return inside / Math.max(1, all);
};

/** The video and image items on screen on frame n: where each is, how many, and the share of the canvas they cover. */
export interface ItemsOver { regions: Region[]; count: number; cover: number }

export const itemsOver = (r: Resolved, n: number): ItemsOver => {
  const regions = r.items.flatMap((item) => { const g = itemRegion(r, item, n); return g ? [g] : []; });
  return { regions, count: regions.length, cover: coverOf(regions, r.canvas.width, r.canvas.height) };
};
