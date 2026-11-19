import { frameElement } from './frame-dom';
import { isTransparentColor } from './logic/colors';
/** Page operations as EditOps on page roots (SPEC §8 "Pages"). */
import type { EditorController, NodeId } from '../contracts';
import { deletePageOp, duplicatePageOp, movePageOp, newPageKey } from '../core/pages';

/** Duplicate a page right after itself and open the copy. */
export function duplicatePage(c: EditorController, id: NodeId): void {
  c.apply(duplicatePageOp(id), { label: 'duplicate page' });
  const pages = c.getSnapshot().pages;
  const copy = pages[pages.findIndex((p) => p.id === id) + 1];
  if (copy) c.setCurrentPage(copy.id);
}

/** False when the page is the last one (it cannot be deleted). */
export function deletePage(c: EditorController, id: NodeId): boolean {
  const op = deletePageOp(c.index(), id);
  if (!op) return false;
  c.apply(op, { label: 'delete page' });
  return true;
}

/** Put the page at position `to` (0-based) of the page list. */
export function movePage(c: EditorController, id: NodeId, to: number): void {
  const op = movePageOp(c.index(), id, to);
  if (op) c.apply(op, { label: 'move page' });
}

/** Insertion slot (0..n, before page `slot`) -> target position after the move. */
export const slotToIndex = (from: number, slot: number): number => (slot > from ? slot - 1 : slot);

/** Add a blank page with the first page's dimensions and solid background. */
export function addPage(c: EditorController): void {
  const pages = c.getSnapshot().pages;
  const first = pages[0];
  const last = pages.at(-1);
  if (!first || !last) return;
  const parentId = c.index().elements.get(last.id)?.parent;
  if (!parentId) return;
  const element = frameElement(first.id);
  const computed = element?.ownerDocument.defaultView?.getComputedStyle(element);
  const page = document.createElement('div');
  page.className = 'slide';
  const key = newPageKey();
  page.dataset.popostPage = key;
  page.dataset.popostWidth = String(first.width);
  page.dataset.popostHeight = String(first.height);
  const color = computed?.backgroundColor;
  page.style.cssText = `width:${first.width}px;height:${first.height}px;position:relative;overflow:hidden;background-image:none`;
  page.style.backgroundColor = color && !isTransparentColor(color) ? color : '#fff';
  const siblings = c.index().elements.get(parentId)?.children ?? [];
  c.apply({ kind: 'insertHTML', parentId, beforeId: siblings[siblings.indexOf(last.id) + 1] ?? null, html: page.outerHTML }, { label: 'add page' });
  const added = c.getSnapshot().pages.find((item) => item.pageKey === key);
  if (added) c.setCurrentPage(added.id);
}
