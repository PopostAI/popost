import type { DocIndex, EditOp, ElementInfo, NodeId, PageInfo } from '../contracts';
import { getAttr, hasClass } from './source';
import { parseStyle } from './style';

export interface PageSize {
  width: number;
  height: number;
}

export const DEFAULT_PAGE_SIZE: PageSize = { width: 1280, height: 720 };

/** Canvas size for the host `ratio` parameter: `1:1`, `3:4`, `9:16`, any other value, or none. */
export function ratioSize(ratio: string | null | undefined): PageSize {
  const r = (ratio ?? '').trim();
  if (r === '') return DEFAULT_PAGE_SIZE;
  if (r === '1:1') return { width: 1080, height: 1080 };
  if (r === '3:4') return { width: 1080, height: 1440 };
  if (r === '9:16') return { width: 1080, height: 1920 };
  return { width: 1080, height: 1350 };
}

function insideTemplate(index: DocIndex, el: ElementInfo): boolean {
  for (let cur = el.parent; cur !== null; cur = index.elements.get(cur)?.parent ?? null) {
    if (index.elements.get(cur)?.tag === 'template') return true;
  }
  return false;
}

function hasSlideAncestor(index: DocIndex, el: ElementInfo): boolean {
  for (let cur = el.parent; cur !== null; ) {
    const parent = index.elements.get(cur);
    if (!parent) return false;
    if (hasClass(parent, 'slide')) return true;
    cur = parent.parent;
  }
  return false;
}

/** Top-level `.slide` elements (not nested in another `.slide`), in document order. */
export function pageRoots(index: DocIndex): ElementInfo[] {
  const out: ElementInfo[] = [];
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (el && hasClass(el, 'slide') && !hasSlideAncestor(index, el) && !insideTemplate(index, el)) out.push(el);
  }
  return out;
}

export function isPageRoot(index: DocIndex, id: NodeId): boolean {
  return pageRoots(index).some((el) => el.id === id);
}

/** The page root containing (or equal to) the element, or null. */
export function pageOf(index: DocIndex, id: NodeId): NodeId | null {
  const roots = new Set(pageRoots(index).map((el) => el.id));
  for (let cur: NodeId | null = id; cur !== null; cur = index.elements.get(cur)?.parent ?? null) {
    if (roots.has(cur)) return cur;
  }
  return null;
}

function positivePx(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function inlineStyleDimension(el: ElementInfo, prop: 'width' | 'height'): number | null {
  const style = getAttr(el, 'style');
  if (!style) return null;
  // Last declaration wins; only plain px values count.
  const pattern = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]*)`, 'gi');
  let value: string | null = null;
  for (let m = pattern.exec(style); m; m = pattern.exec(style)) value = m[1].replace(/!important/i, '');
  return value === null ? null : positivePx(/px\s*$/i.test(value.trim()) ? value : null);
}

function dimension(el: ElementInfo, prop: 'width' | 'height', fallback: number): number {
  return positivePx(getAttr(el, `data-popost-${prop}`)) ?? inlineStyleDimension(el, prop) ?? fallback;
}

export function pageSize(el: ElementInfo, ratio?: string | null): PageSize {
  const base = ratioSize(ratio);
  return { width: dimension(el, 'width', base.width), height: dimension(el, 'height', base.height) };
}

export function detectPages(index: DocIndex, opts: { ratio?: string | null } = {}): PageInfo[] {
  return pageRoots(index).map((el, i) => ({
    id: el.id,
    pageKey: getAttr(el, 'data-popost-page'),
    name: getAttr(el, 'data-popost-name') || `Page ${i + 1}`,
    ...pageSize(el, opts.ratio),
  }));
}

/** `p-` + 12 lowercase hex characters. */
export function newPageKey(randomHex: (length: number) => string = defaultRandomHex): string {
  return `p-${randomHex(12)}`;
}

export function defaultRandomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

/* ---- page operations expressed as EditOps ---- */

export function duplicatePageOp(id: NodeId): EditOp {
  return { kind: 'duplicate', id };
}

/** Delete op for a page, or null when it is the last page (or not a page). */
export function deletePageOp(index: DocIndex, id: NodeId): EditOp | null {
  const roots = pageRoots(index);
  if (roots.length <= 1 || !roots.some((el) => el.id === id)) return null;
  return { kind: 'remove', id };
}

/**
 * Move op that puts page `id` at position `toIndex` (0-based, clamped) of the page list.
 * Null when the page is already there.
 */
export function movePageOp(index: DocIndex, id: NodeId, toIndex: number): EditOp | null {
  const roots = pageRoots(index);
  const from = roots.findIndex((el) => el.id === id);
  if (from < 0) return null;
  const target = Math.max(0, Math.min(toIndex, roots.length - 1));
  if (target === from) return null;

  const rest = roots.filter((el) => el.id !== id);
  const before = rest[target];
  if (before) {
    return before.parent === null ? null : { kind: 'move', id, parentId: before.parent, beforeId: before.id };
  }
  const last = rest[rest.length - 1];
  if (!last || last.parent === null) return null;
  const siblings = index.elements.get(last.parent)?.children ?? [];
  const next = siblings[siblings.indexOf(last.id) + 1];
  return { kind: 'move', id, parentId: last.parent, beforeId: next === id ? (siblings[siblings.indexOf(id) + 1] ?? null) : (next ?? null) };
}

/* ---- selectable blocks (SPEC §5) ---- */

export type BlockKind = 'text' | 'image' | 'svg' | 'video' | 'box';

const MEDIA_KIND: Record<string, BlockKind> = { img: 'image', picture: 'image', svg: 'svg', video: 'video' };
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'figcaption']);
/** Elements that are never selectable, nor is anything inside them. */
const HIDDEN_TAGS = new Set(['style', 'script', 'template', 'noscript']);
/** Their descendants are not selectable (the elements themselves can be). */
const OPAQUE_TAGS = new Set(['svg', 'picture', 'video']);

/** Facts about an element's strict ancestors, computed once per element and memoised per index. */
interface AncestorCtx {
  /** Page root among the strict ancestors, or null. */
  root: NodeId | null;
  slideAbove: boolean;
  templateAbove: boolean;
  /** Some strict ancestor excludes this element (hidden tag, `.notes`, or svg/picture/video). */
  blocked: boolean;
  /** Some strict ancestor below the page root is a text tag or has direct text. */
  textAbove: boolean;
}

interface Analysis {
  ctx: Map<NodeId, AncestorCtx>;
  directText: Map<NodeId, boolean>;
}

const analyses = new WeakMap<DocIndex, Analysis>();

function analysisOf(index: DocIndex): Analysis {
  let a = analyses.get(index);
  if (!a) {
    a = { ctx: new Map(), directText: new Map() };
    analyses.set(index, a);
  }
  return a;
}

const isHidden = (el: ElementInfo): boolean => HIDDEN_TAGS.has(el.tag.toLowerCase()) || hasClass(el, 'notes');

const NAMED_SPACE = /&(?:nbsp|ensp|emsp|thinsp|#160|#xa0|#32|#x20|#9|#10|#13);/gi;

/** True when `text` (a gap between child elements) holds visible characters. */
function hasVisibleText(text: string): boolean {
  const plain = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<[!?][^>]*>?/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>?/g, '')
    .replace(NAMED_SPACE, ' ');
  return /\S/.test(plain);
}

function hasDirectText(index: DocIndex, el: ElementInfo): boolean {
  const memo = analysisOf(index).directText;
  const cached = memo.get(el.id);
  if (cached !== undefined) return cached;
  const end = el.endTagStart ?? el.end;
  let pos = el.startTagEnd;
  let found = false;
  for (const childId of el.children) {
    const child = index.elements.get(childId);
    if (!child) continue;
    if (child.start > pos && hasVisibleText(index.source.slice(pos, child.start))) {
      found = true;
      break;
    }
    pos = Math.max(pos, child.end);
  }
  if (!found && end > pos) found = hasVisibleText(index.source.slice(pos, end));
  memo.set(el.id, found);
  return found;
}

const isTextBlockTag = (el: ElementInfo): boolean => TEXT_TAGS.has(el.tag.toLowerCase());

function isRootGiven(el: ElementInfo, ctx: AncestorCtx): boolean {
  return hasClass(el, 'slide') && !ctx.slideAbove && !ctx.templateAbove;
}

function ctxOf(index: DocIndex, id: NodeId): AncestorCtx {
  const { ctx: memo } = analysisOf(index);
  const cached = memo.get(id);
  if (cached) return cached;
  // Walk up to the first memoised ancestor (iteratively), then fill the chain downwards.
  const chain: ElementInfo[] = [];
  for (let cur: NodeId | null = id; cur !== null && !memo.has(cur); ) {
    const el = index.elements.get(cur);
    if (!el) break;
    chain.push(el);
    cur = el.parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const el = chain[i];
    const parent = el.parent === null ? undefined : index.elements.get(el.parent);
    let c: AncestorCtx;
    if (!parent) {
      c = { root: null, slideAbove: false, templateAbove: false, blocked: false, textAbove: false };
    } else {
      const pc = ctxOf(index, parent.id);
      const parentIsRoot = isRootGiven(parent, pc);
      c = {
        root: parentIsRoot ? parent.id : pc.root,
        slideAbove: pc.slideAbove || hasClass(parent, 'slide'),
        templateAbove: pc.templateAbove || parent.tag.toLowerCase() === 'template',
        blocked: pc.blocked || isHidden(parent) || OPAQUE_TAGS.has(parent.tag.toLowerCase()),
        textAbove: parentIsRoot ? false : pc.textAbove || (pc.root !== null && (isTextBlockTag(parent) || hasDirectText(index, parent))),
      };
    }
    memo.set(el.id, c);
  }
  return memo.get(id) as AncestorCtx;
}

const BG_IMAGE = /url\(|-gradient\(/i;

/** True when the inline style's last background declaration provides an image. */
function hasBackgroundImage(el: ElementInfo): boolean {
  const style = getAttr(el, 'style');
  if (!style || !/background/i.test(style)) return false;
  let image = false;
  for (const decl of parseStyle(style)) {
    const name = decl.name.toLowerCase();
    if (name === 'background' || name === 'background-image') image = BG_IMAGE.test(decl.value);
  }
  return image;
}

function kindOfTag(el: ElementInfo): BlockKind | null {
  const tag = el.tag.toLowerCase();
  return MEDIA_KIND[tag] ?? (TEXT_TAGS.has(tag) ? 'text' : null);
}

/** Kind when `el` (a descendant of a page root, not excluded) is selectable, else null. */
function selectableKindOf(index: DocIndex, el: ElementInfo, c: AncestorCtx): BlockKind | null {
  if (c.root === null || c.blocked || isHidden(el)) return null;
  const byTag = kindOfTag(el);
  if (byTag) return byTag;
  if (!c.textAbove && hasDirectText(index, el)) return 'text';
  if (getAttr(el, 'data-layer-id') !== null || hasBackgroundImage(el)) return 'box';
  return null;
}

/** Kind of one element when it is a selectable block, else null (ancestor context included). */
export function selectableKind(index: DocIndex, id: NodeId): BlockKind | null {
  const el = index.elements.get(id);
  return el ? selectableKindOf(index, el, ctxOf(index, id)) : null;
}

/** Kind of a block (drives overlay tools, layer icons and overflow checks). */
export function blockKind(index: DocIndex, id: NodeId): BlockKind {
  const el = index.elements.get(id);
  if (!el) return 'box';
  const byTag = kindOfTag(el);
  if (byTag) return byTag;
  const c = ctxOf(index, id);
  return !c.textAbove && hasDirectText(index, el) ? 'text' : 'box';
}

/** Selectable blocks in document order (one pass), optionally limited to one page. */
export function selectableBlocks(index: DocIndex, pageId?: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (!el) continue;
    const c = ctxOf(index, id);
    if (pageId !== undefined && c.root !== pageId) continue;
    if (selectableKindOf(index, el, c) !== null) out.push(id);
  }
  return out;
}
