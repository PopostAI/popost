/** Frame-only marks on the preview DOM (page roots, current page, highlight) and id lookups. */
import type { NodeId } from '../contracts';
import { CURRENT_PAGE_CLASS, PP_ID_ATTR } from '../core/preview';

/** Marks a page root inside the frame (CSS hides the roots that are not current). */
export const PAGE_ATTR = 'data-pp-root';
/** Marks highlighted blocks (hover from the layers panel). */
export const HIGHLIGHT_ATTR = 'data-pp-hl';
/** Selectable block mark written by `buildPreview`; value = block kind. */
export const SELECT_ATTR = 'data-pp-sel';

/** What the frame modules share about the mounted document. */
export interface FrameState {
  doc: Document;
  pageIds: NodeId[];
  currentId: NodeId | null;
  highlightIds: NodeId[];
}

/** Element carrying `data-pp-id="id"`, or null. */
export function findById(doc: Document, id: NodeId): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[${PP_ID_ATTR}="${id.replace(/["\\]/g, '\\$&')}"]`);
}

export function currentRoot(state: FrameState): HTMLElement | null {
  return state.currentId === null ? null : findById(state.doc, state.currentId);
}

/** Page roots as the DOM shows them: top-level `.slide` elements outside templates (mirrors `core/pages`). */
export function discoverPages(doc: Document): NodeId[] {
  const out: NodeId[] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.slide'))) {
    const parent = el.parentElement;
    if (parent?.closest('.slide, template')) continue;
    const id = el.getAttribute(PP_ID_ATTR);
    if (id) out.push(id);
  }
  return out;
}

/** (Re-)apply page marks, the current-page class and the highlight attribute. */
export function applyMarks(state: FrameState): void {
  const { doc } = state;
  for (const id of state.pageIds) {
    const el = findById(doc, id);
    if (!el) continue;
    el.setAttribute(PAGE_ATTR, '');
    el.classList.toggle(CURRENT_PAGE_CLASS, id === state.currentId);
  }
  for (const el of Array.from(doc.querySelectorAll(`[${HIGHLIGHT_ATTR}]`))) el.removeAttribute(HIGHLIGHT_ATTR);
  for (const id of state.highlightIds) findById(doc, id)?.setAttribute(HIGHLIGHT_ATTR, '');
}
