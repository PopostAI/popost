/**
 * EditOp -> minimal source splices (+ inverse, + live-frame updates), with a locality check:
 * after every op the document is re-parsed and the structure outside the changed ranges must
 * be unchanged, otherwise the op is rejected with an `EditError`.
 */
import type { DocIndex, EditOp, EditResult, ElementInfo, LiveUpdate, NodeId, Splice } from '../contracts';
import { patchAttributes } from './fastpath';
import { assignIds, isImplied, mapStart, matchElements } from './ids';
import type { IdSource, PrevState, Relocation } from './ids';
import { pageRoots, defaultRandomHex, newPageKey, selectableKind } from './pages';
import { isJavascriptUrl, isUrlAttr, previewFragment } from './preview';
import {
  attrDeleteRange,
  attrInsertPos,
  attrValueRange,
  detectEol,
  escapeAttrValue,
  findAttr,
  getAttr,
  isAncestor,
  isRawTextTag,
  isVoidTag,
  leadingIndent,
  lineStart,
  parseRawIndex,
} from './source';
import { isSafeStyleValue, isValidPropName, mergeStyle, normalizeProp } from './style';
import { applySplices, assertValidSplices, diffSplices, invertSplices, mapOffset } from './splices';

export { applySplices, invertSplices };

export type EditErrorCode = 'unknown-element' | 'invalid-op' | 'unsupported' | 'locality';

export class EditError extends Error {
  readonly code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

export interface EditContext extends IdSource {
  /** Random lower-case hex of the given length (defaults to Web Crypto); injectable for tests. */
  randomHex?(length: number): string;
}

interface Plan {
  splices: Splice[];
  moved?: Relocation[];
  /** Skip the locality check (whole-document replacement). */
  skipLocality?: boolean;
  /** Edits start-tag attributes only: try `patchAttributes` before a full re-parse. */
  attrLocal?: boolean;
  live(next: DocIndex): { live: LiveUpdate[]; createdId?: NodeId };
}

const STRUCTURAL = new Set(['html', 'head', 'body']);
/** Elements whose DOM parent may be an implied element, so incremental live updates are unreliable. */
const RELOAD_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'select', 'option', 'optgroup']);

/* ------------------------------------------------------------------------------------------ */
/* Public API                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export function applyOp(index: DocIndex, op: EditOp, ctx: EditContext): EditResult {
  const plan = planOp(index, op, ctx);
  return finish(index, plan, ctx);
}

/**
 * Apply raw splices (undo / redo) and reindex with stable ids. No locality check: history only
 * replays states that were valid when recorded. The frame is reloaded.
 */
export function applySplicesToIndex(index: DocIndex, splices: readonly Splice[], ctx: IdSource): EditResult {
  if (splices.length === 0) return { index, splices: [], inverse: [], live: [] };
  const list = [...splices];
  const source = applySplices(index.source, list);
  const next = patchAttributes(index, list, source) ?? assignIds(parseRawIndex(source), { index, splices: list }, ctx);
  return { index: next, splices: list, inverse: invertSplices(index.source, list), live: [{ kind: 'reload' }] };
}

/** Throws `EditError('locality')` when structure outside the changed ranges differs between the two indexes. */
export function checkLocality(old: DocIndex, raw: DocIndex, splices: readonly Splice[], moved: readonly Relocation[] = []): void {
  const prev: PrevState = { index: old, splices, moved };
  const pairs = matchElements(raw, prev);
  const fail = (what: string): never => {
    throw new EditError('locality', `edit would change the document structure outside its target (${what})`);
  };
  const mapPos = (pos: number, assoc: -1 | 1): number => {
    for (const r of moved) if (pos > r.from && pos < r.from + r.length) return r.to + (pos - r.from);
    return mapOffset(splices, pos, assoc);
  };
  const relocatedRoots = new Set(moved.map((r) => r.from));

  for (const el of old.elements.values()) {
    if (isImplied(el)) continue;
    if (mapStart(prev, el.start) === null) continue; // inside a replaced range
    const rawId = pairs.get(el.id);
    const next = rawId === undefined ? undefined : raw.elements.get(rawId);
    if (!next) return fail(`<${el.tag}> lost`);

    if (el.parent !== null && !relocatedRoots.has(el.start)) {
      const parentRaw = pairs.get(el.parent);
      if (parentRaw !== undefined && next.parent !== parentRaw) fail(`<${el.tag}> changed parent`);
    }
    if (next.startTagEnd !== mapPos(el.startTagEnd, -1)) fail(`<${el.tag}> start tag changed`);
    if (el.endTagStart !== null && next.endTagStart !== mapPos(el.endTagStart, 1)) fail(`<${el.tag}> end tag moved`);
  }

  const matchedRaw = new Set(pairs.values());
  const changed = newRanges(splices);
  for (const el of raw.elements.values()) {
    if (isImplied(el) || matchedRaw.has(el.id)) continue;
    if (!changed.some(([s, e]) => el.start >= s && el.start < e)) fail(`unexpected <${el.tag}>`);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Plumbing                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function newRanges(splices: readonly Splice[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let shift = 0;
  for (const s of splices) {
    const start = s.start + shift;
    out.push([start, start + s.text.length]);
    shift += s.text.length - (s.end - s.start);
  }
  return out;
}

/** Full path: re-parse the whole document, verify locality, carry ids across. */
function reindex(index: DocIndex, plan: Plan, splices: Splice[], source: string, ctx: EditContext): DocIndex {
  const raw = parseRawIndex(source);
  if (!plan.skipLocality) checkLocality(index, raw, splices, plan.moved);
  return assignIds(raw, { index, splices, moved: plan.moved }, ctx);
}

function finish(index: DocIndex, plan: Plan, ctx: EditContext): EditResult {
  const splices = plan.splices.filter((s) => s.end > s.start || s.text !== '');
  if (splices.length === 0) return { index, splices: [], inverse: [], live: [] };
  assertValidSplices(splices, index.source.length);

  const source = applySplices(index.source, splices);
  const next = (plan.attrLocal ? patchAttributes(index, splices, source) : null) ?? reindex(index, plan, splices, source, ctx);
  const { live, createdId } = plan.live(next);
  const result: EditResult = { index: next, splices, inverse: invertSplices(index.source, splices), live };
  if (createdId !== undefined) result.createdId = createdId;
  return result;
}

function planOp(index: DocIndex, op: EditOp, ctx: EditContext): Plan {
  switch (op.kind) {
    case 'setInnerHTML':
      return planSetInnerHTML(index, op.id, op.html);
    case 'setStyle':
      return planSetStyle(index, op.id, op.props);
    case 'setAttr':
      return planSetAttr(index, op.id, op.name, op.value);
    case 'remove':
      return planRemove(index, op.id);
    case 'duplicate':
      return planDuplicate(index, op.id, ctx);
    case 'move':
      return planMove(index, op.id, op.parentId, op.beforeId);
    case 'insertHTML':
      return planInsertHTML(index, op.parentId, op.beforeId, op.html);
    case 'upsertFontStyle':
      return planFontStyle(index, op.key, op.css);
    case 'replaceDocument':
      return planReplace(index, op.source);
  }
}

function need(index: DocIndex, id: NodeId): ElementInfo {
  const el = index.elements.get(id);
  if (!el) throw new EditError('unknown-element', `unknown element ${id}`);
  return el;
}

function needStartTag(el: ElementInfo): void {
  if (isImplied(el)) throw new EditError('unsupported', `<${el.tag}> has no start tag in the source`);
}

function contentRange(index: DocIndex, el: ElementInfo): [number, number] {
  const selfClosed = el.endTagStart === null && el.startTagEnd === el.end && index.source.slice(el.end - 2, el.end) === '/>';
  if (isVoidTag(el.tag) || selfClosed) throw new EditError('unsupported', `<${el.tag}> cannot have content`);
  return [el.startTagEnd, el.endTagStart ?? el.end];
}

const isStructural = (el: ElementInfo): boolean => STRUCTURAL.has(el.tag);

function nextSibling(index: DocIndex, id: NodeId): NodeId | null {
  const parent = index.elements.get(index.elements.get(id)?.parent ?? '');
  if (!parent) return null;
  return parent.children[parent.children.indexOf(id) + 1] ?? null;
}

/** Preview-form description of an attribute change (matches what `buildPreview` would emit). */
function previewAttrValue(name: string, value: string | null): string | null {
  const n = name.toLowerCase();
  if (value === null || n.startsWith('on') || n === 'data-pp-id') return null;
  if (isUrlAttr(n) && isJavascriptUrl(value)) return null;
  return value;
}

/** True when the element is part of the frame document (scripts etc. are stripped from previews). */
const inFrame = (index: DocIndex, id: NodeId): boolean => previewFragment(index, id) !== '';

/* ------------------------------------------------------------------------------------------ */
/* Whitespace-aware ranges                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Range to delete when removing [start, end): whole lines for block-style elements, else just the element. */
function removalRange(source: string, start: number, end: number): [number, number] {
  const indent = leadingIndent(source, start);
  let j = end;
  while (source[j] === ' ' || source[j] === '\t') j++;
  const eolLen = source.startsWith('\r\n', j) ? 2 : source[j] === '\n' ? 1 : j >= source.length ? 0 : -1;
  if (indent !== null && eolLen >= 0) return [lineStart(source, start), j + eolLen];
  if (indent !== null) return [start, j];
  if (eolLen >= 0) {
    let from = start;
    while (source[from - 1] === ' ' || source[from - 1] === '\t') from--;
    return [from, end];
  }
  return [start, end];
}

interface Insertion {
  pos: number;
  text: string;
  /** Offset of the payload inside `text` (after the generated line break and indent). */
  payloadAt: number;
}

function insertAfter(source: string, el: ElementInfo, payload: string): Insertion {
  const indent = leadingIndent(source, el.start);
  const prefix = indent === null ? '' : detectEol(source) + indent;
  return { pos: el.end, text: prefix + payload, payloadAt: prefix.length };
}

function insertBefore(source: string, ref: ElementInfo, payload: string): Insertion {
  const indent = leadingIndent(source, ref.start);
  const suffix = indent === null ? '' : detectEol(source) + indent;
  return { pos: ref.start, text: payload + suffix, payloadAt: 0 };
}

function appendInto(index: DocIndex, parent: ElementInfo, payload: string): Insertion {
  const [, contentEnd] = contentRange(index, parent);
  const lastId = parent.children[parent.children.length - 1];
  const last = lastId === undefined ? undefined : index.elements.get(lastId);
  if (last && last.end <= contentEnd && /^\s*$/.test(index.source.slice(last.end, contentEnd))) {
    return insertAfter(index.source, last, payload);
  }
  return { pos: contentEnd, text: payload, payloadAt: 0 };
}

function insertionAt(index: DocIndex, parentId: NodeId, beforeId: NodeId | null, payload: string): Insertion {
  const parent = need(index, parentId);
  if (isRawTextTag(parent.tag)) throw new EditError('unsupported', `<${parent.tag}> cannot contain elements`);
  contentRange(index, parent);
  if (beforeId === null) return appendInto(index, parent, payload);
  const ref = need(index, beforeId);
  if (ref.parent !== parentId) throw new EditError('invalid-op', 'beforeId is not a child of parentId');
  needStartTag(ref);
  return insertBefore(index.source, ref, payload);
}

/* ------------------------------------------------------------------------------------------ */
/* setInnerHTML                                                                               */
/* ------------------------------------------------------------------------------------------ */

function planSetInnerHTML(index: DocIndex, id: NodeId, html: string): Plan {
  const el = need(index, id);
  const [start, end] = contentRange(index, el);
  const splices = index.source.slice(start, end) === html ? [] : [{ start, end, text: html }];
  return {
    splices,
    live: (next) => {
      if (isStructural(el)) return { live: [{ kind: 'reload' }] };
      if (!inFrame(next, id)) return { live: [] };
      return { live: [{ kind: 'subtrees', items: [{ id, previewHTML: previewFragment(next, id) }] }] };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* setStyle / setAttr                                                                         */
/* ------------------------------------------------------------------------------------------ */

function wholeAttr(name: string, value: string): string {
  return `${name}="${escapeAttrValue(value)}"`;
}

/** Splice that sets attribute `name` to `value` on `el` (adds it when missing). */
function setAttrSplice(index: DocIndex, el: ElementInfo, name: string, value: string): Splice | null {
  const attr = findAttr(el, name);
  if (!attr) {
    const at = attrInsertPos(el);
    return { start: at, end: at, text: ` ${wholeAttr(name, value)}` };
  }
  if (attr.value === value) return null;
  const range = attrValueRange(index.source, attr);
  if (range.hasValue && range.quote !== null) {
    // Parsed values have CRLF folded to LF; keep the document's line endings, and touch only what differs.
    const raw = index.source.slice(range.start, range.end);
    let text = escapeAttrValue(value, range.quote);
    if (raw.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
    const [diff] = diffSplices(raw, text);
    return diff ? { start: range.start + diff.start, end: range.start + diff.end, text: diff.text } : null;
  }
  return { start: attr.start, end: attr.end, text: wholeAttr(attr.name, value) };
}

function removeAttrSplice(index: DocIndex, el: ElementInfo, name: string): Splice | null {
  const attr = findAttr(el, name);
  if (!attr) return null;
  const [start, end] = attrDeleteRange(index.source, el, attr);
  return { start, end, text: '' };
}

/**
 * True when an attribute edit changed whether the element (or, for `class` edits, anything below it) is a
 * selectable block, or its kind, so the frame's `data-pp-sel` marks need refreshing.
 */
function marksChanged(old: DocIndex, next: DocIndex, id: NodeId, withDescendants: boolean): boolean {
  const ids: NodeId[] = [id];
  if (withDescendants) {
    const el = next.elements.get(id);
    if (el) for (const other of next.order) {
      const o = next.elements.get(other);
      if (o && o.id !== id && o.start >= el.start && o.end <= el.end) ids.push(other);
    }
  }
  return ids.some((i) => selectableKind(old, i) !== selectableKind(next, i));
}

/** Re-render the touched element (page roots and elements outside the frame fall back to reload / nothing). */
function subtreeUpdate(old: DocIndex, next: DocIndex, id: NodeId): LiveUpdate[] {
  if ([old, next].some((i) => pageRoots(i).some((p) => p.id === id))) return [{ kind: 'reload' }];
  const previewHTML = previewFragment(next, id);
  return previewHTML === '' ? [] : [{ kind: 'subtrees', items: [{ id, previewHTML }] }];
}

function planSetStyle(index: DocIndex, id: NodeId, props: Readonly<Record<string, string | null>>): Plan {
  const el = need(index, id);
  needStartTag(el);
  const clean: Record<string, string | null> = {};
  for (const [rawName, value] of Object.entries(props)) {
    if (!isValidPropName(rawName)) throw new EditError('invalid-op', `invalid CSS property name "${rawName}"`);
    if (value !== null && !isSafeStyleValue(value)) throw new EditError('invalid-op', `unsafe CSS value for ${rawName}`);
    clean[normalizeProp(rawName)] = value;
  }
  const current = getAttr(el, 'style') ?? '';
  const merged = mergeStyle(current, clean);
  let splice: Splice | null = null;
  if (merged !== current) {
    splice = merged.trim() === '' ? removeAttrSplice(index, el, 'style') : setAttrSplice(index, el, 'style', merged);
  }
  return {
    splices: splice ? [splice] : [],
    attrLocal: true,
    live: (next) => ({
      live: marksChanged(index, next, id, false) ? subtreeUpdate(index, next, id) : [{ kind: 'style', id, props: clean }],
    }),
  };
}

const ATTR_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

function planSetAttr(index: DocIndex, id: NodeId, name: string, value: string | null): Plan {
  const el = need(index, id);
  needStartTag(el);
  if (!ATTR_NAME.test(name)) throw new EditError('invalid-op', `invalid attribute name "${name}"`);
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || lower.startsWith('data-pp-')) throw new EditError('invalid-op', `attribute "${name}" is not allowed`);
  const splice = value === null ? removeAttrSplice(index, el, name) : setAttrSplice(index, el, name, value);
  return {
    splices: splice ? [splice] : [],
    attrLocal: true,
    live: (next) => ({
      live: marksChanged(index, next, id, lower === 'class')
        ? subtreeUpdate(index, next, id)
        : [{ kind: 'attr', id, name, value: previewAttrValue(name, value) }],
    }),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* remove / duplicate / move / insertHTML                                                     */
/* ------------------------------------------------------------------------------------------ */

function planRemove(index: DocIndex, id: NodeId): Plan {
  const el = need(index, id);
  if (isStructural(el)) throw new EditError('unsupported', `<${el.tag}> cannot be removed`);
  const [start, end] = removalRange(index.source, el.start, el.end);
  return { splices: [{ start, end, text: '' }], live: () => ({ live: [{ kind: 'remove', id }] }) };
}

/** Replace the `data-popost-page` value of every top-level page root inside [el.start, el.end) in the copy. */
function freshPageKeys(index: DocIndex, el: ElementInfo, ctx: EditContext): string {
  const hex = ctx.randomHex ?? defaultRandomHex;
  const used = new Set(pageRoots(index).map((p) => getAttr(p, 'data-popost-page')));
  const splices: Splice[] = [];
  for (const root of pageRoots(index)) {
    const attr = findAttr(root, 'data-popost-page');
    if (!attr || root.start < el.start || root.end > el.end) continue;
    let key = newPageKey(hex);
    while (used.has(key)) key = newPageKey(hex);
    used.add(key);
    const range = attrValueRange(index.source, attr);
    if (!range.hasValue) continue;
    splices.push({ start: range.start - el.start, end: range.end - el.start, text: key });
  }
  splices.sort((a, b) => a.start - b.start);
  return applySplices(index.source.slice(el.start, el.end), splices);
}

function elementStartingAt(next: DocIndex, pos: number): ElementInfo | undefined {
  for (const id of next.order) {
    const el = next.elements.get(id);
    if (el && !isImplied(el) && el.start === pos) return el;
  }
  return undefined;
}

function planDuplicate(index: DocIndex, id: NodeId, ctx: EditContext): Plan {
  const el = need(index, id);
  if (isStructural(el)) throw new EditError('unsupported', `<${el.tag}> cannot be duplicated`);
  const ins = insertAfter(index.source, el, freshPageKeys(index, el, ctx));
  return {
    splices: [{ start: ins.pos, end: ins.pos, text: ins.text }],
    live: (next) => {
      const created = elementStartingAt(next, ins.pos + ins.payloadAt);
      if (!created) throw new EditError('locality', 'duplicate did not produce an element');
      return { createdId: created.id, live: liveInsert(next, [created]) };
    },
  };
}

/** `insert` updates for freshly created sibling elements (reverse order, so each `beforeId` already exists). */
function liveInsert(next: DocIndex, created: readonly ElementInfo[]): LiveUpdate[] {
  const out: LiveUpdate[] = [];
  for (const el of [...created].reverse()) {
    const parent = el.parent === null ? undefined : next.elements.get(el.parent);
    if (!parent || RELOAD_TAGS.has(el.tag) || RELOAD_TAGS.has(parent.tag)) return [{ kind: 'reload' }];
    const previewHTML = previewFragment(next, el.id);
    if (previewHTML === '') continue;
    out.push({ kind: 'insert', parentId: parent.id, beforeId: nextSibling(next, el.id), previewHTML });
  }
  return out;
}

function planMove(index: DocIndex, id: NodeId, parentId: NodeId, beforeId: NodeId | null): Plan {
  const el = need(index, id);
  if (isStructural(el)) throw new EditError('unsupported', `<${el.tag}> cannot be moved`);
  needStartTag(el);
  const parent = need(index, parentId);
  if (parentId === id || isAncestor(index, id, parentId)) throw new EditError('invalid-op', 'cannot move an element into itself');
  if (beforeId === id) return noop();
  if (parent.id === el.parent) {
    const siblings = parent.children;
    const following = siblings[siblings.indexOf(id) + 1] ?? null;
    if (beforeId === following) return noop();
  }

  const payload = index.source.slice(el.start, el.end);
  const ins = insertionAt(index, parentId, beforeId, payload);
  const [rs, re] = removalRange(index.source, el.start, el.end);
  if (ins.pos > rs && ins.pos < re) throw new EditError('invalid-op', 'move target lies inside the moved range');

  const removal: Splice = { start: rs, end: re, text: '' };
  const insertion: Splice = { start: ins.pos, end: ins.pos, text: ins.text };
  const to = mapOffset([removal], ins.pos, 1) + ins.payloadAt;
  return {
    splices: [removal, insertion].sort((a, b) => a.start - b.start || Number(a.end > a.start) - Number(b.end > b.start)),
    moved: [{ from: el.start, to, length: el.end - el.start }],
    live: (next) => {
      if (RELOAD_TAGS.has(el.tag) || RELOAD_TAGS.has(parent.tag)) return { live: [{ kind: 'reload' }] };
      if (!inFrame(next, id)) return { live: [] };
      return { live: [{ kind: 'move', id, parentId, beforeId }] };
    },
  };
}

function noop(): Plan {
  return { splices: [], live: () => ({ live: [] }) };
}

function planInsertHTML(index: DocIndex, parentId: NodeId, beforeId: NodeId | null, html: string): Plan {
  const payload = html.trim();
  if (payload === '') throw new EditError('invalid-op', 'nothing to insert');
  const ins = insertionAt(index, parentId, beforeId, payload);
  const payloadStart = ins.pos + ins.payloadAt;
  return {
    splices: [{ start: ins.pos, end: ins.pos, text: ins.text }],
    live: (next) => {
      const tops = [...next.elements.values()]
        .filter((e) => !isImplied(e) && e.parent === parentId && e.start >= payloadStart && e.start < payloadStart + payload.length)
        .sort((a, b) => a.start - b.start);
      const first = tops[0];
      if (!first) {
        if (/^<[a-zA-Z]/.test(payload)) throw new EditError('locality', 'inserted markup produced no element under the target');
        return { live: [{ kind: 'reload' }] }; // plain text
      }
      let rest = '';
      let pos = payloadStart;
      for (const e of tops) {
        rest += next.source.slice(pos, e.start);
        pos = e.end;
      }
      rest += next.source.slice(pos, payloadStart + payload.length);
      const live = rest.trim() === '' ? liveInsert(next, tops) : ([{ kind: 'reload' }] as LiveUpdate[]);
      return { createdId: first.id, live };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Fonts / whole document                                                                     */
/* ------------------------------------------------------------------------------------------ */

function planFontStyle(index: DocIndex, key: string, css: string): Plan {
  if (key === '' || /[\u0000-\u001f]/.test(key)) throw new EditError('invalid-op', 'invalid font key');
  if (/<\/style/i.test(css)) throw new EditError('invalid-op', 'css must not contain </style');
  const head = index.head === null ? undefined : index.elements.get(index.head);
  if (!head) throw new EditError('unsupported', 'document has no <head>');

  const existing = [...index.elements.values()].filter((e) => e.tag === 'style' && getAttr(e, 'data-popost-font') === key);
  const live = (): { live: LiveUpdate[] } => ({ live: [{ kind: 'headStyle', key, css }] });
  const [first, ...duplicates] = existing;
  if (!first) {
    const tag = `<style data-popost-font="${escapeAttrValue(key)}">${css}</style>`;
    const ins = appendInto(index, head, tag);
    return { splices: [{ start: ins.pos, end: ins.pos, text: ins.text }], live };
  }
  const splices: Splice[] = [];
  const [start, end] = contentRange(index, first);
  if (index.source.slice(start, end) !== css) splices.push({ start, end, text: css });
  for (const dup of duplicates) {
    const [from, to] = removalRange(index.source, dup.start, dup.end);
    splices.push({ start: from, end: to, text: '' });
  }
  splices.sort((a, b) => a.start - b.start);
  return { splices, live };
}

function planReplace(index: DocIndex, source: string): Plan {
  return { splices: diffSplices(index.source, source), skipLocality: true, live: () => ({ live: [{ kind: 'reload' }] }) };
}
