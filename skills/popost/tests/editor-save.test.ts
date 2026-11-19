/** The editor's HTML sanitizer, the preview document and saving pages into a project (ports of test_editor_delivery.py). */
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/core/util';
import { Project } from '../src/core/project';
import { cleanCss, previewHtml, sanitizeHtml } from '../src/editor/sanitize';
import { savePayload } from '../src/editor/save';
import { editorFixture } from './editor-helpers';

describe('sanitizeHtml', () => {
  it('drops scripts, frames, handlers, script URLs and external references', () => {
    const html = sanitizeHtml(
      '<div onclick="bad()" class="a"><script>bad()</script><iframe src="x">inner</iframe><object>o</object>' +
        '<img src="https://example.invalid/a.png" alt="x"><a href="javascript:bad()">l</a><a href="//cdn.example/x">m</a>' +
        '<link rel="stylesheet" href="http://e.test/a.css"><p style="background:url(https://e.test/b.png);color:red">t</p></div>',
    );
    expect(html).not.toMatch(/bad\(|onclick|example|e\.test|inner|<script|<iframe|<object/);
    expect(html).toContain('<div class="a">');
    expect(html).toContain('color:red');
    expect(html).toContain('alt="x"');
  });

  it('keeps data:image URLs and local references, drops other data: URLs', () => {
    const html = sanitizeHtml('<img src="data:image/png;base64,AAAA"><img src="../assets/a.png"><a href="data:text/html;base64,AAAA">x</a>');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('src="../assets/a.png"');
    expect(html).not.toContain('data:text/html');
  });

  it('cleans CSS text of imports, external urls and expressions', () => {
    expect(cleanCss('@import url(https://x.test/a.css); .a{background:url("https://x.test/b.png");width:expression(1)}')).toBe(
      ' .a{background:;width:}',
    );
    const html = sanitizeHtml('<style data-x="1" onload="bad()">@import "a.css";.a{background:url(//x/y.png)}.b{color:red}</style>');
    expect(html).toBe('<style data-x="1">.a{background:}.b{color:red}</style>');
  });

  it('escapes text, closes void elements and keeps SVG self-closing tags', () => {
    expect(sanitizeHtml('<p>a &amp; b &lt; c</p><br><svg><path d="M0"/></svg>')).toBe('<p>a &amp; b &lt; c</p><br/><svg><path d="M0"></path></svg>');
  });
});

describe('previewHtml', () => {
  const nonce = 'a'.repeat(32);

  it('keeps only the nonce editor script and sets a strict policy', () => {
    const { body, csp } = previewHtml(
      '<html><head></head><body onload="bad()"><script>bad()</script>' +
        `<script nonce="${nonce}">window.previewReady=true</script>` +
        `<script nonce="${nonce}" src="https://example.invalid/x.js"></script></body></html>`,
      nonce,
    );
    expect(body).not.toContain('bad()');
    expect(body).not.toContain('example.invalid');
    expect(body).toContain('window.previewReady=true');
    expect(body).toContain('<base href="/pages/">');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
  });

  it('allows no script at all without a nonce, and rejects an unsafe nonce', () => {
    expect(previewHtml('<head></head><script>x()</script>', null).csp).toContain("script-src 'none'");
    expect(() => previewHtml('<html></html>', 'unsafe nonce')).toThrow('invalid preview nonce');
  });

  it('drops <base> and meta http-equiv from the document being previewed', () => {
    const { body } = previewHtml('<head><base href="https://evil.test/"><meta http-equiv="refresh" content="0"></head>', null);
    expect(body).not.toContain('evil.test');
    expect(body).not.toContain('refresh');
  });
});

const page = (id: string, html = `<div class="post">${id}</div>`, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  width: 300,
  height: 400,
  html,
  ...extra,
});

describe('savePayload', () => {
  it('writes sanitized pages, replaces the page list and bumps the revision', async () => {
    const { project, rt } = await editorFixture();
    const saved = await savePayload(project, { pages: [page('p1', '<div class="post" onclick="x()">one<script>y()</script></div>'), page('cover', '<div class="post">c</div>', { role: 'cover' })] });
    expect(saved.map((s) => s.id)).toEqual(['p1', 'cover']);
    const reloaded = await Project.load(rt, project.root);
    expect(reloaded.manifest.pages.map((p) => [p.id, p.htmlPath, p.role])).toEqual([
      ['p1', 'pages/p1.html', 'content'],
      ['cover', 'pages/cover.html', 'cover'],
    ]);
    const html = await reloaded.readPageHtml('p1');
    expect(html).toBe('<div class="post">one</div>');
    expect(saved[0]!.sha256).toBe(sha256(html));
    expect(reloaded.manifest.revision).toBe(1);
  });

  it('accepts the whole manifest payload the editor sends and integer-like sizes', async () => {
    const { project } = await editorFixture();
    await savePayload(project, { manifest: { pages: [page('p1', '<div class="post">x</div>', { width: '320', height: 480 })] } });
    expect(project.manifest.pages[0]).toMatchObject({ width: 320, height: 480 });
  });

  it.each([
    ['an unsafe page id', { pages: [page('../x')] }, 'invalid or duplicate page id'],
    ['a duplicate page id', { pages: [page('a'), page('a')] }, 'invalid or duplicate page id'],
    ['no pages', { pages: [] }, 'project needs at least one page'],
    ['a canvas size of 0', { pages: [page('a', 'x', { width: 0 })] }, 'invalid canvas size'],
    ['a canvas size over the limit', { pages: [page('a', 'x', { height: 16385 })] }, 'invalid canvas size'],
    ['a size that is not a number', { pages: [page('a', 'x', { width: 'wide' })] }, 'invalid canvas size'],
    ['an unknown mode', { mode: 'wild', pages: [page('a')] }, 'invalid project mode'],
    ['html that is not text', { pages: [{ id: 'a', html: 5 }] }, 'page html must be a string'],
  ])('rejects %s before writing anything', async (_name, payload, message) => {
    const { project, rt } = await editorFixture();
    const before = await project.readPageHtml('p1');
    await expect(savePayload(project, payload)).rejects.toMatchObject({ name: 'ValueError', message });
    expect(await rt.fs.readText(project.abs('pages/p1.html'))).toBe(before);
    expect(project.manifest.revision).toBe(0);
  });

  it('links the CSS of installed fonts unless the page embeds the family', async () => {
    const { project } = await editorFixture();
    project.manifest.fonts = [
      { id: 'a', cssFamily: 'Family A', cssPath: 'css/a.css' },
      { id: 'b', cssFamily: 'Family B', cssPath: 'css/b.css' },
    ];
    await savePayload(project, {
      pages: [page('p1', "<html><head><style>@font-face { font-family: 'Family B'; src: url(data:font/woff2;base64,AA) }</style><link rel=\"stylesheet\" href=\"../css/old.css\"></head><body></body></html>")],
    });
    const html = await project.readPageHtml('p1');
    expect(html).toContain('<link rel="stylesheet" href="../css/a.css"></head>');
    expect(html).not.toContain('css/b.css');
    expect(html).not.toContain('css/old.css');
  });

  it('drops the series review when the page list changes, keeps it when only the content changes', async () => {
    const { project } = await editorFixture();
    project.manifest.seriesReview = { reviewer: 'agent' };
    await savePayload(project, { pages: [page('p1', '<div class="post">changed</div>')] });
    expect(project.manifest.seriesReview).toBeUndefined(); // new HTML always invalidates reviews (writePageHtml)
    project.manifest.seriesReview = { reviewer: 'agent' };
    await savePayload(project, { pages: [page('p1', '<div class="post">changed</div>')] });
    expect(project.manifest.seriesReview).toEqual({ reviewer: 'agent' });
    await savePayload(project, { pages: [page('p1', '<div class="post">changed</div>'), page('p2')] });
    expect(project.manifest.seriesReview).toBeUndefined();
  });

  it('rolls the project back when a write fails half way', async () => {
    const { project, rt } = await editorFixture();
    const before = await project.readPageHtml('p1');
    const write = rt.fs.writeFile.bind(rt.fs);
    const spy = vi.spyOn(rt.fs, 'writeFile').mockImplementation((path, data) => {
      if (path.endsWith('p2.html.tmp')) return Promise.reject(new Error('disk full'));
      return write(path, data);
    });
    await expect(savePayload(project, { pages: [page('p1', '<div class="post">new</div>'), page('p2')] })).rejects.toThrow('disk full');
    spy.mockRestore();
    expect(await rt.fs.readText(project.abs('pages/p1.html'))).toBe(before);
    expect(await rt.fs.stat(project.abs('pages/p2.html'))).toBeNull();
    const reloaded = await Project.load(rt, project.root);
    expect(reloaded.manifest.pages.map((p) => p.id)).toEqual(['p1']);
  });
});
