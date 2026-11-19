import { useMemo } from 'react';
import type { EditorController, EditorSnapshot, NodeId } from '../../contracts';
import { blockKind } from '../../core/pages';
import type { BlockKind } from '../../core/pages';
import { extractDocColors } from '../logic/colors';

/** The blocks panels and the toolbar act on: the block being edited, else the selection. */
export function targetsOf(snap: EditorSnapshot): NodeId[] {
  return snap.editingTextId ? [snap.editingTextId] : [...snap.selection];
}

/** Colours used in the document; recomputed when the source changes. */
export function useDocColors(controller: EditorController, sourceVersion: number): string[] {
  return useMemo(() => extractDocColors(controller.index().source), [controller, sourceVersion]);
}

/** Computed styles of the first target (live from the frame), refreshed with the snapshot. */
export function useTargetStyles(controller: EditorController, snap: EditorSnapshot, props: readonly string[]): Record<string, string> {
  const first = targetsOf(snap)[0];
  return useMemo(() => (first === undefined ? {} : controller.styles(first, [...props])), [controller, first, snap.sourceVersion, snap.rects, snap.editingTextId, snap.textState]);
}

export function useKinds(controller: EditorController, ids: readonly NodeId[], sourceVersion: number): BlockKind[] {
  return useMemo(() => ids.map((id) => blockKind(controller.index(), id)), [controller, ids.join(','), sourceVersion]);
}
