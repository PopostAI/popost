/**
 * What a scene looks like right now, read in the page after a frame was applied: how much room its content needs,
 * and the marked places (data-slot) whose text is not drawn whole. A text fits when its glyphs, the ink itself, stay
 * inside its element's box: the characters' boxes are narrowed to the ascent and descent of the glyphs drawn, measured
 * with the canvas API, so a tight line-height whose font box sticks out of the line does not count as overflow. A
 * text that fits its element can still be cut off by an element around it that hides what lies outside it (a card
 * with a height and overflow: hidden); that is reported too, naming the element and by how many pixels.
 */
import type { SceneFact, SceneSpill, Side } from './contract';
import type { StageNodes } from './dom';
import { sceneTexts } from './texts';

/** A CSS pixel: layout rounds to fractions of one, and a glyph touching the edge is drawn whole. */
const SLACK = 1;

interface Rect { left: number; top: number; right: number; bottom: number }

const union = (a: Rect | undefined, b: Rect): Rect =>
  a ? { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) } : b;

/** Distance from the top of the font's box to the highest glyph of the text, and from the lowest glyph to its bottom. */
const glyphInsets = (ctx: CanvasRenderingContext2D | null, style: CSSStyleDeclaration, text: string): { top: number; bottom: number; box: number } => {
  if (!ctx) return { top: 0, bottom: 0, box: 0 };
  ctx.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
  const m = ctx.measureText(text.replace(/\s+/g, ''));
  return { top: Math.max(0, m.fontBoundingBoxAscent - m.actualBoundingBoxAscent), bottom: Math.max(0, m.fontBoundingBoxDescent - m.actualBoundingBoxDescent), box: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent };
};

/** Where the glyphs of an element's text are drawn (spaces left out), in the coordinates of its document; undefined when nothing is. */
const inkOf = (el: Element): Rect | undefined => {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const ctx = doc.createElement('canvas').getContext('2d');
  const range = doc.createRange();
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let ink: Rect | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const parent = node.parentElement;
    if (!text.trim() || !parent || !win) continue;
    const insets = glyphInsets(ctx, win.getComputedStyle(parent), text);
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text.charAt(i))) continue;
      const wide = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + wide);
      i += wide - 1;
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // A transform scales the character's box and its glyphs alike.
      const k = insets.box > 0 ? r.height / insets.box : 1;
      ink = union(ink, { left: r.left, right: r.right, top: r.top + insets.top * k, bottom: r.bottom - insets.bottom * k });
    }
  }
  return ink;
};

/** The box an element's content is drawn in and cut to (inside its border), in the coordinates of its document. */
const paddingBox = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  const sx = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
  const sy = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
  const left = r.left + el.clientLeft * sx, top = r.top + el.clientTop * sy;
  return { left, top, right: left + el.clientWidth * sx, bottom: top + el.clientHeight * sy };
};

/** The side on which the ink leaves the box the most, and by how many pixels; undefined when it stays inside. */
const spill = (ink: Rect, box: Rect, x: boolean, y: boolean): { side: Side; px: number } | undefined => {
  const out: [Side, number][] = [
    ...(x ? [['left', box.left - ink.left], ['right', ink.right - box.right]] as [Side, number][] : []),
    ...(y ? [['top', box.top - ink.top], ['bottom', ink.bottom - box.bottom]] as [Side, number][] : []),
  ];
  const worst = out.reduce<[Side, number] | undefined>((a, b) => (!a || b[1] > a[1] ? b : a), undefined);
  return worst && worst[1] > SLACK ? { side: worst[0], px: Math.round(worst[1]) } : undefined;
};

/** An element as a person finds it in the file: its tag, then its id or its classes. */
const nameOf = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  if (el.id) return tag + '#' + el.id;
  const classes = Array.from(el.classList);
  return classes.length ? tag + '.' + classes.join('.') : tag;
};

/** The nearest element around el (below body) that hides what lies outside it and cuts the ink off. */
const clippedBy = (el: Element, ink: Rect): { ancestor: string; side: Side; px: number } | undefined => {
  const win = el.ownerDocument.defaultView;
  const body = el.ownerDocument.body;
  for (let a = el.parentElement; a && win && a !== body && a !== el.ownerDocument.documentElement; a = a.parentElement) {
    const s = win.getComputedStyle(a);
    const x = s.overflowX !== 'visible', y = s.overflowY !== 'visible';
    if (s.display === 'inline' || (!x && !y)) continue;
    const cut = spill(ink, paddingBox(a), x, y);
    if (cut) return { ancestor: nameOf(a), ...cut };
  }
  return undefined;
};

/** The marked places of a scene whose text is not drawn whole: out of their own box, or cut by an element around them. */
const spills = (doc: Document): { overflowing: SceneSpill[]; clipped: SceneSpill[] } => {
  const overflowing: SceneSpill[] = [], clipped: SceneSpill[] = [];
  for (const el of Array.from(doc.querySelectorAll('[data-slot]'))) {
    if (!(el instanceof (doc.defaultView as typeof globalThis | null ?? globalThis).HTMLElement) || el.tagName === 'IMG') continue;
    const ink = inkOf(el);
    if (!ink) continue;
    const place = { slot: el.getAttribute('data-slot') ?? '', text: (el.textContent ?? '').trim().slice(0, 40) };
    // An inline element's box is its text's own, which its text always fits.
    const own = el.clientWidth > 0 && el.clientHeight > 0 ? spill(ink, paddingBox(el), true, true) : undefined;
    const cut = own ? undefined : clippedBy(el, ink);
    if (own) overflowing.push({ ...place, ...own });
    else if (cut) clipped.push({ ...place, ...cut });
  }
  return { overflowing, clipped };
};

/**
 * Every scene base as it is drawn now, or only the one of a segment; a scene whose segment is not on screen has no
 * layout and says little.
 */
export const sceneFacts = (nodes: StageNodes, segment?: number): SceneFact[] =>
  nodes.segments.flatMap((s) => {
    const doc = s.scene?.frame.contentDocument;
    if (!s.scene || !doc || (segment !== undefined && s.scene.segment !== segment)) return [];
    const root = doc.documentElement;
    return [{
      segment: s.scene.segment,
      src: s.scene.frame.getAttribute('src') ?? '',
      width: Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0),
      height: Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0),
      ...spills(doc),
      elements: doc.body ? doc.body.querySelectorAll('*').length : 0,
      texts: sceneTexts(doc),
    }];
  });
