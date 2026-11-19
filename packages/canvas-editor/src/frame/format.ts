/** Inline formatting of the selected range inside the edited block. */
import type { TextFormat } from '../contracts';

const SIMPLE: Record<string, string> = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' };
const WRAP_PROP: Record<string, string> = {
  fontSize: 'font-size',
  fontFamily: 'font-family',
  uppercase: 'text-transform',
};

/** The non-empty selection range inside `block`, or null. */
export function selectedRange(doc: Document, block: Element): Range | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return !range.collapsed && block.contains(range.commonAncestorContainer) ? range : null;
}

function exec(doc: Document, command: string, value?: string): boolean {
  try {
    return typeof doc.execCommand === 'function' ? doc.execCommand(command, false, value) : false;
  } catch {
    return false;
  }
}

const fullyContains = (range: Range, node: Node): boolean =>
  range.comparePoint(node, 0) >= 0 && range.comparePoint(node, node.childNodes.length) <= 0;

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/** Wrap the range in `<span style="prop: value">` and select the wrapper's content. */
function wrapRange(doc: Document, range: Range, prop: string, value: string): void {
  const span = doc.createElement('span');
  span.appendChild(range.extractContents());
  // Inner declarations of the same property would win over the new wrapper.
  for (const inner of Array.from(span.querySelectorAll<HTMLElement>('[style]'))) {
    inner.style.removeProperty(prop);
    if (!inner.getAttribute('style')?.trim()) inner.removeAttribute('style');
  }
  span.style.setProperty(prop, value);
  range.insertNode(span);
  const next = doc.createRange();
  next.selectNodeContents(span);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(next);
}

/** Apply `format` to the selected range in `block`. Returns false (and does nothing) without a non-empty range. */
export function applyFormat(doc: Document, block: Element, format: TextFormat): boolean {
  const range = selectedRange(doc, block);
  if (!range) return false;
  const { command } = format;
  if (command in SIMPLE) {
    exec(doc, 'styleWithCSS', 'true');
    exec(doc, SIMPLE[command]);
  } else if (command === 'color' && 'value' in format) {
    exec(doc, 'styleWithCSS', 'true');
    exec(doc, 'foreColor', format.value);
  } else if (command === 'clear') {
    exec(doc, 'removeFormat');
    const after = selectedRange(doc, block) ?? range;
    for (const span of Array.from(block.querySelectorAll('span[style]'))) {
      if (fullyContains(after, span)) unwrap(span);
    }
  } else if (command in WRAP_PROP) {
    let value = 'value' in format ? format.value : 'uppercase';
    if (command === 'uppercase') {
      // Toggle: wrap with `none` when the selection already renders uppercase.
      const start = range.startContainer;
      const host = start.nodeType === 1 ? (start as Element) : start.parentElement;
      const view = doc.defaultView;
      if (host && view?.getComputedStyle(host).textTransform === 'uppercase') value = 'none';
    }
    wrapRange(doc, range, WRAP_PROP[command], value);
  } else return false;
  return true;
}
