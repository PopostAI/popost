/** Keeps the current page root's border box at the frame's (0,0). */

/**
 * Author CSS may centre the page (flex, margins, body padding). Instead of touching the source or the page root, shift
 * `<html>` with the standalone `translate` property so the root's box starts at (0,0). Returns the applied offset.
 */
export function alignPage(doc: Document, root: Element): { x: number; y: number } {
  const html = doc.documentElement;
  html.style.removeProperty('translate');
  const rect = root.getBoundingClientRect();
  const x = -rect.left;
  const y = -rect.top;
  if (x !== 0 || y !== 0) html.style.setProperty('translate', `${x}px ${y}px`);
  resetScroll(doc);
  return { x, y };
}

/** Programmatic focus can scroll an `overflow: hidden` document; put it back. */
export function resetScroll(doc: Document): void {
  const scroller = doc.scrollingElement ?? doc.documentElement;
  if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
  if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
  const body = doc.body;
  if (body && body !== scroller) {
    if (body.scrollTop !== 0) body.scrollTop = 0;
    if (body.scrollLeft !== 0) body.scrollLeft = 0;
  }
}
