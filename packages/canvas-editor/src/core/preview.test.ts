import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { createIdSource } from './ids';
import { buildPreview, isJavascriptUrl, previewCSP, previewFragment } from './preview';
import type { PreviewOptions } from './preview';
import { findByAttr, findByTag, getAttr, parseIndex } from './source';
import { DECK, DECK_CRLF } from './test-fixtures';

type P5Element = DefaultTreeAdapterMap['element'];

const OPTS: PreviewOptions = { frameCSS: '.ed-cur{display:block !important}' };

const idx = (src: string) => parseIndex(src, createIdSource());

function elements(html: string): P5Element[] {
  const out: P5Element[] = [];
  const walk = (node: DefaultTreeAdapterMap['parentNode']): void => {
    const children = node.nodeName === 'template' ? (node as DefaultTreeAdapterMap['template']).content.childNodes : node.childNodes;
    for (const c of children) {
      if ('tagName' in c) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(parse(html, { scriptingEnabled: true }));
  return out;
}

const attr = (el: P5Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

const HAZARDS = `<!doctype html>
<html onload="evil()">
<head>
  <meta charset="gbk">
  <meta http-equiv="refresh" content="0;url=http://evil">
  <meta http-equiv="Content-Security-Policy" content="default-src *">
  <meta name="viewport" content="width=device-width">
  <base href="http://evil/">
  <script>window.evil = 1</script>
  <script src="http://evil/x.js"></script>
  <style>.slide{width:1080px}</style>
</head>
<body onclick="evil()" data-pp-id="spoof">
  <div class="slide" onmouseover=evil() ONCLICK='x' data-ok="1">
    <a href="javascript:alert(1)">a</a>
    <a href=" JaVa&#x09;Script:alert(1)">b</a>
    <a href="&#106;avascript:alert(1)">c</a>
    <a href="https://example.com/javascript:ok" data-href="javascript:no">d</a>
    <img src="x" onerror="evil()">
    <svg><a xlink:href="javascript:alert(1)"><text>t</text></a><script>evil()</script><use href="#a"/></svg>
    <iframe src="http://evil"></iframe>
    <object data="x"><embed src="y"></object>
    <embed src="z">
    <form action="javascript:evil()"><input onfocus="evil()"></form>
    <template><script>t()</script><img src=x onerror=t()></template>
    <noscript><img src=x onerror=n()></noscript>
  </div>
  <script>after()</script>
</body>
</html>`;

describe('buildPreview: security', () => {
  const out = buildPreview(idx(HAZARDS), OPTS);
  const all = elements(out);

  it('contains no script at all', () => {
    expect(all.filter((e) => e.tagName === 'script')).toHaveLength(0);
    expect(out).not.toContain('evil()');
    expect(out).not.toContain('after()');
    expect(out).not.toContain('window.evil');
  });

  it('has no on* attributes anywhere (including template content)', () => {
    expect(/\son[a-z]+\s*=/i.test(out)).toBe(false);
    for (const e of all) for (const a of e.attrs) expect(/^on/i.test(a.name)).toBe(false);
  });

  it('has no javascript: URLs in href/src/xlink:href but keeps harmless look-alikes', () => {
    for (const e of all) {
      for (const a of e.attrs) {
        if (['href', 'src', 'action', 'formaction'].includes(a.name)) {
          expect(isJavascriptUrl(a.value), `${e.tagName} ${a.name}`).toBe(false);
        }
      }
    }
    expect(out).toContain('https://example.com/javascript:ok');
    expect(out).toContain('data-href="javascript:no"');
  });

  it('removes iframe, object, embed, base and meta[http-equiv] (also nested)', () => {
    const tags = all.map((e) => e.tagName);
    for (const t of ['iframe', 'object', 'embed']) expect(tags).not.toContain(t);
    expect(tags.filter((t) => t === 'base')).toHaveLength(0);
    expect(all.filter((e) => e.tagName === 'meta' && attr(e, 'http-equiv') !== undefined)).toHaveLength(1); // ours
    expect(out).not.toContain('refresh');
    expect(out).not.toContain('default-src *');
    expect(out).toContain('name="viewport"');
  });

  it('drops a spoofed data-pp-id from the source', () => {
    expect(out).not.toContain('spoof');
  });

  it('adds the script-free CSP meta as the first http-equiv meta', () => {
    const csp = all.find((e) => e.tagName === 'meta' && attr(e, 'http-equiv') === 'Content-Security-Policy')!;
    expect(attr(csp, 'content')).toBe(previewCSP(false));
    expect(attr(csp, 'content')).toContain("script-src 'none'");
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<style'));
  });

  it('never contains a script, even for odd documents', () => {
    for (const src of ['', 'text', '<p>x</p>', '<html></html>', '<!doctype html><head></head>', '<script>a</script>', DECK, DECK_CRLF]) {
      const o = buildPreview(idx(src), OPTS);
      expect(elements(o).filter((e) => e.tagName === 'script')).toHaveLength(0);
      expect(o).toContain("script-src 'none'");
    }
  });
});

describe('isJavascriptUrl', () => {
  it('reads URLs the way browsers do', () => {
    for (const v of ['javascript:x', ' JAVASCRIPT:x', '\tjava\nscript:x', '\u0001javascript:x']) expect(isJavascriptUrl(v)).toBe(true);
    for (const v of ['', 'https://a', '/javascript:x', 'javascripts:x', 'x javascript:x', '#javascript:']) expect(isJavascriptUrl(v)).toBe(false);
  });
});

describe('buildPreview: ids and structure', () => {
  it('puts data-pp-id on every indexed element, matching the index ids in order', () => {
    const index = idx(DECK);
    const out = buildPreview(index, OPTS);
    const injectedTags = new Set(['meta', 'script']);
    const ids = elements(out)
      .filter((e) => !(injectedTags.has(e.tagName) && attr(e, 'data-pp-id') === undefined) && attr(e, 'data-pp-frame') === undefined)
      .map((e) => attr(e, 'data-pp-id'));
    const expected = index.order.filter((id) => !['script'].includes(index.elements.get(id)!.tag));
    expect(ids).toEqual(expected);
  });

  it('mirrors the source: removing injections gives back the original bytes', () => {
    for (const src of [DECK, DECK_CRLF]) {
      const out = buildPreview(idx(src), OPTS);
      const stripped = out
        .replace(/ data-pp-id="[^"]*"/g, '')
        .replace(/ data-pp-sel="[^"]*"/g, '')
        .replace(/<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]*">/, '')
        .replace(/<style data-pp-frame>[^<]*<\/style>/, '');
      expect(stripped).toBe(src);
    }
  });

  it('adds explicit tags (with ids) for implied html/head/body', () => {
    const index = idx('<p>a</p>');
    const out = buildPreview(index, OPTS);
    const tags = elements(out);
    const byTag = (t: string): P5Element => tags.find((e) => e.tagName === t)!;
    expect(attr(byTag('html'), 'data-pp-id')).toBe(index.html);
    expect(attr(byTag('head'), 'data-pp-id')).toBe(index.head);
    expect(attr(byTag('body'), 'data-pp-id')).toBe(index.body);
    expect(attr(byTag('p'), 'data-pp-id')).toBe(findByTag(index, 'p')[0].id);
    expect(out.startsWith('<!doctype html><html data-pp-id=')).toBe(true);
  });

  it('handles implied head with content and explicit html', () => {
    const index = idx('<!doctype html>\n<style>a{}</style>\n<div class="slide">x</div>\n');
    const out = buildPreview(index, OPTS);
    const body = elements(out).find((e) => e.tagName === 'body')!;
    expect(attr(body, 'data-pp-id')).toBe(index.body);
    const head = elements(out).find((e) => e.tagName === 'head')!;
    expect(head.childNodes.some((c) => 'tagName' in c && c.tagName === 'style' && attr(c, 'data-pp-frame') !== undefined)).toBe(true);
    expect(out.startsWith('<!doctype html><html data-pp-id=')).toBe(true);
    const index2 = idx('<html lang="x"><div>x</div></html>');
    const out2 = buildPreview(index2, OPTS);
    expect(attr(elements(out2).find((e) => e.tagName === 'body')!, 'data-pp-id')).toBe(index2.body);
    expect(attr(elements(out2).find((e) => e.tagName === 'html')!, 'data-pp-id')).toBe(index2.html);
  });

  it('keeps an existing doctype and adds one when missing', () => {
    expect(buildPreview(idx('<!DOCTYPE html><p>x</p>'), OPTS).startsWith('<!DOCTYPE html>')).toBe(true);
    expect(buildPreview(idx('<!-- c --><!doctype html><p>x</p>'), OPTS).startsWith('<!-- c --><!doctype html>')).toBe(true);
    expect(buildPreview(idx('<p>x</p>'), OPTS).startsWith('<!doctype html>')).toBe(true);
    expect(buildPreview(idx('<!doctype html><p>x</p>'), OPTS).match(/<!doctype/gi)).toHaveLength(1);
  });

  it('injects frame CSS in head and escapes </style', () => {
    const out = buildPreview(idx('<head></head><p>x</p>'), { ...OPTS, frameCSS: 'a{}/* </style> */' });
    expect(out).toContain('<style data-pp-frame>a{}/* <\\/style> */</style></head>');
  });

  it('adds <base> and relaxes the CSP for local mode', () => {
    const out = buildPreview(idx('<head><title>t</title></head><p>x</p>'), { ...OPTS, baseHref: '/pages/' });
    const all = elements(out);
    const base = all.find((e) => e.tagName === 'base')!;
    expect(attr(base, 'href')).toBe('/pages/');
    const csp = attr(all.find((e) => e.tagName === 'meta' && attr(e, 'http-equiv'))!, 'content')!;
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(previewCSP(false)).toContain("base-uri 'none'");
    expect(previewCSP(false)).toContain("style-src 'unsafe-inline'");
    expect(previewCSP(false)).toBe(
      "default-src 'none'; img-src data: blob: 'self'; style-src 'unsafe-inline'; font-src data: 'self'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
    const quoted = buildPreview(idx('<p>x</p>'), { ...OPTS, baseHref: '/a"b/' });
    expect(quoted).toContain('<base href="/a&quot;b/">');
  });

  it('marks the current page with ed-cur in every class-attribute shape', () => {
    const cases: Array<[string, string]> = [
      ['<div class="slide">x</div>', 'class="slide ed-cur"'],
      ["<div class='slide'>x</div>", "class='slide ed-cur'"],
      ['<div class=slide>x</div>', 'class="slide ed-cur"'],
      ['<div class="">x</div>', 'class="ed-cur"'],
      ['<div class>x</div>', 'class="ed-cur"'],
      ['<div>x</div>', 'class="ed-cur"'],
      ['<div class="slide ed-cur">x</div>', 'class="slide ed-cur"'],
    ];
    for (const [src, expected] of cases) {
      const index = idx(src);
      const div = findByTag(index, 'div')[0];
      const out = buildPreview(index, { ...OPTS, currentPageId: div.id });
      expect(out, src).toContain(expected);
      expect(out.replace(/<style data-pp-frame>.*?<\/style>/, '').match(/ed-cur/g), src).toHaveLength(1);
      const el = elements(out).find((e) => e.tagName === 'div')!;
      expect(attr(el, 'class')!.split(' ')).toContain('ed-cur');
    }
  });

  it('marks only the requested page', () => {
    const index = idx(DECK);
    const page = findByAttr(index, 'data-popost-page', 'p-bbbbbbbbbbbb')[0];
    const out = buildPreview(index, { ...OPTS, currentPageId: page.id });
    const marked = elements(out).filter((e) => (attr(e, 'class') ?? '').split(' ').includes('ed-cur'));
    expect(marked.map((e) => attr(e, 'data-popost-page'))).toEqual(['p-bbbbbbbbbbbb']);
    expect(buildPreview(index, OPTS)).not.toContain('ed-cur"');
  });

  it('leaves agent attributes and inline styles untouched', () => {
    const out = buildPreview(idx(DECK), OPTS);
    for (const m of DECK.match(/data-(?:layer-id|slot)="[^"]*"/g)!) expect(out).toContain(m);
    expect(out).toContain('style="position:absolute; left:80px; top:120px; font-size:64px"');
  });

  it('handles an unclosed document without throwing', () => {
    expect(() => buildPreview(idx('<div><span>never closed'), OPTS)).not.toThrow();
    expect(() => buildPreview(idx('<p>a<p>b<table><tr><td>x'), OPTS)).not.toThrow();
  });
});

describe('previewFragment', () => {
  const index = idx(DECK);

  it('returns the element in preview form with ids on every descendant', () => {
    const title = findByAttr(index, 'data-layer-id', 'title')[0];
    expect(previewFragment(index, title.id)).toBe(
      `<h1 data-pp-id="${title.id}" data-pp-sel="text" class="title" data-layer-id="title" data-slot="headline" style="position:absolute; left:80px; top:120px; font-size:64px">春季发布 Spring &amp; Launch</h1>`,
    );
    const sub = findByAttr(index, 'data-layer-id', 'sub')[0];
    const br = sub.children[0];
    expect(previewFragment(index, sub.id)).toContain(`<br data-pp-id="${br}">`);
  });

  it('sanitises like the full preview', () => {
    const i = idx('<div onclick="x"><a href="javascript:y">t</a><script>s()</script><iframe></iframe><b>ok</b></div>');
    const div = findByTag(i, 'div')[0];
    const html = previewFragment(i, div.id);
    expect(html).not.toMatch(/onclick|javascript|script|iframe/i);
    expect(html).toContain('<b data-pp-id=');
    expect(html.startsWith('<div data-pp-id=')).toBe(true);
  });

  it('returns an empty string for stripped or implied elements', () => {
    const i = idx('<script>x()</script><iframe></iframe><meta http-equiv="refresh" content="1"><p>x</p>');
    for (const tag of ['script', 'iframe', 'meta']) expect(previewFragment(i, findByTag(i, tag)[0].id)).toBe('');
    expect(previewFragment(i, i.body!)).toBe('');
    expect(previewFragment(i, 'nope')).toBe('');
  });

  it('can mark the current page', () => {
    const page = findByAttr(index, 'data-popost-page', 'p-aaaaaaaaaaaa')[0];
    expect(previewFragment(index, page.id, { currentPageId: page.id })).toContain('class="slide ed-cur"');
    expect(previewFragment(index, page.id)).not.toContain('ed-cur');
  });

  it('agrees with the corresponding part of the full preview', () => {
    const page = findByAttr(index, 'data-popost-page', 'p-bbbbbbbbbbbb')[0];
    const full = buildPreview(index, OPTS);
    expect(full).toContain(previewFragment(index, page.id));
    expect(getAttr(page, 'data-popost-name')).toBe('Details');
  });
});

describe('data-pp-sel marks', () => {
  const sel = (html: string): Record<string, string | undefined> =>
    Object.fromEntries(elements(html).map((e, i) => [`${e.tagName}${i}`, attr(e, 'data-pp-sel')]).filter(([, v]) => v !== undefined));

  it('marks selectable blocks with their kind and nothing else', () => {
    const index = idx(DECK);
    const marked = elements(buildPreview(index, OPTS))
      .filter((e) => attr(e, 'data-pp-sel') !== undefined)
      .map((e) => `${e.tagName}:${attr(e, 'data-pp-sel')}`);
    expect(marked).toEqual(['div:box', 'h1:text', 'p:text', 'img:image', 'svg:svg', 'div:box', 'span:text']);
  });

  it('strips data-pp-sel from the source', () => {
    const out = buildPreview(idx('<div class="slide"><i data-pp-sel="box"></i><p data-pp-sel="bogus">y</p></div>'), OPTS);
    expect(out).not.toContain('"box"');
    expect(out).not.toContain('bogus');
    expect(sel(out)).toEqual({ p8: 'text' });
  });

  it('previewFragment decides with whole-document context', () => {
    const index = idx('<div class="slide"><div data-layer-id="a"><span>Text</span></div></div><div><span>Out</span></div>');
    const [span, outside] = findByTag(index, 'span');
    expect(previewFragment(index, span.id)).toContain('data-pp-sel="text"');
    expect(previewFragment(index, outside.id)).not.toContain('data-pp-sel');
    const p = idx('<div class="slide"><p>Hello <strong>you</strong></p></div>');
    expect(previewFragment(p, findByTag(p, 'strong')[0].id)).not.toContain('data-pp-sel');
  });
});

describe('previewCSP: image origins', () => {
  const EXTRA = ['https://bucket.acct.r2.cloudflarestorage.com', 'https://cdn.example.com:8443'];

  it('is unchanged without origins and adds only img-src sources with them', () => {
    expect(previewCSP(true, [])).toBe(previewCSP(true));
    const withOrigins = previewCSP(true, EXTRA);
    expect(withOrigins).toContain("img-src data: blob: 'self' https://bucket.acct.r2.cloudflarestorage.com https://cdn.example.com:8443;");
    expect(withOrigins.replace(/img-src [^;]*/, 'img-src')).toBe(previewCSP(true).replace(/img-src [^;]*/, 'img-src'));
  });

  it('re-validates origins so a caller cannot inject directives', () => {
    const csp = previewCSP(false, ["https://a.example.com; script-src *", '*', 'http://b.example.com', 'https://ok.example.com']);
    expect(csp).toContain("img-src data: blob: 'self' https://ok.example.com;");
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain('*');
  });

  it('puts the origins into the CSP meta of buildPreview', () => {
    const out = buildPreview(idx('<p>x</p>'), { ...OPTS, baseHref: '/', imageOrigins: EXTRA });
    const meta = elements(out).find((e) => e.tagName === 'meta' && attr(e, 'http-equiv') === 'Content-Security-Policy')!;
    expect(attr(meta, 'content')).toBe(previewCSP(true, EXTRA));
    const plain = buildPreview(idx('<p>x</p>'), { ...OPTS, baseHref: '/' });
    expect(plain).not.toContain('r2.cloudflarestorage.com');
  });
});
