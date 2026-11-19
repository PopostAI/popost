/**
 * Source -> edit-frame document. Implemented as splices over the source text so the preview mirrors
 * the source byte for byte except for ids, sanitising and the injected frame plumbing.
 */
import type { DocIndex, ElementInfo, NodeId, Splice } from '../contracts';
import { selectableKind } from './pages';
import { sanitizeImageOrigins } from './image-origins';
import { applySplices } from './splices';
import { attrDeleteRange, attrValueRange, escapeAttrValue, findAttr } from './source';

export const PP_ID_ATTR = 'data-pp-id';
export const PP_SEL_ATTR = 'data-pp-sel';
export const CURRENT_PAGE_CLASS = 'ed-cur';

export interface PreviewOptions {
  /** CSS for the frame (current page visible, overlays off, ...). */
  frameCSS: string;
  /** Local mode: `<base href>` for relative resources. */
  baseHref?: string;
  currentPageId?: NodeId;
  /** Host mode: extra `https:` image origins for `img-src` (re-validated by `previewCSP`). */
  imageOrigins?: readonly string[];
}

const REMOVED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);

/** Attributes whose `javascript:` values are stripped from previews. */
export const isUrlAttr = (name: string): boolean => URL_ATTRS.has(name.toLowerCase());
/**
 * CSP of the edit frame (current-contracts section 3 `safePreview`, but no scripts at all: the editor reads the
 * same-origin frame DOM directly). Relaxed to 'self' when a base URL is used.
 */
export function previewCSP(withBase: boolean, imageOrigins: readonly string[] = []): string {
  const self = withBase ? " 'self'" : '';
  const origins = sanitizeImageOrigins(imageOrigins).map((origin) => ` ${origin}`).join('');
  return [
    "default-src 'none'",
    `img-src data: blob: 'self'${origins}`,
    `style-src${self} 'unsafe-inline'`,
    "font-src data: 'self'",
    "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    `base-uri ${withBase ? "'self'" : "'none'"}`,
  ].join('; ');
}

/** True for `javascript:` URLs the way browsers read them (leading control/space and inner tab/newline ignored). */
export function isJavascriptUrl(value: string): boolean {
  return /^javascript:/i.test(value.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, ''));
}

interface Op extends Splice {
  /** Tie-break between insertions at the same offset (lower first). */
  prio: number;
  seq: number;
}

class OpList {
  private readonly ops: Op[] = [];
  insert(at: number, text: string, prio: number): void {
    this.ops.push({ start: at, end: at, text, prio, seq: this.ops.length });
  }
  replace(start: number, end: number, text: string): void {
    this.ops.push({ start, end, text, prio: 9, seq: this.ops.length });
  }
  /** Sorted splices; operations nested inside a removed range are dropped. */
  splices(removals: ReadonlyArray<readonly [number, number]>): Splice[] {
    const merged: Array<readonly [number, number]> = [];
    for (const r of [...removals].sort((x, y) => x[0] - y[0] || y[1] - x[1])) {
      const last = merged[merged.length - 1];
      if (!last || r[0] >= last[1]) merged.push(r);
    }
    const inside = (op: Op): boolean => merged.some(([s, e]) => op.start > s && op.end < e);
    const all: Op[] = this.ops.filter((op) => !inside(op));
    for (const [start, end] of merged) all.push({ start, end, text: '', prio: 9, seq: -1 });
    all.sort(
      (a, b) =>
        a.start - b.start || Number(a.end > a.start) - Number(b.end > b.start) || a.prio - b.prio || a.seq - b.seq,
    );
    return all.map(({ start, end, text }) => ({ start, end, text }));
  }
}

/** Per-element work: ids, sanitising, current-page marker. Returns removed ranges. */
function planElement(
  index: DocIndex,
  el: ElementInfo,
  currentPageId: NodeId | undefined,
  ops: OpList,
): Array<readonly [number, number]> {
  const { source } = index;
  const tag = el.tag.toLowerCase();
  if (el.startTagEnd === el.start || source[el.start] !== '<') return [];

  if (REMOVED_TAGS.has(tag) || (tag === 'meta' && findAttr(el, 'http-equiv'))) {
    return [[el.start, el.end]];
  }

  const tagEnd = el.start + 1 + el.tag.length;
  let insertion = ` ${PP_ID_ATTR}="${el.id}"`;
  const kind = selectableKind(index, el.id);
  if (kind !== null) insertion += ` ${PP_SEL_ATTR}="${kind}"`;
  const isCurrent = el.id === currentPageId;
  let classHandled = !isCurrent;

  for (const attr of el.attrs) {
    const name = attr.name.toLowerCase();
    const drop =
      name.startsWith('on') ||
      name === PP_ID_ATTR ||
      name === PP_SEL_ATTR ||
      (isUrlAttr(name) && isJavascriptUrl(attr.value));
    if (drop) {
      const [from, to] = attrDeleteRange(source, el, attr);
      ops.replace(from, to, '');
    } else if (isCurrent && name === 'class') {
      classHandled = true;
      markClass(index, attr, ops);
    }
  }
  if (!classHandled) insertion += ` class="${CURRENT_PAGE_CLASS}"`;
  ops.insert(tagEnd, insertion, 5);
  return [];
}

function markClass(index: DocIndex, attr: ElementInfo['attrs'][number], ops: OpList): void {
  if (attr.value.split(/\s+/).includes(CURRENT_PAGE_CLASS)) return;
  const range = attrValueRange(index.source, attr);
  if (range.quote !== null) {
    ops.insert(range.end, range.start === range.end ? CURRENT_PAGE_CLASS : ` ${CURRENT_PAGE_CLASS}`, 5);
  } else {
    const next = `${attr.value} ${CURRENT_PAGE_CLASS}`.trim();
    ops.replace(attr.start, attr.end, `${attr.name}="${escapeAttrValue(next)}"`);
  }
}

function planRange(
  index: DocIndex,
  range: { start: number; end: number },
  currentPageId: NodeId | undefined,
  ops: OpList,
): Array<readonly [number, number]> {
  const removals: Array<readonly [number, number]> = [];
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (!el || el.start < range.start || el.end > range.end) continue;
    removals.push(...planElement(index, el, currentPageId, ops));
  }
  return removals;
}

const escapeForStyle = (text: string): string => text.replace(/<\/(style)/gi, '<\\/$1');

const hasDoctype = (source: string): boolean => /^﻿?(?:\s|<!--[\s\S]*?-->)*<!doctype/i.test(source);

/** The complete edit-frame document for `index`. */
export function buildPreview(index: DocIndex, opts: PreviewOptions): string {
  const { source } = index;
  const ops = new OpList();
  const removals = planRange(index, { start: 0, end: source.length }, opts.currentPageId, ops);

  const get = (id: NodeId | null): ElementInfo | undefined => (id === null ? undefined : index.elements.get(id));
  const html = get(index.html);
  const head = get(index.head);
  const body = get(index.body);

  // Structural elements without tags in the source get explicit ones so they can carry an id.
  for (const [el, prio] of [[html, 0], [head, 1], [body, 4]] as const) {
    if (el && el.startTagEnd === el.start) ops.insert(el.start, `<${el.tag} ${PP_ID_ATTR}="${el.id}">`, prio);
  }

  if (head) {
    const start = [
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${escapeAttrValue(previewCSP(!!opts.baseHref, opts.imageOrigins))}">`,
      opts.baseHref ? `<base href="${escapeAttrValue(opts.baseHref)}">` : '',
    ].join('');
    ops.insert(head.startTagEnd, start, 2);
    ops.insert(head.endTagStart ?? head.end, `<style data-pp-frame>${escapeForStyle(opts.frameCSS)}</style>`, 3);
  }

  const out = applySplices(source, ops.splices(removals));
  return hasDoctype(source) ? out : `<!doctype html>${out}`;
}

/** Outer HTML of one element in preview form (ids injected, sanitised); '' when the element is dropped or implied. */
export function previewFragment(index: DocIndex, id: NodeId, opts: { currentPageId?: NodeId } = {}): string {
  const el = index.elements.get(id);
  if (!el || el.startTagEnd === el.start) return '';
  const ops = new OpList();
  const removals = planRange(index, el, opts.currentPageId, ops);
  const shifted = ops.splices(removals).map((s) => ({ start: s.start - el.start, end: s.end - el.start, text: s.text }));
  return applySplices(index.source.slice(el.start, el.end), shifted);
}
