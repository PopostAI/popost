/** Selection helpers over the document index. */
import type { DocIndex, EditOp, NodeId } from '../../contracts';

export function isDescendant(index: DocIndex, id: NodeId, ancestor: NodeId): boolean {
  for (let cur = index.elements.get(id)?.parent ?? null; cur !== null; cur = index.elements.get(cur)?.parent ?? null) {
    if (cur === ancestor) return true;
  }
  return false;
}

/** Drop ids that are inside another id of the list (moving or deleting the outer one already covers them). */
export function topLevelIds(index: DocIndex, ids: readonly NodeId[]): NodeId[] {
  const known = ids.filter((id) => index.elements.has(id));
  return known.filter((id) => !known.some((other) => other !== id && isDescendant(index, id, other)));
}

/** Move op that swaps `id` with its previous (`up`) or next (`down`) sibling element; null at the ends. */
export function reorderOp(index: DocIndex, id: NodeId, direction: 'up' | 'down'): EditOp | null {
  const parentId = index.elements.get(id)?.parent;
  if (!parentId) return null;
  const siblings = index.elements.get(parentId)?.children ?? [];
  const at = siblings.indexOf(id);
  if (at < 0) return null;
  if (direction === 'up') {
    const prev = siblings[at - 1];
    return prev === undefined ? null : { kind: 'move', id, parentId, beforeId: prev };
  }
  if (at >= siblings.length - 1) return null;
  return { kind: 'move', id, parentId, beforeId: siblings[at + 2] ?? null };
}
