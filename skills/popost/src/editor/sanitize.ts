/**
 * The HTML sanitizer of the local editor server (port of `server._San` and `preview_html`). Everything the editor saves
 * and everything it previews goes through it: scripts, frames, `on*` handlers, external and script URLs and external CSS
 * are dropped; doctype and comments are not re-emitted (the editor adds its own doctype when it compiles a page).
 */
import { Parser } from 'htmlparser2';

const BLOCKED = new Set(['script', 'iframe', 'object', 'embed']);
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const UNSAFE_PROTOCOL = /^\s*(javascript|vbscript|data)\s*:/i;
const EXTERNAL_URL = /^\s*(https?:)?\/\//i;

/** Drop `@import`, external `url()`, `expression()` and `javascript:` from CSS text. */
export const cleanCss = (css: string): string =>
  css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi, '')
    .replace(/expression\([^)]*\)|javascript:[^;]*/gi, '');

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const attributes = (attribs: Record<string, string>): string => {
  let out = '';
  for (const [name, raw] of Object.entries(attribs)) {
    if (name.startsWith('on')) continue;
    const isUrl = name === 'src' || name === 'href';
    if (isUrl && raw && EXTERNAL_URL.test(raw)) continue;
    const value = name === 'style' ? cleanCss(raw) : raw;
    if (isUrl && value && UNSAFE_PROTOCOL.test(value) && !value.toLowerCase().startsWith('data:image')) continue;
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
};

const styleAttributes = (attribs: Record<string, string>): string =>
  Object.entries(attribs)
    .filter(([name]) => name === 'id' || name === 'type' || name === 'media' || name.startsWith('data-'))
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('');

interface SanitizeOptions {
  /** Preview only: `<base>` and `<meta http-equiv>` are dropped (the server sets its own base). */
  readonly preview?: boolean;
  /** Preview only: an inline `<script nonce=N>` with this nonce (and no `src`) is kept. */
  readonly nonce?: string | null;
}

export const sanitizeHtml = (html: string, options: SanitizeOptions = {}): string => {
  const nonce = options.nonce ?? null;
  const out: string[] = [];
  let skipping = 0;
  let trustedScript = false;
  let style: string[] | null = null;

  const open = (name: string, attribs: Record<string, string>) => {
    if (name === 'script' && nonce && !skipping && attribs.nonce === nonce && !('src' in attribs)) {
      trustedScript = true;
      out.push(`<script nonce="${nonce}">`);
      return;
    }
    if (BLOCKED.has(name)) {
      skipping++;
      return;
    }
    if (skipping) return;
    if (options.preview && (name === 'base' || (name === 'meta' && 'http-equiv' in attribs))) return;
    if (name === 'style') {
      style = [];
      out.push(`<style${styleAttributes(attribs)}>`);
      return;
    }
    out.push(`<${name}${attributes(attribs)}${VOID.has(name) ? '/>' : '>'}`);
  };

  const close = (name: string) => {
    if (name === 'script' && trustedScript) {
      trustedScript = false;
      out.push('</script>');
    } else if (BLOCKED.has(name)) skipping = Math.max(0, skipping - 1);
    else if (skipping || VOID.has(name)) return;
    else if (name === 'style') {
      out.push(cleanCss((style ?? []).join('')), '</style>');
      style = null;
    } else out.push(`</${name}>`);
  };

  const text = (data: string) => {
    if (skipping) return;
    if (trustedScript) out.push(data);
    else if (style) style.push(data);
    else out.push(escapeText(data));
  };

  // `recognizeSelfClosing`: `<path/>` and `<div/>` close at once, as in the Python parser (and in SVG).
  const parser = new Parser({ onopentag: open, onclosetag: close, ontext: text }, { recognizeSelfClosing: true });
  parser.write(html);
  parser.end();
  return out.join('');
};

/** A document for the editor's preview frame, and the `Content-Security-Policy` it must be served with. */
export const previewHtml = (content: string, nonce: string | null): { body: string; csp: string } => {
  if (nonce !== null && !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('invalid preview nonce');
  const safe = sanitizeHtml(content, { preview: true, nonce });
  const base = '<base href="/pages/">';
  const body = safe.includes('<head>') ? safe.replace('<head>', () => `<head>${base}`) : base + safe;
  const scripts = nonce ? `'nonce-${nonce}'` : "'none'";
  const csp =
    `default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; ` +
    `script-src ${scripts}; connect-src 'none'; form-action 'none'; base-uri 'self'`;
  return { body, csp };
};
