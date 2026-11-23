/**
 * The texts a scene shows at the frame applied, read in the page: every element with text of its own, and whether a
 * viewer can see it now. The scene check compares two frames of a shot with these to find text that arrives too late
 * (scene/check.ts). Visible is meant as a person would say it, not as the browser lays it out: an element at a
 * quarter of its opacity, scaled to a speck, outside the canvas or cut off by a box that hides its overflow shows
 * nothing, though it has a box.
 */
import type { SceneText } from './contract';

/** Below this product of opacities, up to the scene's root, a text is too faint to read. */
const FAINT = 0.5;
/** Scaled below this, a text is too small to read (an entrance that grows it from nothing has not got far). */
const SPECK = 1 / 3;
/** Characters of a text kept in the facts. */
const KEPT = 80;
/** Elements whose text is never drawn. */
const NOT_DRAWN = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);

interface Rect { left: number; top: number; right: number; bottom: number }

const ownText = (el: Element): boolean =>
  Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');

const meets = (a: Rect, b: Rect): boolean => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;

/** How much the element is scaled on screen against its own layout size (transforms of it and around it); 1 when unknown. */
const scaleOf = (el: Element, r: DOMRect): number => {
  const html = el as Partial<HTMLElement>;
  const w = html.offsetWidth ?? 0, h = html.offsetHeight ?? 0;
  if (!(w > 0 && h > 0)) return 1;
  // A rotation makes the box larger, never smaller: this errs on the side of visible.
  return Math.min(r.width / w, r.height / h);
};

/** Whether a viewer can see the element now: drawn, opaque enough, large enough, and inside what is shown. */
const seen = (el: Element, win: Window, canvas: Rect): boolean => {
  // No box at all: display none, on the element or around it.
  if (el.getClientRects().length === 0) return false;
  if (win.getComputedStyle(el).visibility !== 'visible') return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0) || !meets(r, canvas)) return false;
  if (scaleOf(el, r) < SPECK) return false;
  const root = el.ownerDocument.documentElement, body = el.ownerDocument.body;
  let opacity = 1;
  for (let a: Element | null = el; a; a = a.parentElement) {
    const s = win.getComputedStyle(a);
    opacity *= Number(s.opacity);
    // A box around it that hides its overflow and that it lies wholly outside of (a text still behind its mask). The
    // body's and the root's overflow is the canvas's, tested above: their own box may well be empty.
    const clips = a !== el && a !== root && a !== body && s.display !== 'inline' && (s.overflowX !== 'visible' || s.overflowY !== 'visible');
    if (clips && !meets(r, a.getBoundingClientRect())) return false;
  }
  return opacity >= FAINT;
};

/** Every element of the scene's body with text of its own, in document order, and whether it can be seen now. */
export const sceneTexts = (doc: Document): SceneText[] => {
  const win = doc.defaultView;
  if (!win || !doc.body) return [];
  const canvas: Rect = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
  const out: SceneText[] = [];
  Array.from(doc.body.querySelectorAll('*')).forEach((el, index) => {
    if (NOT_DRAWN.has(el.tagName.toUpperCase()) || !ownText(el)) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, KEPT);
    out.push({ index, text, visible: seen(el, win, canvas) });
  });
  return out;
};
