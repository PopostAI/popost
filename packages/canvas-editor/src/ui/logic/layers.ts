/** Layers tree: the current page's selectable blocks, nested by their nearest selectable ancestor. */
import type { DocIndex, EditOp, NodeId } from '../../contracts';
import { blockKind, selectableBlocks } from '../../core/pages';
import type { BlockKind } from '../../core/pages';
import { getAttr, textContent } from '../../core/source';

export interface LayerRow {
  id: NodeId;
  kind: BlockKind;
  depth: number;
  tag: string;
  /** Text snippet, alt text or file name; empty when there is nothing to show. */
  snippet: string;
  /** DOM parent (reordering is only allowed among rows that share it). */
  parentId: NodeId | null;
}

const SNIPPET_MAX = 36;

export function snippetOf(text: string, max = SNIPPET_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Last path segment of a URL that is not a data URI, without the query. */
export function fileNameOf(src: string | null): string {
  if (!src || /^data:/i.test(src.trim())) return '';
  const tail = src.split(/[?#]/)[0]?.split('/').filter(Boolean).at(-1) ?? '';
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

export function layerSnippet(index: DocIndex, id: NodeId, kind: BlockKind): string {
  const el = index.elements.get(id);
  if (!el) return '';
  if (kind === 'image') return snippetOf(getAttr(el, 'alt') ?? '') || fileNameOf(getAttr(el, 'src'));
  if (kind === 'text') return snippetOf(textContent(index, id));
  return snippetOf(getAttr(el, 'data-layer-id') ?? getAttr(el, 'aria-label') ?? '') || snippetOf(textContent(index, id));
}

export function buildLayerRows(index: DocIndex, pageId: NodeId | null): LayerRow[] {
  if (pageId === null) return [];
  const ids = selectableBlocks(index, pageId);
  const set = new Set(ids);
  const depth = new Map<NodeId, number>();
  return ids.map((id) => {
    const el = index.elements.get(id);
    let up = el?.parent ?? null;
    while (up !== null && up !== pageId && !set.has(up)) up = index.elements.get(up)?.parent ?? null;
    const d = up !== null && set.has(up) ? (depth.get(up) ?? 0) + 1 : 0;
    depth.set(id, d);
    const kind = blockKind(index, id);
    return { id, kind, depth: d, tag: el?.tag.toLowerCase() ?? '', snippet: layerSnippet(index, id, kind), parentId: el?.parent ?? null };
  });
}

/** Move op that puts `id` right before/after `targetId`; null when they do not share a parent or nothing changes. */
export function layerMoveOp(index: DocIndex, id: NodeId, targetId: NodeId, where: 'before' | 'after'): EditOp | null {
  if (id === targetId) return null;
  const parentId = index.elements.get(id)?.parent;
  if (!parentId || index.elements.get(targetId)?.parent !== parentId) return null;
  const siblings = (index.elements.get(parentId)?.children ?? []).filter((s) => s !== id);
  const at = siblings.indexOf(targetId);
  if (at < 0) return null;
  const beforeId = siblings[where === 'before' ? at : at + 1] ?? null;
  const original = index.elements.get(parentId)?.children ?? [];
  const now = original.indexOf(id);
  const next = [...siblings];
  next.splice(beforeId === null ? next.length : next.indexOf(beforeId), 0, id);
  if (next.indexOf(id) === now) return null;
  return { kind: 'move', id, parentId, beforeId };
}

/** Position of `id` among its parent's children after a `layerMoveOp`, for re-selecting the moved block. */
export function movedIndex(index: DocIndex, id: NodeId, targetId: NodeId, where: 'before' | 'after'): number | null {
  const parentId = index.elements.get(id)?.parent;
  if (!parentId) return null;
  const siblings = (index.elements.get(parentId)?.children ?? []).filter((s) => s !== id);
  const at = siblings.indexOf(targetId);
  return at < 0 ? null : where === 'before' ? at : at + 1;
}
