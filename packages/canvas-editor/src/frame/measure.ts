/** Synchronous measurement: rects relative to the current page root, text overflow, computed styles. */
import type { NodeId, Rect } from '../contracts';
import { PP_ID_ATTR } from '../core/preview';
import { currentRoot, findById, SELECT_ATTR } from './marks';
import type { FrameState } from './marks';

const TOLERANCE = 1;
const round = (n: number): number => Math.round(n * 100) / 100;

export interface Measured {
  rects: Record<NodeId, Rect>;
  overflow: NodeId[];
}

/** True when a text block's content exceeds its box, or the block sticks out of the page by more than 1 px. */
export function isOverflowing(el: Element, rect: Rect, page: { width: number; height: number }): boolean {
  if (el.scrollHeight - el.clientHeight > TOLERANCE || el.scrollWidth - el.clientWidth > TOLERANCE) return true;
  return (
    rect.x < -TOLERANCE ||
    rect.y < -TOLERANCE ||
    rect.x + rect.width > page.width + TOLERANCE ||
    rect.y + rect.height > page.height + TOLERANCE
  );
}

/** Rects of `ids` (or every `[data-pp-sel]` inside the current page) relative to the current page root. */
export function measure(state: FrameState, ids: NodeId[] | 'page'): Measured {
  const out: Measured = { rects: {}, overflow: [] };
  const root = currentRoot(state);
  if (!root) return out;
  const origin = root.getBoundingClientRect();
  const page = { width: origin.width, height: origin.height };
  const elements: Array<[NodeId, Element]> = [];
  if (ids === 'page') {
    for (const el of Array.from(root.querySelectorAll(`[${SELECT_ATTR}]`))) {
      const id = el.getAttribute(PP_ID_ATTR);
      if (id) elements.push([id, el]);
    }
  } else {
    for (const id of ids) {
      const el = findById(state.doc, id);
      if (el) elements.push([id, el]);
    }
  }
  for (const [id, el] of elements) {
    const r = el.getBoundingClientRect();
    const rect: Rect = {
      x: round(r.left - origin.left),
      y: round(r.top - origin.top),
      width: round(r.width),
      height: round(r.height),
    };
    out.rects[id] = rect;
    if (el.getAttribute(SELECT_ATTR) === 'text' && isOverflowing(el, rect, page)) out.overflow.push(id);
  }
  return out;
}

/** Computed values (`getPropertyValue`, CSS property names); a missing element yields {}. */
export function computedStyles(state: FrameState, id: NodeId, props: string[]): Record<string, string> {
  const el = findById(state.doc, id);
  const view = state.doc.defaultView;
  if (!el || !view) return {};
  const cs = view.getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const p of props) out[p] = cs.getPropertyValue(p);
  return out;
}
