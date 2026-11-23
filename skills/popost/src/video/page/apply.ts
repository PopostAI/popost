/**
 * applyFrame: sets the inline style of every segment layer, the overlay and every item from the frame number alone.
 * Each call writes every dynamic property (cssText is replaced whole), so no state of an earlier call survives. A video
 * layer's picture is the file of the source frame that frame n shows (timeline/footage.ts); a hidden one has none.
 */
import type { Resolved, ResolvedItem } from '../types';
import type { ElementState } from '../presets/motion';
import { charsShown } from '../presets/spoken';
import type { LayerClip } from '../presets/transition';
import { clampFrame, itemStateAt, segmentsAt, type LayerView } from '../timeline/frame';
import { frameUrl } from '../timeline/footage';
import type { ItemNode, SegmentNode, StageNodes } from './dom';
import { seekScene } from './scene';
import { applyWords } from './words';

const n4 = (v: number): string => String(Math.round(v * 1e4) / 1e4);
const px = (v: number): string => n4(v) + 'px';
const pct = (v: number): string => n4(v * 100) + '%';

interface Geometry { W: number; H: number; min: number; halfDiagonal: number }

const geometry = (r: Resolved): Geometry => ({
  W: r.canvas.width,
  H: r.canvas.height,
  min: Math.min(r.canvas.width, r.canvas.height),
  halfDiagonal: Math.hypot(r.canvas.width, r.canvas.height) / 2,
});

const insetCss = (clip: readonly number[]): string =>
  clip.every((c) => c <= 0) ? 'none' : 'inset(' + clip.map(pct).join(' ') + ')';

const clipCss = (clip: LayerClip, g: Geometry): string =>
  Array.isArray(clip) ? insetCss(clip) : 'circle(' + px(Math.max(0, clip.radius) * g.halfDiagonal) + ' at 50% 50%)';

const transformCss = (x: number, y: number, rotate: number, scale: number): string =>
  x === 0 && y === 0 && rotate === 0 && scale === 1 ? 'none' : 'translate(' + px(x) + ',' + px(y) + ') rotate(' + n4(rotate) + 'deg) scale(' + n4(scale) + ')';

const applyLayer = (node: SegmentNode, view: LayerView | undefined, g: Geometry): void => {
  if (!view) {
    node.layer.style.cssText = node.layerCss + 'display:none;';
    node.smear.setAttribute('stdDeviation', '0 0');
    if (node.img) node.img.style.cssText = node.imgCss;
    return;
  }
  const s = view.state;
  const smeared = s.smear[0] > 0 || s.smear[1] > 0;
  const filter = s.blur > 0 ? 'blur(' + px(s.blur * g.min) + ')' : smeared ? 'url(#' + node.filterId + ')' : 'none';
  node.layer.style.cssText = node.layerCss + 'display:block;z-index:' + (s.z + 1) + ';opacity:' + n4(s.opacity) +
    ';transform:' + transformCss(s.translate[0] * g.W, s.translate[1] * g.H, s.rotate, s.scale) + ';filter:' + filter + ';clip-path:' + clipCss(s.clip, g) + ';';
  node.smear.setAttribute('stdDeviation', n4(s.smear[0] * g.min) + ' ' + n4(s.smear[1] * g.min));
  const cam = view.camera;
  if (node.img) node.img.style.cssText = node.imgCss + 'transform:' + transformCss(cam.translate[0] * g.W, cam.translate[1] * g.H, 0, cam.scale) + ';';
};

/** The item's drop shadow (static) first, so a motion's blur softens the shadow too. */
const itemFilter = (node: ItemNode, blur: number, g: Geometry): string => {
  const parts = [node.shadow, blur > 0 ? 'blur(' + px(blur * g.min) + ')' : ''].filter((p) => p !== '');
  return parts.length > 0 ? parts.join(' ') : 'none';
};

const itemCss = (node: ItemNode, s: ElementState, g: Geometry): string =>
  node.css + 'display:' + node.display + ';opacity:' + n4(s.opacity) + ';transform:' + transformCss(s.translate[0] * g.min, s.translate[1] * g.min, s.rotate, s.scale) +
  ';filter:' + itemFilter(node, s.blur, g) + ';clip-path:' + insetCss(s.clip) + ';';

const applyItem = (node: ItemNode, item: ResolvedItem, s: ElementState | undefined, g: Geometry, n: number): void => {
  node.el.style.cssText = s ? itemCss(node, s, g) : node.css + 'display:none;';
  // Hidden characters keep their place in the layout (visibility, not display), so the text does not reflow.
  const shown = s ? charsShown(item, s, node.chars.length, n) : node.chars.length;
  if (node.words) applyWords(node.words, item, n, shown);
  else node.chars.forEach((c, i) => { c.style.visibility = i < shown ? 'visible' : 'hidden'; });
};

/**
 * Points a video picture at url, or at nothing. The attribute is compared first only so that the same picture is not
 * asked for again; which picture is shown depends on n alone.
 */
const setPicture = (img: HTMLImageElement | undefined, url: string | undefined, shown: HTMLImageElement[]): void => {
  if (!img) return;
  if (url === undefined) {
    if (img.hasAttribute('src')) img.removeAttribute('src');
    return;
  }
  if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  shown.push(img);
};

/** Puts the whole picture in the state of frame n. Returns the video pictures it shows, for settle(). */
export const applyFrame = (nodes: StageNodes, r: Resolved, frame: number): HTMLImageElement[] => {
  const g = geometry(r);
  const n = clampFrame(r, frame);
  const view = segmentsAt(r, n);
  const shown: HTMLImageElement[] = [];
  nodes.live = false;
  nodes.segments.forEach((node, k) => {
    const layer = view.layers.find((l) => l.index === k);
    applyLayer(node, layer, g);
    const base = r.segments[k]?.base;
    // A scene runs on its segment's own time; while the transition into it shows it early, it holds its first moment.
    if (node.scene && layer && seekScene(node.scene, (n - (r.segments[k]?.start ?? 0)) / r.canvas.fps, r.canvas.fps)) nodes.live = true;
    if (base?.kind === 'video') setPicture(node.img, layer ? frameUrl(r, base.play, n) : undefined, shown);
  });
  nodes.overlay.style.cssText = view.overlay
    ? nodes.overlayCss + 'display:block;background:' + view.overlay.color + ';opacity:' + n4(view.overlay.opacity) + ';'
    : nodes.overlayCss + 'display:none;';
  r.items.forEach((item, i) => {
    const node = nodes.items[i];
    if (!node) return;
    const state = itemStateAt(item, n);
    applyItem(node, item, state, g, n);
    if (item.play) setPicture(node.img, state ? frameUrl(r, item.play, n) : undefined, shown);
  });
  return shown;
};
