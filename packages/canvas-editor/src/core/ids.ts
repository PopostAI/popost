import type { DocIndex, ElementInfo, NodeId, Splice } from '../contracts';
import { isInReplaced, mapOffset } from './splices';

export { mapOffset };

export interface IdSource {
  newId(): NodeId;
}

/** Monotonic `n<counter>` id generator; one per editing session. */
export function createIdSource(start = 1): IdSource {
  let counter = start;
  return { newId: () => `n${counter++}` };
}

/** Default source used by `parseIndex` when the caller does not supply one. */
export const sessionIds: IdSource = createIdSource();

/** Old range `[from, from + length)` now starts at `to` in the new source (moved elements keep their ids). */
export interface Relocation {
  from: number;
  to: number;
  length: number;
}

export interface PrevState {
  index: DocIndex;
  splices: readonly Splice[];
  moved?: readonly Relocation[];
}

/** Implied `<html>/<head>/<body>` have no start tag of their own. */
export function isImplied(el: ElementInfo): boolean {
  return el.startTagEnd === el.start;
}

/** Where an old element's start offset lands in the new source, or null if it was replaced. */
export function mapStart(prev: Pick<PrevState, 'splices' | 'moved'>, pos: number): number | null {
  for (const r of prev.moved ?? []) {
    if (pos >= r.from && pos < r.from + r.length) return r.to + (pos - r.from);
  }
  if (isInReplaced(prev.splices, pos)) return null;
  return mapOffset(prev.splices, pos, 1);
}

/** Pair old elements with elements of the new (raw) index; maps old id to new raw id. */
export function matchElements(raw: DocIndex, prev: PrevState): Map<NodeId, NodeId> {
  const byStart = new Map<number, ElementInfo>();
  for (const el of raw.elements.values()) if (!isImplied(el)) byStart.set(el.start, el);

  const pairs = new Map<NodeId, NodeId>();
  const taken = new Set<NodeId>();
  const link = (old: NodeId, next: NodeId | null): void => {
    if (next !== null && !taken.has(next)) {
      pairs.set(old, next);
      taken.add(next);
    }
  };

  for (const oldEl of prev.index.elements.values()) {
    if (isImplied(oldEl)) continue;
    const pos = mapStart(prev, oldEl.start);
    const next = pos === null ? undefined : byStart.get(pos);
    if (next && next.tag === oldEl.tag) link(oldEl.id, next.id);
  }
  // The three structural elements always keep their identity.
  const roles = ['html', 'head', 'body'] as const;
  for (const role of roles) {
    const oldId = prev.index[role];
    const newId = raw[role];
    if (oldId !== null && newId !== null) link(oldId, newId);
  }
  return pairs;
}

/**
 * Replace the provisional ids of a freshly parsed index with stable ones: elements matched
 * through the splices keep their old id, everything else gets a fresh one (document order).
 */
export function assignIds(raw: DocIndex, prev?: PrevState, ids: IdSource = sessionIds): DocIndex {
  const matched = prev ? matchElements(raw, prev) : new Map<NodeId, NodeId>();
  const rawToFinal = new Map<NodeId, NodeId>();
  for (const [oldId, rawId] of matched) rawToFinal.set(rawId, oldId);
  for (const rawId of raw.order) {
    if (!rawToFinal.has(rawId)) rawToFinal.set(rawId, ids.newId());
  }

  const final = (id: NodeId): NodeId => rawToFinal.get(id) as NodeId;
  const elements = new Map<NodeId, ElementInfo>();
  for (const rawId of raw.order) {
    const el = raw.elements.get(rawId) as ElementInfo;
    elements.set(final(rawId), {
      ...el,
      id: final(rawId),
      parent: el.parent === null ? null : final(el.parent),
      children: el.children.map(final),
    });
  }
  if (elements.size !== raw.order.length) throw new Error('assignIds: id collision (id source out of sync)');

  const opt = (id: NodeId | null): NodeId | null => (id === null ? null : final(id));
  return {
    source: raw.source,
    elements,
    order: raw.order.map(final),
    html: opt(raw.html),
    head: opt(raw.head),
    body: opt(raw.body),
  };
}
