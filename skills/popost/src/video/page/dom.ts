/**
 * Builds the page's DOM once from the resolved timeline. Every element keeps its static CSS in a string; applyFrame
 * rewrites the whole inline style (static + per-frame part) on every call, so nothing carries over between frames.
 */
import type { Resolved, ResolvedItem, ResolvedSegment, ResolvedTextStyle, Shadow } from '../types';
import { gradientCss } from '../presets/fill';
import { DEFAULT_LINE_HEIGHT, textParts, type TextPart } from '../presets/text-styles';
import { backgroundCss, element, n4, px, spanCss } from './css';
import type { SceneNode } from './scene';
import { buildWords, type WordNodes } from './words';

export interface SegmentNode {
  layer: HTMLElement;
  layerCss: string;
  img?: HTMLImageElement;
  imgCss: string;
  /** Directional blur of whip transitions: an SVG filter per layer, referenced as url(#filterId). */
  smear: SVGFEGaussianBlurElement;
  filterId: string;
  /** A scene base: its frame and the animations it is driven by. */
  scene?: SceneNode;
}

export interface ItemNode {
  el: HTMLElement;
  css: string;
  /** The display value when shown. */
  display: string;
  /** The item's drop shadow as a CSS filter function, or ''; applyFrame puts it before the blur of a motion. */
  shadow: string;
  /** One span per character when the item types its text; empty otherwise. */
  chars: HTMLElement[];
  /** A text item's block of lines (what layout() measures). */
  block?: HTMLElement;
  img?: HTMLImageElement;
  /** A caption cue that follows the words: its tokens, restyled per frame (words.ts). chars are then its characters. */
  words?: WordNodes;
}

export interface StageNodes {
  /** The canvas in the page: layout() measures against it. */
  stage: HTMLElement;
  segments: SegmentNode[];
  overlay: HTMLElement;
  overlayCss: string;
  items: ItemNode[];
  /** The pictures of image bases and image items (decoded once by prepare). Video pictures change with the frame. */
  images: HTMLImageElement[];
  /** Set by applyFrame: a scene on screen may look different on the next frame although the stage's markup is the same. */
  live: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';
const full = (r: Resolved): string => 'position:absolute;left:0;top:0;width:' + px(r.canvas.width) + ';height:' + px(r.canvas.height) + ';';
const minSide = (r: Resolved): number => Math.min(r.canvas.width, r.canvas.height);

/** A CSS string literal. */
export const cssString = (s: string): string => '"' + s.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ') + '"';

const shadowCss = (s: Required<Shadow>, unit: number): string => px(s.x * unit) + ' ' + px(s.y * unit) + ' ' + px(s.blur * unit) + ' ' + s.color;

const buildSegment = (doc: Document, r: Resolved, seg: ResolvedSegment, parent: Element, defs: Element): SegmentNode => {
  // A colour base is its fill; a material base shows its ground around a picture that does not fill the canvas.
  const paint = seg.base.kind === 'color' ? seg.base : seg.base.kind === 'scene' ? undefined : seg.base.ground;
  const fill = paint ? 'background:' + (paint.gradient ? gradientCss(paint.gradient) : paint.color) + ';' : '';
  const layerCss = full(r) + 'overflow:hidden;transform-origin:50% 50%;' + fill;
  const layer = element(doc, 'div', layerCss + 'display:none;', parent);
  layer.dataset.segment = seg.id;
  const filterId = 'popost-smear-' + seg.index;
  const filter = doc.createElementNS(SVG, 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const smear = doc.createElementNS(SVG, 'feGaussianBlur');
  smear.setAttribute('stdDeviation', '0 0');
  smear.setAttribute('edgeMode', 'duplicate');
  filter.appendChild(smear);
  defs.appendChild(filter);
  if (seg.base.kind === 'color') return { layer, layerCss, imgCss: '', smear, filterId };
  if (seg.base.kind === 'scene') {
    // The scene's page in a frame of its own, the size of the canvas. Scripts run (a scene may draw itself); it
    // cannot navigate the page it sits in, and nothing in it takes the pointer.
    const frame = element(doc, 'iframe', 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;display:block;pointer-events:none;background:transparent;', layer);
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('src', seg.base.src);
    return { layer, layerCss, imgCss: '', smear, filterId, scene: { frame, segment: seg.index, animations: [], ...(seg.base.slots ? { slots: seg.base.slots } : {}) } };
  }
  const imgCss = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;transform-origin:50% 50%;object-fit:' + seg.base.fit + ';';
  const img = element(doc, 'img', imgCss, layer);
  img.alt = '';
  // A video base gets its picture from applyFrame, one frame's picture at a time.
  if (seg.base.kind === 'image') img.src = seg.base.src;
  return { layer, layerCss, img, imgCss, smear, filterId };
};

const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

const partCss = (p: TextPart): string => spanCss(p.span);

/**
 * One element per part. Typing: one span per character inside it (Array.from: by code point). A part's background
 * then sits on its characters, so it grows as they appear (a hidden character hides its own background).
 */
const buildParts = (doc: Document, parts: readonly TextPart[], size: number, typing: boolean, run: HTMLElement): HTMLElement[] =>
  parts.flatMap((p) => {
    const bg = p.span?.background;
    if (!typing) {
      const el = element(doc, 'span', partCss(p) + (bg ? backgroundCss(bg, size, true, true) + '-webkit-box-decoration-break:clone;box-decoration-break:clone;' : ''), run);
      el.textContent = p.text;
      return [];
    }
    const holder = element(doc, 'span', partCss(p), run);
    const chars = Array.from(p.text);
    return chars.map((ch, i) => {
      const span = element(doc, 'span', bg ? backgroundCss(bg, size, i === 0, i === chars.length - 1) : '', holder);
      span.textContent = ch;
      return span;
    });
  });

const blockCss = (s: ResolvedTextStyle, size: number): string =>
  'width:100%;text-align:' + s.align + ';font-family:' + s.font + ';font-size:' + px(size) + ';font-weight:' + s.weight + ';font-style:' + (s.italic ? 'italic' : 'normal') +
  ';color:' + s.color + ';line-height:' + n4(s.lineHeight ?? DEFAULT_LINE_HEIGHT) + ';white-space:pre-wrap;overflow-wrap:break-word;' +
  (s.letterSpacing ? 'letter-spacing:' + px(s.letterSpacing * size) + ';' : '') + (s.shadow ? 'text-shadow:' + shadowCss(s.shadow, size) + ';' : '') +
  (s.opacity !== undefined && s.opacity !== 1 ? 'opacity:' + n4(s.opacity) + ';' : '');

const buildText = (doc: Document, r: Resolved, item: ResolvedItem, el: HTMLElement): { chars: HTMLElement[]; block?: HTMLElement; words?: WordNodes } => {
  const s = item.style;
  if (!s || item.text === undefined) return { chars: [] };
  const size = s.size * r.canvas.height;
  const block = element(doc, 'div', blockCss(s, size), el);
  const stroke = s.stroke ? '-webkit-text-stroke:' + px(s.stroke.width * size) + ' ' + s.stroke.color + ';paint-order:stroke fill;' : '';
  const bg = s.background ? backgroundCss(s.background, size, true, true) + '-webkit-box-decoration-break:clone;box-decoration-break:clone;' : '';
  const run = element(doc, 'span', stroke + bg, block);
  if (item.words) {
    const words = buildWords(doc, item, s, size, run);
    return { chars: words.chars, block, words };
  }
  const typing = item.enter.preset === 'type' || item.exit.preset === 'type';
  return { chars: buildParts(doc, textParts(item.text, s.spans), size, typing, run), block };
};

/** Static CSS every visual item shares: its box, stacking, border, and the outline a radius or mask gives it. */
const placeCss = (r: Resolved, item: ResolvedItem): string => {
  const [x, y, w, h] = item.box;
  const W = r.canvas.width;
  const H = r.canvas.height;
  const border = item.border ? 'border:' + px(item.border.width * minSide(r)) + ' solid ' + item.border.color + ';' : '';
  return 'position:absolute;left:' + px(x * W) + ';top:' + px(y * H) + ';width:' + px(w * W) + ';height:' + px(h * H) + ';z-index:' + item.z + ';transform-origin:50% 50%;' + border;
};

/** border-radius of an item: an ellipse (shape or mask), or a radius as a fraction of the box's smaller side. */
const radiusCss = (r: Resolved, item: ResolvedItem): string => {
  if (item.shape === 'ellipse' || item.mask === 'ellipse') return 'border-radius:50%;';
  const radius = (item.radius ?? 0) * Math.min(item.box[2] * r.canvas.width, item.box[3] * r.canvas.height);
  return radius > 0 ? 'border-radius:' + px(radius) + ';' : '';
};

const buildItem = (doc: Document, r: Resolved, item: ResolvedItem, parent: Element): ItemNode => {
  const place = placeCss(r, item);
  const shadow = item.shadow ? 'drop-shadow(' + shadowCss(item.shadow, minSide(r)) + ')' : '';
  if (item.type === 'text') {
    const css = place + 'align-items:center;justify-content:' + JUSTIFY[item.style?.align ?? 'center'] + ';';
    const el = element(doc, 'div', css + 'display:none;', parent);
    el.dataset.item = item.id;
    return { el, css, display: 'flex', shadow, ...buildText(doc, r, item, el) };
  }
  if (item.type === 'image' || item.type === 'video') {
    // A picture or video clips to its box, with rounded corners or an ellipse when it has a radius or a mask.
    const outline = radiusCss(r, item);
    const css = place + (outline || item.type === 'video' ? 'overflow:hidden;' + outline : '');
    const el = element(doc, 'div', css + 'display:none;', parent);
    el.dataset.item = item.id;
    const img = element(doc, 'img', 'width:100%;height:100%;display:block;object-fit:' + (item.fit ?? 'contain') + ';', el);
    img.alt = '';
    if (item.type === 'image') img.src = item.src ?? '';
    return { el, css, display: 'block', shadow, chars: [], img };
  }
  const css = place + 'background:' + (item.gradient ? gradientCss(item.gradient) : (item.color ?? '#ffffff')) + ';' + radiusCss(r, item);
  const el = element(doc, 'div', css + 'display:none;', parent);
  el.dataset.item = item.id;
  return { el, css, display: 'block', shadow, chars: [] };
};

/** @font-face rules of the font materials: one face per file, used for every weight (a static font is not made bolder). */
export const fontFaceCss = (r: Resolved): string =>
  (r.fonts ?? []).map((f) => '@font-face{font-family:' + cssString(f.family) + ';src:url(' + cssString(f.src) + ');font-weight:1 1000;font-display:block}').join('\n');

/** Builds viewport > stage > (segment layers, overlay, items) inside root, and the font declarations in head. */
export const buildStage = (doc: Document, root: Element, r: Resolved, scale: number): StageNodes => {
  const W = r.canvas.width;
  const H = r.canvas.height;
  if ((r.fonts ?? []).length > 0) {
    const style = doc.createElement('style');
    style.textContent = fontFaceCss(r);
    doc.head.appendChild(style);
  }
  const viewport = element(doc, 'div', 'position:relative;overflow:hidden;width:' + px(Math.round(W * scale)) + ';height:' + px(Math.round(H * scale)) + ';', root);
  const stage = element(doc, 'div', 'position:relative;overflow:hidden;background:#000;width:' + px(W) + ';height:' + px(H) + ';transform-origin:0 0;' +
    (scale === 1 ? '' : 'transform:scale(' + n4(scale) + ');'), viewport);
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;');
  const defs = doc.createElementNS(SVG, 'defs');
  svg.appendChild(defs);
  stage.appendChild(svg);
  const layers = element(doc, 'div', full(r) + 'z-index:0;isolation:isolate;', stage);
  const segments = r.segments.map((seg) => buildSegment(doc, r, seg, layers, defs));
  const overlayCss = full(r) + 'z-index:1;';
  const overlay = element(doc, 'div', overlayCss + 'display:none;', stage);
  const itemLayer = element(doc, 'div', full(r) + 'z-index:2;isolation:isolate;', stage);
  const items = r.items.map((item) => buildItem(doc, r, item, itemLayer));
  const images = [...segments.filter((_n, k) => r.segments[k]?.base.kind === 'image'), ...items.filter((_n, i) => r.items[i]?.type === 'image')].flatMap((node) => (node.img ? [node.img] : []));
  return { stage, segments, overlay, overlayCss, items, images, live: false };
};
