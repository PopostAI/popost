import { beforeAll, describe, expect, it } from 'vitest';
import { compileProject, cssURLs, relative, scopedCSS, selectorList, splitProject } from './compile';
import type { CompileEnv, ManifestPage } from './compile';

const ORIGIN = 'http://127.0.0.1:9';

beforeAll(() => {
  // Parsed documents must not try to load their <link rel=stylesheet> over the network.
  const happy = (window as unknown as { happyDOM?: { settings: { disableCSSFileLoading: boolean } } }).happyDOM;
  if (happy) happy.settings.disableCSSFileLoading = true;
});
const env: CompileEnv = {
  origin: ORIGIN,
  fetchStylesheet: async (url) => {
    if (url.pathname === '/css/x.css') return '.t{background:url(../assets/bg.png)}';
    throw new Error('样式文件无法读取：' + url.pathname);
  },
};

function page(overrides: Partial<ManifestPage> & { html: string }): ManifestPage {
  return { id: 'p1', name: 'One', width: 1080, height: 1350, htmlPath: 'pages/p1.html', ...overrides };
}

describe('url rewriting', () => {
  const base = ORIGIN + '/pages/p1.html';

  it('rewrites to ../ root-relative paths and keeps query and hash', () => {
    expect(relative('../assets/a.png?x=1#h', base, ORIGIN)).toBe('../assets/a.png?x=1#h');
    expect(relative('a.png', base, ORIGIN)).toBe('../pages/a.png');
    expect(relative('/fonts/f.woff2', base, ORIGIN)).toBe('../fonts/f.woff2');
  });

  it('leaves data:, blob:, # and empty untouched, rejects other origins', () => {
    for (const u of ['data:image/png;base64,AA', 'blob:x', '#a', '']) expect(relative(u, base, ORIGIN)).toBe(u);
    expect(() => relative('https://cdn.example/a.png', base, ORIGIN)).toThrow('本地工程不能依赖站外资源，请先导入图片和字体。');
  });

  it('rewrites every css url()', () => {
    expect(cssURLs("a{b:url('../x.png')} c{d:url( ../y.png )} e{f:url(data:image/png;base64,AA)}", base, ORIGIN)).toBe(
      'a{b:url("../x.png")} c{d:url("../y.png")} e{f:url("data:image/png;base64,AA")}',
    );
  });
});

describe('selectorList', () => {
  it('splits top-level commas only', () => {
    expect(selectorList('a, b:is(c, d), [x="1,2"], .e\\,f')).toEqual(['a', ' b:is(c, d)', ' [x="1,2"]', ' .e\\,f']);
  });
});

describe('scopedCSS', () => {
  it('hoists @font-face and wraps the rest in @scope', () => {
    const root = document.createElement('div');
    const out = scopedCSS('@font-face{font-family:F;src:url(x.woff2)} .a{color:red}', root);
    expect(out.startsWith('@font-face')).toBe(true);
    expect(out).toContain('\n@scope {\n');
    expect(out).toContain('.a{');
    expect(out.indexOf('@font-face')).toBeLessThan(out.indexOf('@scope'));
  });
});

describe('compileProject', () => {
  it('compiles an unconverted page: scoped style inside the root, urls rewritten, root stamped', async () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="../css/x.css"><style>.t{color:red}</style></head>' +
      '<body><div class="post" style="background:url(../assets/a.png)"><img src="../assets/i.png"><p class="t">x</p></div></body></html>';
    const out = await compileProject({ pages: [page({ html })] }, env);
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const root = doc.querySelector('.slide') as HTMLElement;
    expect(out.startsWith('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}.slide{box-sizing:border-box}</style></head><body>')).toBe(true);
    expect(root.classList.contains('post')).toBe(true);
    expect(root.dataset.popostPage).toBe('p1');
    expect(root.dataset.popostWidth).toBe('1080');
    expect(root.dataset.popostName).toBe('One');
    expect(root.style.width).toBe('1080px');
    expect(root.style.position).toBe('relative');
    expect(root.style.overflow).toBe('hidden');
    expect(root.firstElementChild?.tagName).toBe('STYLE');
    expect(root.querySelectorAll('style').length).toBe(1);
    expect(root.querySelector('style')?.textContent).toContain('url("../assets/bg.png")');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('../assets/i.png');
  });

  it('keeps an already converted page, appending head styles', async () => {
    const html =
      '<!doctype html><html><head><style>.k{color:red}</style></head><body style="margin:0">' +
      '<div class="slide" data-popost-page="p1" style="width:1080px;height:1350px"><style data-popost-style>.o{}</style><style data-popost-head-style>.old{}</style></div></body></html>';
    const out = await compileProject({ pages: [page({ html })] }, env);
    const root = new DOMParser().parseFromString(out, 'text/html').querySelector('.slide') as HTMLElement;
    expect(root.querySelectorAll('style[data-popost-style]').length).toBe(1);
    const heads = root.querySelectorAll('style[data-popost-head-style]');
    expect(heads.length).toBe(1);
    expect(heads[0]?.textContent).toContain('.k');
    expect(heads[0]?.textContent).not.toContain('.old');
  });

  it('throws for pages without a canvas root and for external styles', async () => {
    await expect(compileProject({ pages: [page({ html: '<p>x</p>' })] }, env)).rejects.toThrow('页面 p1 缺少 .post/.page 画布根节点');
    const external = '<html><head><link rel="stylesheet" href="https://cdn.example/a.css"></head><body><div class="post"></div></body></html>';
    await expect(compileProject({ pages: [page({ html: external })] }, env)).rejects.toThrow('请先将字体和样式保存到工程内');
  });

  it('joins pages with newlines in manifest order', async () => {
    const mk = (id: string): ManifestPage => page({ id, htmlPath: `pages/${id}.html`, html: '<html><head></head><body><div class="post"></div></body></html>' });
    const out = await compileProject({ pages: [mk('a'), mk('b')] }, env);
    expect(out.indexOf('data-popost-page="a"')).toBeLessThan(out.indexOf('data-popost-page="b"'));
    expect(out).toContain('</div>\n<div');
  });
});

describe('splitProject', () => {
  const ctx = { previousPages: [{ id: 'p1', width: 800, height: 900, role: 'cover' }], defaultSize: { width: 1080, height: 1350 }, newPageId: () => 'p-new' };

  it('splits top-level slides, reusing sizes and roles of known pages', () => {
    const content =
      '<!doctype html><html><head><style>.a{}</style><script>x()</script><meta http-equiv="refresh" content="1"></head><body>' +
      '<div class="slide" data-popost-page="p1"><div class="slide" data-popost-page="inner"></div></div>' +
      '<div class="slide" data-popost-page="p1" data-popost-name="Dup" data-popost-width="500"></div>' +
      '<div class="slide" data-popost-page="bad id!"></div></body></html>';
    const pages = splitProject(content, ctx);
    expect(pages.map((p) => [p.id, p.name, p.width, p.height, p.role])).toEqual([
      ['p1', 'Page 1', 800, 900, 'cover'],
      ['p-new', 'Dup', 500, 1350, 'content'],
      ['p-new', 'Page 3', 1080, 1350, 'content'],
    ]);
    const first = pages[0]!;
    expect(first.html.startsWith('<!doctype html><html><head><meta charset="utf-8"><style>.a{}</style></head><body style="margin:0"><div class="slide"')).toBe(true);
    expect(first.html).not.toContain('<script');
    expect(first.html).not.toContain('http-equiv');
    expect(first.html).toContain('width: 800px; height: 900px');
  });

  it('requires at least one slide', () => {
    expect(() => splitProject('<p>x</p>', ctx)).toThrow('请至少保留一页图文');
  });

  it('removes duplicate @font-face blocks within a page', () => {
    const face = '@font-face{ font-family:F; src:url(a.woff2)}';
    const content = `<html><head><style>${face}</style><style>@font-face{\n font-family:F;\n src:url(a.woff2)}</style></head><body><div class="slide"></div></body></html>`;
    const html = splitProject(content, ctx)[0]!.html;
    expect(html.match(/@font-face/g)?.length).toBe(1);
  });

  it('generates p-<12 hex> ids by default', () => {
    const id = splitProject('<div class="slide"></div>', { ...ctx, newPageId: undefined })[0]!.id;
    expect(id).toMatch(/^p-[0-9a-f]{12}$/);
  });
});
