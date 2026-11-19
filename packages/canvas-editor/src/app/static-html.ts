/** Single-file static HTML copy of a document (the code panel's "Download html" rules, current-contracts §5.4). */
import { defaultTreeAdapter, html, parse, serializeOuter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const REMOVED_TAGS = new Set(['script', 'noscript', 'object', 'embed', 'iframe', 'frame', 'base']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

export const STATIC_CSP =
  "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; font-src data: https: http:";

function attrName(a: { name: string; prefix?: string }): string {
  return a.prefix ? `${a.prefix}:${a.name}` : a.name;
}

function cleanAttrs(el: Element): void {
  el.attrs = el.attrs.filter((a) => {
    const name = attrName(a).toLowerCase();
    if (name.startsWith('on')) return false;
    return !(URL_ATTRS.has(name) && /^\s*javascript:/i.test(a.value));
  });
}

function hasCsp(head: Element): boolean {
  return head.childNodes.some(
    (n) =>
      defaultTreeAdapter.isElementNode(n) &&
      n.tagName === 'meta' &&
      n.attrs.some((a) => a.name === 'http-equiv' && a.value.toLowerCase() === 'content-security-policy'),
  );
}

function clean(node: Node): void {
  if (!defaultTreeAdapter.isElementNode(node)) return;
  cleanAttrs(node);
  const children = 'content' in node ? node.content.childNodes : node.childNodes;
  scrub(children);
}

function scrub(children: Node[]): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as Node;
    if (defaultTreeAdapter.isElementNode(child) && REMOVED_TAGS.has(child.tagName)) children.splice(i, 1);
    else clean(child);
  }
}

/**
 * Remove scripts, embeds, handlers and `javascript:` URLs, and add a restrictive CSP meta unless the
 * document already carries one, so the downloaded file can never run injected code.
 */
export function makeStaticHtml(source: string): string {
  const doc = parse(source, { scriptingEnabled: false });
  const root = doc.childNodes.find((n): n is Element => defaultTreeAdapter.isElementNode(n) && n.tagName === 'html');
  if (!root) return source;
  cleanAttrs(root);
  scrub(root.childNodes);
  const head = root.childNodes.find((n): n is Element => defaultTreeAdapter.isElementNode(n) && n.tagName === 'head');
  if (head && !hasCsp(head)) {
    const meta = defaultTreeAdapter.createElement('meta', html.NS.HTML, [
      { name: 'http-equiv', value: 'Content-Security-Policy' },
      { name: 'content', value: STATIC_CSP },
    ]);
    const first = head.childNodes[0];
    if (first) defaultTreeAdapter.insertBefore(head, meta, first);
    else defaultTreeAdapter.appendChild(head, meta);
  }
  const hasDoctype = doc.childNodes.some((n) => defaultTreeAdapter.isDocumentTypeNode(n));
  return (hasDoctype ? '<!DOCTYPE html>\n' : '') + serializeOuter(root);
}

/** File name for the download: the document name with filesystem-hostile characters replaced, `.html` appended. */
export function exportFileName(name: string | null | undefined): string {
  const base = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().replace(/\.html?$/i, '').trim();
  return `${base || 'index'}.html`;
}

/** Save text as a file through a Blob and a temporary anchor. */
export function downloadTextFile(fileName: string, text: string, mime = 'text/html;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
