/**
 * Compile a multi-page skill project into one editor document, and split it back (port of the product's
 * local-api.mjs; behaviour identical, see current-contracts.md §4.6). Pure functions: everything fetched
 * from the server is passed in. Native scoped CSS keeps independently authored pages from restyling each other.
 */

export interface ManifestPage {
  id: string;
  name?: string;
  width: number;
  height: number;
  role?: string;
  /** Page file path relative to the project root, e.g. `pages/p1.html`. */
  htmlPath: string;
  html: string;
}

export interface ProjectManifest {
  pages: ManifestPage[];
}

export interface CompileEnv {
  /** Origin of the editor page; URLs on any other origin are rejected. */
  origin: string;
  /** Raw text of a same-origin stylesheet; must throw when it cannot be read. */
  fetchStylesheet: (url: URL) => Promise<string>;
}

export interface PreviousPage {
  id: string;
  width: number;
  height: number;
  role?: string;
}

export interface SplitContext {
  previousPages: readonly PreviousPage[];
  /** Size used for pages that have no size anywhere else (`__POPOST_LOCAL__` width/height). */
  defaultSize: { width: number; height: number };
  /** Random page id; defaults to `p-` + 12 hex chars. */
  newPageId?: () => string;
}

export interface SplitPage {
  id: string;
  name: string;
  width: number;
  height: number;
  role: string;
  html: string;
}

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

/* ------------------------------------------------------------------------------------------ */
/* URL rewriting                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Rewrite a URL to the root-relative-from-`/pages/` form (`../<path>`). */
export function relative(url: string, base: string, origin: string): string {
  if (!url || /^(data:|blob:|#)/i.test(url)) return url;
  const resolved = new URL(url, base);
  if (resolved.origin !== origin) throw new Error('本地工程不能依赖站外资源，请先导入图片和字体。');
  return '../' + resolved.pathname.slice(1) + resolved.search + resolved.hash;
}

/** Rewrite every `url(...)` of a CSS text with `relative()`. */
export function cssURLs(css: string, base: string, origin: string): string {
  return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_all, _quote: string, url: string) => `url("${relative(url, base, origin)}")`);
}

/* ------------------------------------------------------------------------------------------ */
/* Scoped CSS                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const INHERITED =
  /^(--|background(?:-|$)|color$|font(?:-|$)|line-height$|letter-spacing$|word-spacing$|text-(?:align|transform|indent|rendering)$|direction$|writing-mode$|white-space$|visibility$)/;

/** Split a selector list at top-level commas (quotes, brackets and escapes respected). */
export function selectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function declarationText(style: CSSStyleDeclaration, keep: (property: string) => boolean): string {
  return [...style]
    .filter(keep)
    .map((p) => `${p}:${style.getPropertyValue(p)}${style.getPropertyPriority(p) ? '!important' : ''}`)
    .join(';');
}

function scopeSelector(selector: string, style: CSSStyleDeclaration, rootNode: Element): string {
  if (/^\s*(?::root|html|body)\s*$/.test(selector)) return `:scope{${declarationText(style, (p) => INHERITED.test(p))}}`;
  const stripped = selector.trim().replace(/^(?:(?:html|body|:root)\s+)+/, '');
  const first = stripped.match(/^[^\s>+~]+/)?.[0];
  let targets = stripped;
  try {
    if (first && rootNode.matches(first)) targets += ',' + ':scope' + stripped.slice(first.length);
  } catch {
    /* selector the browser cannot match against the root: no extra :scope variant */
  }
  return `${targets}{${style.cssText}}`;
}

/**
 * Transform page CSS: `@font-face` rules are hoisted (document-wide) and emitted first, everything else is
 * wrapped in one native `@scope { ... }` block whose scope root is the page root. Needs `CSSStyleSheet`.
 */
export function scopedCSS(css: string, rootNode: Element): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const fontFaces: string[] = [];
  function rules(list: CSSRuleList): string {
    return [...list]
      .map((rule) => {
        // Font faces are document-wide registrations; inside @scope the editor would silently fall back.
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          fontFaces.push(rule.cssText);
          return '';
        }
        if (rule.type === CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule;
          return selectorList(styleRule.selectorText)
            .map((selector) => scopeSelector(selector, styleRule.style, rootNode))
            .join('\n');
        }
        const nested = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined;
        if (nested && !/^@(?:font-face|keyframes)/i.test(rule.cssText)) {
          return rule.cssText.slice(0, rule.cssText.indexOf('{') + 1) + rules(nested) + '}';
        }
        return rule.cssText;
      })
      .join('\n');
  }
  const scoped = rules(sheet.cssRules);
  return fontFaces.join('\n') + '\n@scope {\n' + scoped + '\n}';
}

/* ------------------------------------------------------------------------------------------ */
/* Compile                                                                                    */
/* ------------------------------------------------------------------------------------------ */

type StylesheetCache = Map<string, Promise<string>>;

function loadStylesheet(url: URL, cache: StylesheetCache, env: CompileEnv): Promise<string> {
  let entry = cache.get(url.href);
  if (!entry) {
    entry = env.fetchStylesheet(url).then((text) => cssURLs(text, url.href, env.origin));
    cache.set(url.href, entry);
  }
  return entry;
}

/** CSS of the given `style` / `link[rel=stylesheet]` nodes, `url()`s rewritten; external links throw `externalMessage`. */
async function collectCSS(nodes: Iterable<Element>, base: string, externalMessage: string, cache: StylesheetCache, env: CompileEnv): Promise<string> {
  let css = '';
  for (const node of nodes) {
    if (node.tagName === 'STYLE') {
      css += cssURLs(node.textContent ?? '', base, env.origin) + '\n';
    } else {
      const url = new URL(node.getAttribute('href') ?? '', base);
      if (url.origin !== env.origin) throw new Error(externalMessage);
      css += (await loadStylesheet(url, cache, env)) + '\n';
    }
  }
  return css;
}

function newStyle(doc: Document, dataFlag: 'popostStyle' | 'popostHeadStyle', css: string): HTMLStyleElement {
  const style = doc.createElement('style');
  style.dataset[dataFlag] = '';
  style.textContent = css;
  return style;
}

async function scopeUnconverted(doc: Document, root: Element, base: string, cache: StylesheetCache, env: CompileEnv): Promise<void> {
  const css = await collectCSS(doc.querySelectorAll('style,link[rel="stylesheet"]'), base, '请先将字体和样式保存到工程内', cache, env);
  // Styles live inside their own root; duplicating a page duplicates its style scope too.
  root.querySelectorAll('style,link[rel="stylesheet"]').forEach((n) => n.remove());
  root.prepend(newStyle(doc, 'popostStyle', scopedCSS(css, root)));
}

async function scopeConverted(doc: Document, root: Element, base: string, cache: StylesheetCache, env: CompileEnv): Promise<void> {
  const css = await collectCSS(doc.head.querySelectorAll('style,link[rel="stylesheet"]'), base, '本地样式文件不可指向站外', cache, env);
  root.querySelectorAll('style[data-popost-head-style]').forEach((n) => n.remove());
  if (css.trim()) root.append(newStyle(doc, 'popostHeadStyle', scopedCSS(css, root)));
}

function rewriteResourceUrls(root: Element, base: string, origin: string): void {
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of ['src', 'href', 'poster']) {
      if (node.hasAttribute(attr)) node.setAttribute(attr, relative(node.getAttribute(attr) ?? '', base, origin));
    }
    if (node.hasAttribute('style')) node.setAttribute('style', cssURLs(node.getAttribute('style') ?? '', base, origin));
  }
}

function stampRoot(root: HTMLElement, page: ManifestPage): void {
  root.classList.add('slide');
  root.dataset.popostPage = page.id;
  root.dataset.popostWidth = String(page.width);
  root.dataset.popostHeight = String(page.height);
  root.dataset.popostName = page.name || page.id;
  root.style.width = page.width + 'px';
  root.style.height = page.height + 'px';
  if (!root.style.position) root.style.position = 'relative';
  if (!root.style.overflow) root.style.overflow = 'hidden';
}

async function pageNode(page: ManifestPage, cache: StylesheetCache, env: CompileEnv): Promise<string> {
  const doc = parse(page.html);
  const root = doc.querySelector<HTMLElement>('.slide[data-popost-page],.post,.page');
  if (!root) throw new Error(`页面 ${page.id} 缺少 .post/.page 画布根节点`);
  const base = new URL(page.htmlPath, env.origin + '/').href;
  if (root.hasAttribute('data-popost-page')) await scopeConverted(doc, root, base, cache, env);
  else await scopeUnconverted(doc, root, base, cache, env);
  rewriteResourceUrls(root, base, env.origin);
  stampRoot(root, page);
  return root.outerHTML;
}

const COMPILED_HEAD = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}.slide{box-sizing:border-box}</style></head><body>';

export async function compileProject(manifest: ProjectManifest, env: CompileEnv): Promise<string> {
  const cache: StylesheetCache = new Map();
  const pages = await Promise.all(manifest.pages.map((page) => pageNode(page, cache, env)));
  return COMPILED_HEAD + pages.join('\n') + '</body></html>';
}

/* ------------------------------------------------------------------------------------------ */
/* Split                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function randomPageId(): string {
  return 'p-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function uniquePageId(node: HTMLElement, used: Set<string>, newPageId: () => string): string {
  let id = node.dataset.popostPage;
  if (!id || !/^[\w-]{1,64}$/.test(id) || used.has(id)) id = newPageId();
  used.add(id);
  node.dataset.popostPage = id;
  return id;
}

/** Deduplicate `@font-face` blocks (whitespace-normalised equality) inside one page file. */
function dedupeFontFaces(html: string): string {
  const faces = new Set<string>();
  return html.replace(/@font-face\s*\{[^{}]*\}/gi, (rule) => {
    const key = rule.replace(/\s+/g, ' ').trim();
    if (faces.has(key)) return '';
    faces.add(key);
    return rule;
  });
}

function pageDocument(doc: Document, node: HTMLElement): string {
  // Code-panel head styles are kept with each page; original scoped styles remain local.
  const head = doc.head.cloneNode(true) as HTMLHeadElement;
  head.querySelectorAll('script,base,meta[http-equiv]').forEach((n) => n.remove());
  const html = '<!doctype html><html><head><meta charset="utf-8">' + head.innerHTML + '</head><body style="margin:0">' + node.outerHTML + '</body></html>';
  return dedupeFontFaces(html);
}

/** Top-level `.slide` elements (not nested in another `.slide`) become the pages of the project. */
export function splitProject(content: string, ctx: SplitContext): SplitPage[] {
  const doc = parse(content);
  const slides = [...doc.querySelectorAll<HTMLElement>('.slide')].filter((n) => !n.parentElement?.closest('.slide'));
  if (!slides.length) throw new Error('请至少保留一页图文');
  const used = new Set<string>();
  const newPageId = ctx.newPageId ?? randomPageId;
  return slides.map((node, i) => {
    const id = uniquePageId(node, used, newPageId);
    const previous = ctx.previousPages.find((p) => p.id === id);
    const width = Number(node.dataset.popostWidth || previous?.width || ctx.defaultSize.width);
    const height = Number(node.dataset.popostHeight || previous?.height || ctx.defaultSize.height);
    node.style.width = width + 'px';
    node.style.height = height + 'px';
    return { id, name: node.dataset.popostName || `Page ${i + 1}`, width, height, role: previous?.role || 'content', html: pageDocument(doc, node) };
  });
}
