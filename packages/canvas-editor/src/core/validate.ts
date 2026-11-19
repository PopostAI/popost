/**
 * Deck validation shared by the editor (code panel, save) and the web app (`validateDeck`).
 * The rules mirror `src/lib/popost.ts`: `.slide` is required and static-only markup is enforced
 * the way `DOMParser('text/html')` + `querySelector` would see it (scripting disabled, template
 * contents not searched, quirks-mode class matching).
 */
import { defaultTreeAdapter, parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Element = DefaultTreeAdapterMap['element'];
type P5ParentNode = DefaultTreeAdapterMap['parentNode'];

export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

export type ValidateErrorCode = 'empty' | 'too-large' | 'no-slide' | 'unsafe';
export type ValidateResult = { ok: true; slides: number } | { ok: false; code: ValidateErrorCode };

/** Messages thrown by the web app's `validateDeck` (kept verbatim for compatibility). */
export const NO_SLIDE_MESSAGE = '图文内容需要包含 .slide 结构';
export const UNSAFE_MESSAGE = '仅允许静态图文 HTML，不允许脚本或嵌入内容';

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'form']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href']);

function attrName(a: { name: string; prefix?: string }): string {
  return a.prefix ? `${a.prefix}:${a.name}` : a.name;
}

function isUnsafe(el: P5Element): boolean {
  if (FORBIDDEN_TAGS.has(el.tagName)) return true;
  if (el.tagName === 'meta' && el.attrs.some((a) => a.name === 'http-equiv' && a.value.toLowerCase() === 'refresh')) return true;
  return el.attrs.some((a) => {
    const name = attrName(a);
    return /^on/i.test(name) || (URL_ATTRS.has(name) && /^\s*javascript:/i.test(a.value));
  });
}

interface Scan {
  slides: number;
  unsafe: boolean;
}

/** Number of `.slide` elements, or a failure code (`no-slide` is reported before `unsafe`). */
function scanDeck(html: string): { slides: number } | { code: 'no-slide' | 'unsafe' } {
  const doc = parse(html, { scriptingEnabled: false });
  const quirks = doc.mode === 'quirks';
  const scan: Scan = { slides: 0, unsafe: false };
  const walk = (node: P5ParentNode): void => {
    for (const child of node.childNodes) {
      if (!defaultTreeAdapter.isElementNode(child)) continue;
      if (isUnsafe(child)) scan.unsafe = true;
      const classes = child.attrs.find((a) => a.name === 'class')?.value ?? '';
      const tokens = classes.split(/[\t\n\f\r ]+/);
      if (tokens.includes('slide') || (quirks && tokens.some((t) => t.toLowerCase() === 'slide'))) scan.slides++;
      walk(child);
    }
  };
  walk(doc);
  if (scan.slides === 0) return { code: 'no-slide' };
  if (scan.unsafe) return { code: 'unsafe' };
  return { slides: scan.slides };
}

export function exceedsLimit(text: string, limit = MAX_DOCUMENT_BYTES): boolean {
  // UTF-8 needs between one and three bytes per UTF-16 unit, so the cheap bounds settle most inputs.
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return new TextEncoder().encode(text).length > limit;
}

/** Validation for the code panel and saves: non-empty, at most 60 MiB, `.slide` present, static-only. */
export function validateSource(html: string): ValidateResult {
  if (html.trim() === '') return { ok: false, code: 'empty' };
  if (exceedsLimit(html)) return { ok: false, code: 'too-large' };
  const scanned = scanDeck(html);
  return 'code' in scanned ? { ok: false, code: scanned.code } : { ok: true, slides: scanned.slides };
}

/** Drop-in for `validateDeck` in `src/lib/popost.ts`: returns the slide count or throws the Chinese message. */
export function validateDeck(html: string): number {
  const scanned = scanDeck(html);
  if ('code' in scanned) throw new Error(scanned.code === 'no-slide' ? NO_SLIDE_MESSAGE : UNSAFE_MESSAGE);
  return scanned.slides;
}
