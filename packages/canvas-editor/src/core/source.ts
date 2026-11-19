import { defaultTreeAdapter, html as p5html, parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { AttrInfo, DocIndex, ElementInfo, NodeId } from '../contracts';
import { assignIds, sessionIds } from './ids';
import type { IdSource } from './ids';

type P5Element = DefaultTreeAdapterMap['element'];
type P5ParentNode = DefaultTreeAdapterMap['parentNode'];
type P5Node = DefaultTreeAdapterMap['node'];

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

export const isVoidTag = (tag: string): boolean => VOID_TAGS.has(tag.toLowerCase());
export const isRawTextTag = (tag: string): boolean => RAW_TEXT_TAGS.has(tag.toLowerCase());

const STRUCTURAL = new Set(['html', 'head', 'body']);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableElement = Mutable<ElementInfo>;

/* ------------------------------------------------------------------------------------------ */
/* Parsing                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Parse with provisional ids (`r0`, `r1`, …); `parseIndex` / `assignIds` make them stable. */
export function parseRawIndex(source: string): DocIndex {
  const doc = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const elements = new Map<NodeId, MutableElement>();
  const order: NodeId[] = [];
  const seenStarts = new Set<number>();
  const roles: Record<'html' | 'head' | 'body', NodeId | null> = { html: null, head: null, body: null };
  let doctypeEnd = 0;

  const add = (info: MutableElement, el: P5Element, parentId: NodeId | null): void => {
    elements.set(info.id, info);
    order.push(info.id);
    if (parentId !== null) elements.get(parentId)?.children.push(info.id);
    const role = roleOf(el, parentId, roles);
    if (role) roles[role] = info.id;
    visit(el, info.id);
  };

  const visit = (node: P5ParentNode, parentId: NodeId | null): void => {
    for (const child of childrenOf(node)) {
      if (defaultTreeAdapter.isDocumentTypeNode(child)) {
        doctypeEnd = child.sourceCodeLocation?.endOffset ?? 0;
        continue;
      }
      if (!defaultTreeAdapter.isElementNode(child)) continue;
      const info = describe(child, parentId, elements.size);
      if (info && !seenStarts.has(info.start)) {
        seenStarts.add(info.start);
        add(info, child, parentId);
      } else if (!info && STRUCTURAL.has(child.tagName)) {
        add(impliedStub(child.tagName, parentId, elements.size), child, parentId);
      } else if (!info) {
        visit(child, parentId); // implied element such as <tbody>: children attach to the nearest indexed ancestor
      }
    }
  };
  visit(doc, null);
  fixImpliedRanges(elements, roles, doctypeEnd, source.length);
  return { source, elements, order, ...roles };
}

/** Parse and give every element a fresh id (`assignIds` with `prev` carries ids across edits instead). */
export function parseIndex(source: string, ids: IdSource = sessionIds): DocIndex {
  return assignIds(parseRawIndex(source), undefined, ids);
}

function childrenOf(node: P5ParentNode): P5Node[] {
  if (defaultTreeAdapter.isElementNode(node as P5Node) && (node as P5Element).tagName === 'template') {
    return [...defaultTreeAdapter.getTemplateContent(node as DefaultTreeAdapterMap['template']).childNodes];
  }
  return [...node.childNodes];
}

function roleOf(
  el: P5Element,
  parentId: NodeId | null,
  roles: Record<'html' | 'head' | 'body', NodeId | null>,
): 'html' | 'head' | 'body' | null {
  if (el.tagName === 'html' && parentId === null) return 'html';
  if (el.tagName === 'head' && parentId === roles.html && roles.head === null) return 'head';
  if (el.tagName === 'body' && parentId === roles.html && roles.body === null) return 'body';
  return null;
}

function describe(el: P5Element, parentId: NodeId | null, seq: number): MutableElement | null {
  const loc = el.sourceCodeLocation;
  if (!loc || !loc.startTag) return null;
  const locAttrs = loc.attrs ? Object.values(loc.attrs).sort((a, b) => a.startOffset - b.startOffset) : [];
  const attrs: AttrInfo[] = [];
  for (let i = 0; i < Math.min(locAttrs.length, el.attrs.length); i++) {
    const a = el.attrs[i];
    const l = locAttrs[i];
    attrs.push({
      name: a.prefix ? `${a.prefix}:${a.name}` : a.name,
      value: a.value,
      start: l.startOffset,
      end: l.endOffset,
    });
  }
  return {
    id: `r${seq}`,
    tag: el.tagName,
    start: loc.startOffset,
    // parse5 leaves end offsets unset (0) for a few error-recovery paths such as <noscript> in <head>.
    end: Math.max(loc.endOffset, loc.startTag.endOffset),
    startTagEnd: loc.startTag.endOffset,
    endTagStart: loc.endTag ? loc.endTag.startOffset : null,
    attrs,
    parent: parentId,
    children: [],
  };
}

function impliedStub(tag: string, parentId: NodeId | null, seq: number): MutableElement {
  return { id: `r${seq}`, tag, start: 0, end: 0, startTagEnd: 0, endTagStart: null, attrs: [], parent: parentId, children: [] };
}

/** Give implied html/head/body ranges at their insertion points. */
function fixImpliedRanges(
  elements: Map<NodeId, MutableElement>,
  roles: Record<'html' | 'head' | 'body', NodeId | null>,
  doctypeEnd: number,
  length: number,
): void {
  const html = roles.html === null ? undefined : elements.get(roles.html);
  const head = roles.head === null ? undefined : elements.get(roles.head);
  const body = roles.body === null ? undefined : elements.get(roles.body);
  const implied = (el: MutableElement | undefined): el is MutableElement => !!el && el.start === el.startTagEnd;
  const lastChildEnd = (el: MutableElement): number =>
    el.children.reduce((max, id) => Math.max(max, elements.get(id)?.end ?? 0), 0);

  if (implied(html)) {
    html.start = html.startTagEnd = doctypeEnd;
    html.end = length;
  }
  const afterHtmlTag = html ? html.startTagEnd : 0;
  if (implied(head)) {
    head.start = head.startTagEnd = afterHtmlTag;
    head.end = Math.max(afterHtmlTag, lastChildEnd(head));
  }
  if (implied(body)) {
    const p = Math.max(head ? head.end : 0, afterHtmlTag);
    body.start = body.startTagEnd = p;
    body.end = Math.max(p, html ? (html.endTagStart ?? html.end) : length);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Lookup helpers                                                                             */
/* ------------------------------------------------------------------------------------------ */

export function getElement(index: DocIndex, id: NodeId): ElementInfo | undefined {
  return index.elements.get(id);
}

export function* iterElements(index: DocIndex): Generator<ElementInfo> {
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (el) yield el;
  }
}

export function findAttr(el: ElementInfo, name: string): AttrInfo | undefined {
  return el.attrs.find((a) => a.name === name) ?? el.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

/** Decoded attribute value, or null when absent. */
export function getAttr(el: ElementInfo, name: string): string | null {
  return findAttr(el, name)?.value ?? null;
}

export function classList(el: ElementInfo): string[] {
  return (getAttr(el, 'class') ?? '').split(/[\t\n\f\r ]+/).filter(Boolean);
}

export function hasClass(el: ElementInfo, name: string): boolean {
  return classList(el).includes(name);
}

export function findByTag(index: DocIndex, tag: string): ElementInfo[] {
  const t = tag.toLowerCase();
  return [...iterElements(index)].filter((el) => el.tag.toLowerCase() === t);
}

export function findByClass(index: DocIndex, name: string): ElementInfo[] {
  return [...iterElements(index)].filter((el) => hasClass(el, name));
}

/** Elements carrying attribute `name` (with exactly `value` when given). */
export function findByAttr(index: DocIndex, name: string, value?: string): ElementInfo[] {
  return [...iterElements(index)].filter((el) => {
    const v = getAttr(el, name);
    return v !== null && (value === undefined || v === value);
  });
}

export function isAncestor(index: DocIndex, ancestorId: NodeId, id: NodeId): boolean {
  for (let cur = index.elements.get(id)?.parent ?? null; cur !== null; cur = index.elements.get(cur)?.parent ?? null) {
    if (cur === ancestorId) return true;
  }
  return false;
}

/** Source text between the start tag and the end tag (empty for void / unclosed-empty elements). */
export function innerSource(index: DocIndex, el: ElementInfo): string {
  return index.source.slice(el.startTagEnd, el.endTagStart ?? el.end);
}

export function outerSource(index: DocIndex, el: ElementInfo): string {
  return index.source.slice(el.start, el.end);
}

/** Text content of an element as a browser would compute it (entities decoded, comments skipped). */
export function textContent(index: DocIndex, id: NodeId): string {
  const el = index.elements.get(id);
  if (!el) return '';
  const context = defaultTreeAdapter.createElement(el.tag.toLowerCase(), p5html.NS.HTML, []);
  const fragment = parseFragment(context, innerSource(index, el), { scriptingEnabled: false });
  let out = '';
  const walk = (node: P5ParentNode): void => {
    for (const child of node.childNodes) {
      if (defaultTreeAdapter.isTextNode(child)) out += child.value;
      else if (defaultTreeAdapter.isElementNode(child) && child.tagName !== 'template') walk(child);
    }
  };
  walk(fragment);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Attribute value ranges                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface AttrValueRange {
  /** Raw value text range (without quotes). Zero-length at the attribute end for valueless attributes. */
  start: number;
  end: number;
  quote: '"' | "'" | null;
  hasValue: boolean;
}

/** Locate the raw value of an attribute inside the source. */
export function attrValueRange(source: string, attr: AttrInfo): AttrValueRange {
  const text = source.slice(attr.start, attr.end);
  const m = /^[^\s/>=]+(\s*=\s*)?/.exec(text);
  if (!m || !m[1]) return { start: attr.end, end: attr.end, quote: null, hasValue: false };
  const valueStart = attr.start + m[0].length;
  const first = source[valueStart];
  if ((first === '"' || first === "'") && attr.end - valueStart >= 2 && source[attr.end - 1] === first) {
    return { start: valueStart + 1, end: attr.end - 1, quote: first, hasValue: true };
  }
  return { start: valueStart, end: attr.end, quote: null, hasValue: true };
}

/** Escape text for use inside an attribute value delimited by `quote`. */
export function escapeAttrValue(value: string, quote: '"' | "'" = '"'): string {
  const escaped = value.replace(/&/g, '&amp;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&#39;');
}

/** Range to delete to drop an attribute together with the whitespace in front of it. */
export function attrDeleteRange(source: string, el: ElementInfo, attr: AttrInfo): [number, number] {
  const floor = el.start + 1 + el.tag.length;
  let from = attr.start;
  while (from > floor && /\s/.test(source[from - 1])) from--;
  return [from, attr.end];
}

/** Offset just after the last attribute (or tag name): where new attributes are inserted. */
export function attrInsertPos(el: ElementInfo): number {
  const last = el.attrs.reduce((max, a) => Math.max(max, a.end), 0);
  return last > 0 ? last : el.start + 1 + el.tag.length;
}

/* ------------------------------------------------------------------------------------------ */
/* Whitespace / line helpers                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function lineStart(source: string, pos: number): number {
  return source.lastIndexOf('\n', pos - 1) + 1;
}

/** Indentation when `pos` is preceded only by whitespace on its line, else null. */
export function leadingIndent(source: string, pos: number): string | null {
  const prefix = source.slice(lineStart(source, pos), pos);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

export function detectEol(source: string): string {
  const i = source.indexOf('\n');
  return i > 0 && source[i - 1] === '\r' ? '\r\n' : '\n';
}
