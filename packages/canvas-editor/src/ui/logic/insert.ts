/** Where and what the Text panel inserts. */
import type { DocIndex, NodeId } from '../../contracts';

export type NewBlockKind = 'heading' | 'subheading' | 'paragraph';

export interface InsertPosition {
  parentId: NodeId;
  beforeId: NodeId | null;
}

/**
 * Insert after the last selected block (as its next sibling), else at the end of the current page root.
 * Selected ids that are no longer in the document are ignored; null without a page.
 */
export function chooseInsertPosition(index: DocIndex, selection: readonly NodeId[], pageId: NodeId | null): InsertPosition | null {
  const order = new Map(index.order.map((id, at) => [id, at]));
  const anchor = selection
    .filter((id) => index.elements.has(id) && index.elements.get(id)?.parent)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .at(-1);
  if (anchor !== undefined) {
    const el = index.elements.get(anchor);
    const parentId = el?.parent;
    if (parentId) {
      const siblings = index.elements.get(parentId)?.children ?? [];
      return { parentId, beforeId: siblings[siblings.indexOf(anchor) + 1] ?? null };
    }
  }
  return pageId !== null && index.elements.has(pageId) ? { parentId: pageId, beforeId: null } : null;
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sizes relative to the page width, so a block reads the same on a 1080 and a 1280 wide page. */
const SPEC: Record<NewBlockKind, { tag: string; size: number; weight: number; line: number }> = {
  heading: { tag: 'h1', size: 0.07, weight: 700, line: 1.15 },
  subheading: { tag: 'h2', size: 0.045, weight: 600, line: 1.25 },
  paragraph: { tag: 'p', size: 0.03, weight: 400, line: 1.5 },
};

export function newBlockHTML(kind: NewBlockKind, pageWidth: number, text: string, color = "#222222"): string {
  const s = SPEC[kind];
  const side = Math.round(pageWidth * 0.07);
  const style = `position:absolute;z-index:100;left:${side}px;top:${side}px;max-width:${pageWidth - 2 * side}px;margin:0;color:${color};font-size:${Math.round(pageWidth * s.size)}px;font-weight:${s.weight};line-height:${s.line}`;
  return `<${s.tag} style="${style}">${escapeHtml(text)}</${s.tag}>`;
}
