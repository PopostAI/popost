/** Cleaning of inline-edited HTML before it is committed to the source. */

const isEditorAttr = (name: string): boolean =>
  name === 'contenteditable' || name === 'spellcheck' || name.startsWith('data-pp-');

/** Remove one element's editor-only attributes. */
export function stripEditorAttrs(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    if (isEditorAttr(attr.name.toLowerCase())) el.removeAttribute(attr.name);
  }
}

/** `html` re-serialised without `contenteditable`, `spellcheck` and `data-pp-*` attributes anywhere in it. */
export function cleanHTML(doc: Document, html: string): string {
  // <template> content is inert: no image loads or script runs while cleaning.
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const root: ParentNode = tpl.content ?? tpl;
  for (const el of Array.from(root.querySelectorAll('*'))) stripEditorAttrs(el);
  return tpl.innerHTML;
}
