/**
 * layout(): what a text item's lines need, measured in the page after prepare(). Each text item is shown for the
 * measurement in its static state (no motion, no rotation) and put back as it was, so the picture does not change.
 */
import type { Box, Resolved, ResolvedItem } from '../types';
import type { LayoutFact } from './contract';
import type { ItemNode, StageNodes } from './dom';
import { DEFAULT_LINE_HEIGHT } from '../presets/text-styles';

/** Half a CSS pixel: layout rounds to that, so a line that fits exactly is not reported as overflowing. */
const SLACK = 0.5;

interface Rect { left: number; top: number; right: number; bottom: number }

/** Rectangles of the visible characters (spaces and line breaks left out, so a hanging space is not counted). */
const charRects = (block: HTMLElement): Rect[] => {
  const out: Rect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Text that follows the words is measured by its rooms (runtime/words.ts), not by the layers drawn over them.
    if (node.parentElement?.closest('[data-glyphs]')) continue;
    const text = node.textContent ?? '';
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text.charAt(i))) continue;
      const wide = text.codePointAt(i) !== undefined && (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + wide);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      i += wide - 1;
    }
  }
  return out;
};

/** Lines: groups of characters whose middles lie within half a line of each other. */
const countLines = (rects: readonly Rect[], lineHeight: number): number => {
  const middles = rects.map((r) => (r.top + r.bottom) / 2).sort((a, b) => a - b);
  return middles.reduce((acc, m, i) => (i === 0 || m - (middles[i - 1] ?? m) > lineHeight / 2 ? acc + 1 : acc), 0);
};

/** Distance from the top of a line's box to its glyphs, and from its glyphs to its bottom, in CSS pixels. */
const glyphInsets = (item: ResolvedItem, sizePx: number): [number, number] => {
  const s = item.style;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!s || !ctx) return [0, 0];
  ctx.font = (s.italic ? 'italic ' : '') + s.weight + ' ' + sizePx + 'px ' + s.font;
  const m = ctx.measureText((item.text ?? '').replace(/\s+/g, ''));
  return [Math.max(0, m.fontBoundingBoxAscent - m.actualBoundingBoxAscent), Math.max(0, m.fontBoundingBoxDescent - m.actualBoundingBoxDescent)];
};

const measure = (node: ItemNode, block: HTMLElement, item: ResolvedItem, r: Resolved, origin: DOMRect, scale: number): LayoutFact => {
  const W = r.canvas.width * scale;
  const H = r.canvas.height * scale;
  const size = (item.style?.size ?? 0) * r.canvas.height;
  const box = node.el.getBoundingClientRect();
  const lines = block.getBoundingClientRect();
  const rects = charRects(block);
  const left = Math.min(...rects.map((x) => x.left));
  const right = Math.max(...rects.map((x) => x.right));
  const [topInset, bottomInset] = glyphInsets(item, size);
  const stroke = ((item.style?.stroke?.width ?? 0) * size * scale) / 2;
  const top = Math.min(...rects.map((x) => x.top)) + topInset * scale - stroke;
  const bottom = Math.max(...rects.map((x) => x.bottom)) - bottomInset * scale + stroke;
  const frac = (x0: number, y0: number, x1: number, y1: number): Box => [(x0 - origin.left) / W, (y0 - origin.top) / H, (x1 - x0) / W, (y1 - y0) / H];
  const width = rects.length > 0 ? right - left : 0;
  return {
    id: item.id,
    fits: lines.height <= box.height + SLACK * scale && width <= box.width + SLACK * scale,
    lines: countLines(rects, (item.style?.lineHeight ?? DEFAULT_LINE_HEIGHT) * size * scale),
    ink: rects.length > 0 ? frac(left - stroke, top, right + stroke, bottom) : [0, 0, 0, 0],
    block: rects.length > 0 ? frac(left, lines.top, right, lines.bottom) : frac(lines.left, lines.top, lines.left, lines.bottom),
  };
};

export const layoutOf = (nodes: StageNodes, r: Resolved, scale: number): LayoutFact[] => {
  const origin = nodes.stage.getBoundingClientRect();
  return r.items.flatMap((item, i) => {
    const node = nodes.items[i];
    if (item.type !== 'text' || !node?.block) return [];
    const saved = node.el.style.cssText;
    node.el.style.cssText = node.css + 'display:' + node.display + ';';
    try {
      return [measure(node, node.block, item, r, origin, scale)];
    } finally {
      node.el.style.cssText = saved;
    }
  });
};
