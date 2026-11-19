/** Applies `LiveUpdate`s to the frame DOM by `data-pp-id`. Frame-only marks are re-applied by the caller. */
import type { LiveUpdate, NodeId } from '../contracts';
import { isJavascriptUrl, isUrlAttr } from '../core/preview';
import { findById } from './marks';

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** HTML `html` parsed with `el`'s parent (replace) or `el` itself (children) as context, so SVG stays SVG. */
function parseInContext(doc: Document, html: string, target: Node, mode: 'replace' | 'children'): DocumentFragment {
  const range = doc.createRange();
  if (mode === 'replace') range.selectNode(target);
  else range.selectNodeContents(target);
  return range.createContextualFragment(html);
}

function setStyle(el: Element, props: Readonly<Record<string, string | null>>): void {
  const style = (el as HTMLElement).style;
  if (!style) return;
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === '') {
      style.removeProperty(name);
      continue;
    }
    const important = /\s*!important\s*$/i.test(value);
    style.setProperty(name, important ? value.replace(/\s*!important\s*$/i, '') : value, important ? 'important' : '');
  }
}

function setAttr(el: Element, name: string, value: string | null): void {
  const lower = name.toLowerCase();
  // Editor bookkeeping is never touched; event handlers and script URLs never reach the preview.
  if (lower.startsWith('data-pp-') || lower.startsWith('on')) return;
  if (value !== null && isUrlAttr(lower) && isJavascriptUrl(value)) return;
  try {
    if (lower === 'xlink:href') {
      if (value === null) el.removeAttributeNS(XLINK_NS, 'href');
      else el.setAttributeNS(XLINK_NS, 'xlink:href', value);
    } else if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  } catch {
    /* invalid attribute name: ignore, the source op validates names */
  }
}

function insertBefore(parent: Node, node: Node, beforeId: NodeId | null, doc: Document): void {
  const before = beforeId === null ? null : findById(doc, beforeId);
  parent.insertBefore(node, before && before.parentNode === parent && before !== node ? before : null);
}

function upsertHeadStyle(doc: Document, key: string, css: string): void {
  const head = doc.head;
  if (!head) return;
  const existing = Array.from(head.querySelectorAll('style[data-popost-font]')).find(
    (s) => s.getAttribute('data-popost-font') === key,
  );
  const style = existing ?? doc.createElement('style');
  if (!existing) {
    style.setAttribute('data-popost-font', key);
    head.appendChild(style);
  }
  style.textContent = css;
}

export function applyLiveUpdates(doc: Document, updates: readonly LiveUpdate[]): void {
  for (const u of updates) {
    switch (u.kind) {
      case 'style': {
        const el = findById(doc, u.id);
        if (el) setStyle(el, u.props);
        break;
      }
      case 'attr': {
        const el = findById(doc, u.id);
        if (el) setAttr(el, u.name, u.value);
        break;
      }
      case 'subtrees':
        for (const item of u.items) {
          const el = findById(doc, item.id);
          if (el?.parentNode) el.replaceWith(parseInContext(doc, item.previewHTML, el, 'replace'));
        }
        break;
      case 'insert': {
        const parent = findById(doc, u.parentId);
        if (parent) insertBefore(parent, parseInContext(doc, u.previewHTML, parent, 'children'), u.beforeId, doc);
        break;
      }
      case 'remove':
        findById(doc, u.id)?.remove();
        break;
      case 'move': {
        const el = findById(doc, u.id);
        const parent = findById(doc, u.parentId);
        if (el && parent && !el.contains(parent)) insertBefore(parent, el, u.beforeId, doc);
        break;
      }
      case 'headStyle':
        upsertHeadStyle(doc, u.key, u.css);
        break;
      case 'reload':
        break; // the controller remounts instead
    }
  }
}
