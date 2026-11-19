/**
 * `popost deck export|import` with the installed Chrome: the editor's own compileProject / splitProject run in Chromium
 * over a project on the in-memory file system. Skipped when no Chrome / Chromium is found (set POPOST_CHROME).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContextOptions } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateDeck } from '../../../packages/canvas-editor/src/core/validate';
import { Project } from '../src/core/project';
import { exportDeck } from '../src/deck/export-deck';
import { importDeck } from '../src/deck/import-deck';
import { findChromium, launchChromium } from '../src/render/browser';
import { loadPage, openOfflineContext, withBrowser } from '../src/render/offline';
import { renderPagePng } from '../src/render/png';
import { createTestRuntime, mountPackageFiles, runCli, type TestRuntime } from '../src/testing/memory';
import { compose, deckProject, pageDocument, reviewEverything, slidesOf } from './deck-helpers';

const chrome = findChromium(process.env);

interface Spy {
  /** Every request any browser context of the runtime made, in order. */
  readonly requests: string[];
}

/** A runtime that launches the real browser and records each request its contexts see. */
const chromeRuntime = async (spy: Spy): Promise<TestRuntime> => {
  const rt = createTestRuntime({
    launchBrowser: async (): Promise<Browser> => {
      const browser = await launchChromium(process.env);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = (async (options?: BrowserContextOptions) => {
        const context = await newContext(options);
        context.on('request', (request) => spy.requests.push(request.url()));
        return context;
      }) as Browser['newContext'];
      return browser;
    },
  });
  await mountPackageFiles(rt.fs, ['assets/project-starter', 'tests/fixtures']);
  return rt;
};

/** A web server that counts what reaches it: nothing in these tests may. */
let hits: string[] = [];
let server: Server;
let remote = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const setup = async (): Promise<{ rt: TestRuntime; project: Project; spy: Spy }> => {
  hits = [];
  const spy: Spy = { requests: [] };
  const rt = await chromeRuntime(spy);
  return { rt, project: await deckProject(rt), spy };
};

const attr = (html: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe.skipIf(!chrome)('deck export with Chrome', () => {
  it('writes one editor document: a .slide[data-popost-page] per page, with its size, name and the stylesheet inlined', async () => {
    const { rt } = await setup();
    const result = await runCli(rt, ['deck', 'export', '--dir', 'P']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(rt.json()).toEqual({ ok: true, file: '/work/P/exports/deck.html', pages: 3 });

    const doc = await rt.fs.readText('/work/P/exports/deck.html');
    expect(validateDeck(doc)).toBe(3);
    const { slides } = slidesOf(doc);
    expect(slides.map((slide) => slide.id)).toEqual(['p1', 'p2', 'p3']);
    expect(slides.map((slide) => [attr(slide.html, 'data-popost-width'), attr(slide.html, 'data-popost-height'), attr(slide.html, 'data-popost-name')])).toEqual([
      ['300', '400', 'Page 1'],
      ['200', '200', 'Two'],
      ['200', '200', 'Three'],
    ]);
    expect(slides[0]!.html).toContain('class="post slide"');
    expect(slides[0]!.html).toContain('width: 300px; height: 400px');
    // the linked stylesheet is inside the page now, scoped to it, and its font URL is relative to the pages
    expect(slides[0]!.html).toContain('@font-face');
    expect(slides[0]!.html).toContain('url("../fonts/demo.woff2")');
    expect(slides[0]!.html).toContain('@scope');
    expect(slides[0]!.html).toContain('color: rgb(18, 52, 86)');
    expect(slides[0]!.html).toContain('src="../assets/local.png"');
    // inline styles are the page's layout: the root's own and every layer's survive, with url()s made relative
    expect(slides[0]!.html).toContain('background-color: rgb(232, 240, 255)');
    expect(slides[0]!.html).toContain('color: rgb(34, 51, 68)');
    expect(slides[0]!.html).toContain('style="position:absolute;left:10px;top:20px;width:150px"');
    expect(slides[0]!.html).toContain('background:url(&quot;../assets/local.png&quot;) center/cover');
    expect(doc).not.toContain('<link');
    expect(doc).not.toContain('popost.local');
  });

  it('--out writes elsewhere and prints the path as typed; the library call returns the document too', async () => {
    const { rt } = await setup();
    const cli = await runCli(rt, ['deck', 'export', '--dir', 'P', '--out', 'out/deck.html']);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(rt.json()).toEqual({ ok: true, file: 'out/deck.html', pages: 3 });
    const written = await rt.fs.readText('/work/out/deck.html');
    const result = await exportDeck(rt, 'P');
    expect(result.html).toBe(written);
    expect(result).toMatchObject({ file: '/work/P/exports/deck.html', pages: 3 });
  });

  it('each exported slide looks exactly like the page it came from', async () => {
    const { rt, project } = await setup();
    await runCli(rt, ['deck', 'export', '--dir', 'P']);
    const shots = await withBrowser(rt, async (browser) => {
      const { context } = await openOfflineContext(rt, browser, '/work/P', { scale: 1 });
      try {
        const page = await context.newPage();
        await loadPage(page, 'exports/deck.html', 800, 800);
        const out: Uint8Array[] = [];
        for (let i = 0; i < 3; i++) out.push(await page.locator('.slide').nth(i).screenshot({ scale: 'device', type: 'png' }));
        return out;
      } finally {
        await context.close();
      }
    });
    for (const [i, { id }] of project.manifest.pages.entries()) {
      const original = await rt.fs.readFile(await renderPagePng(project, id));
      expect(Buffer.from(shots[i]!).equals(Buffer.from(original)), `page ${id} differs from its export`).toBe(true);
    }
  });

  it('reads the stylesheet from the project: a missing one is a user error (2) naming it', async () => {
    const { rt } = await setup();
    await rt.fs.rm('/work/P/css/chosen.css');
    const result = await runCli(rt, ['deck', 'export', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(String(rt.json().error)).toContain('/css/chosen.css');
  });

  it('names a page the editor cannot compile', async () => {
    const { rt, project } = await setup();
    await project.writePageHtml('p2', '<!doctype html><html><body><p>no canvas root</p></body></html>');
    const result = await runCli(rt, ['deck', 'export', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(String(rt.json().error)).toContain('p2');
  });
});

describe.skipIf(!chrome)('deck import with Chrome', () => {
  it('round trip: an edit to one page changes that page only and drops only its review', async () => {
    const { rt, project } = await setup();
    await reviewEverything(rt, project);
    const files = async () => Promise.all(['p1', 'p2', 'p3'].map((id) => rt.fs.readText(`/work/P/pages/${id}.html`)));
    const before = await files();

    const { html } = await exportDeck(rt, 'P');
    // nothing edited: nothing changes, nothing is dropped
    const same = await importDeck(rt, 'P', html);
    expect(same).toEqual({ pages: 3, changed: [], added: [], removed: [] });
    expect(await files()).toEqual(before);
    expect(Object.keys((await Project.load(rt, 'P')).manifest.reviews)).toEqual(['p1', 'p2', 'p3']);

    await rt.fs.writeFile('/work/edited.html', html.replace('Second page', 'Second page, edited'));
    const result = await runCli(rt, ['deck', 'import', '--file', 'edited.html', '--dir', 'P']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(rt.json()).toEqual({ ok: true, pages: 3, changed: ['p2'], added: [], removed: [] });

    const after = await files();
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).toContain('Second page, edited');
    // the page keeps its inline styles through the split, the root's included
    expect(after[1]).toContain('style="position:absolute;left:10px;top:20px;width:150px"');
    expect(after[1]).toMatch(/class="post slide"[^>]*style="[^"]*background-color: rgb\(232, 240, 255\)[^"]*position: relative/);
    const manifest = (await Project.load(rt, 'P')).manifest;
    expect(Object.keys(manifest.reviews)).toEqual(['p1', 'p3']);
    expect(manifest.seriesReview).toBeUndefined();
    expect(await rt.fs.stat('/work/P/exports/p2.render.json')).toBeNull();
    expect(await rt.fs.stat('/work/P/exports/p2.png')).toBeNull();
    expect(await rt.fs.stat('/work/P/exports/p1.render.json')).not.toBeNull();
    expect(manifest.pages.map((page) => [page.id, page.role, page.width, page.height])).toEqual([
      ['p1', 'cover', 300, 400],
      ['p2', undefined, 200, 200],
      ['p3', undefined, 200, 200],
    ]);

    // the edit survives the next export, and importing that export changes nothing: the project is at rest
    const again = await exportDeck(rt, 'P');
    expect(again.html).toContain('Second page, edited');
    expect(await importDeck(rt, 'P', again.html)).toEqual({ pages: 3, changed: [], added: [], removed: [] });
  });

  it('a document that was exported before an earlier import still matches the pages it left alone', async () => {
    const { rt } = await setup();
    const { html: first } = await exportDeck(rt, 'P');
    // the user edits page 2; the project takes it
    const second = first.replace('Second page', 'Second page, edited');
    expect((await importDeck(rt, 'P', second)).changed).toEqual(['p2']);
    // the page is now stored the way the editor split it, which compiles slightly differently; the review the agent gave it
    // after that import must survive the user's next save, which started from the same document and touched page 1 only
    const current = await Project.load(rt, 'P');
    current.manifest.reviews.p2 = { reviewer: 'agent', note: 'looked at the edit' };
    await current.saveManifest();
    expect(await importDeck(rt, 'P', second)).toEqual({ pages: 3, changed: [], added: [], removed: [] });
    const third = second.replace('First page 你好', 'First page 你好, edited too');
    expect(await importDeck(rt, 'P', third)).toEqual({ pages: 3, changed: ['p1'], added: [], removed: [] });
    expect((await Project.load(rt, 'P')).manifest.reviews.p2).toEqual({ reviewer: 'agent', note: 'looked at the edit' });
  });

  it('follows a document that reorders, renames, resizes, edits and adds pages', async () => {
    const { rt, project } = await setup();
    await reviewEverything(rt, project);
    const { html } = await exportDeck(rt, 'P');
    const parts = slidesOf(html);
    const [p1, p2, p3] = parts.slides;
    const renamed = p2!.html.replace('data-popost-name="Two"', 'data-popost-name="Two, renamed"').replaceAll('200', '240');
    const edited = p1!.html.replace('First page 你好', 'First page, edited');
    const fresh =
      '<div class="slide" data-popost-page="p-fresh" data-popost-name="Fresh" data-popost-width="500" data-popost-height="600"><p>brand new</p></div>';

    const result = await importDeck(rt, 'P', compose(parts, [p3!.html, renamed, edited, fresh]));

    expect(result).toEqual({ pages: 4, changed: ['p2', 'p1'], added: ['p-fresh'], removed: [] });
    const manifest = (await Project.load(rt, 'P')).manifest;
    expect(manifest.pages.map((page) => page.id)).toEqual(['p3', 'p2', 'p1', 'p-fresh']);
    expect(manifest.pages[1]).toMatchObject({ id: 'p2', name: 'Two, renamed', width: 240, height: 240 });
    expect(manifest.pages[3]).toMatchObject({ id: 'p-fresh', name: 'Fresh', width: 500, height: 600, role: 'content', htmlPath: 'pages/p-fresh.html' });
    expect(await rt.fs.readText('/work/P/pages/p-fresh.html')).toContain('brand new');
    expect(await rt.fs.readText('/work/P/pages/p1.html')).toContain('First page, edited');
    expect(Object.keys(manifest.reviews)).toEqual(['p3']);
    expect(manifest.seriesReview).toBeUndefined();
  });

  it('a slide copied in the editor (same page id twice) becomes a new page with a fresh id', async () => {
    const { rt } = await setup();
    const { html } = await exportDeck(rt, 'P');
    const parts = slidesOf(html);
    const doc = compose(parts, [...parts.slides.map((slide) => slide.html), parts.slides[2]!.html]);
    const result = await importDeck(rt, 'P', doc);
    expect(result.changed).toEqual([]);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatch(/^p-[0-9a-f]{12}$/);
    const manifest = (await Project.load(rt, 'P')).manifest;
    expect(manifest.pages.map((page) => page.id)).toEqual(['p1', 'p2', 'p3', result.added[0]]);
    expect(await rt.fs.readText(`/work/P/pages/${result.added[0]}.html`)).toContain('Third page');
  });

  it('removes a page the document dropped, with its file, review and render', async () => {
    const { rt, project } = await setup();
    await reviewEverything(rt, project);
    const { html } = await exportDeck(rt, 'P');
    const parts = slidesOf(html);
    const result = await importDeck(rt, 'P', compose(parts, [parts.slides[0]!.html, parts.slides[2]!.html]));
    expect(result).toEqual({ pages: 2, changed: [], added: [], removed: ['p2'] });
    expect(await rt.fs.stat('/work/P/pages/p2.html')).toBeNull();
    expect(await rt.fs.stat('/work/P/exports/p2.png')).toBeNull();
    expect((await Project.load(rt, 'P')).manifest.pages.map((page) => page.id)).toEqual(['p1', 'p3']);
  });

  it('a document without a slide is a user error (2) and the project stays as it was', async () => {
    const { rt } = await setup();
    const before = await rt.fs.readText('/work/P/social-studio-project.json');
    await rt.fs.writeFile('/work/slideless.html', '<!doctype html><html><body><div class="slider">x</div><p>slide</p></body></html>');
    const result = await runCli(rt, ['deck', 'import', '--file', 'slideless.html', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(rt.json().ok).toBe(false);
    expect(await rt.fs.readText('/work/P/social-studio-project.json')).toBe(before);
  });

  it('imported pages are static: scripts and handlers in the document do not reach the project', async () => {
    const { rt } = await setup();
    const { html } = await exportDeck(rt, 'P');
    const evil = html.replace(
      /(<div [^>]*data-popost-page="p2"[^>]*>)/,
      `$1<script>new Image().src='${remote}/ran'</script><img src="../assets/local.png" onerror="new Image().src='${remote}/handler'">`,
    );
    const result = await importDeck(rt, 'P', evil);
    expect(result.changed).toEqual(['p2']);
    const page = await rt.fs.readText('/work/P/pages/p2.html');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('onerror');
    expect(hits).toEqual([]);
  });
});

describe.skipIf(!chrome)('deck isolation', () => {
  it('a <script> in a project page never runs, and the exported document has none', async () => {
    const { rt, project, spy } = await setup();
    const beacon = `new Image().src='${remote}/script-ran';fetch('${remote}/fetch');document.title='ran'`;
    await project.writePageHtml(
      'p1',
      pageDocument('p1', 'First page 你好', [300, 400], `<script>${beacon}</script><img src="../assets/local.png" onerror="${beacon}">`).replace(
        '<body>',
        `<body onload="${beacon}">`,
      ),
    );
    const result = await runCli(rt, ['deck', 'export', '--dir', 'P']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const doc = await rt.fs.readText('/work/P/exports/deck.html');
    expect(validateDeck(doc)).toBe(3);
    for (const active of ['<script', 'onerror', 'onload', remote]) expect(doc).not.toContain(active);
    expect(doc).toContain('First page 你好');
    expect(hits).toEqual([]);
    expect(spy.requests.every((url) => url.startsWith('http://popost.local/'))).toBe(true);
  });

  it('a remote URL is never requested: a page that points at one fails the export, and nothing reaches the server', async () => {
    const { rt, project, spy } = await setup();
    const cases = [
      `<img src="${remote}/pixel.png">`,
      `<div style="background:url(${remote}/bg.png)"></div>`,
      `<style>.x{background:url(${remote}/css.png)}</style>`,
    ];
    for (const extra of cases) {
      await project.writePageHtml('p3', pageDocument('p3', 'Third page', [200, 200], extra));
      const result = await runCli(rt, ['deck', 'export', '--dir', 'P']);
      expect(result.code, extra).toBe(2);
      expect(String(rt.json().error)).toContain('站外资源');
    }
    // not rejected by the editor, but must not be fetched either: an @import by string, a <link> outside the page root
    await project.writePageHtml(
      'p3',
      pageDocument('p3', 'Third page', [200, 200], `<style>@import "${remote}/a.css";</style>`).replace(
        '</head>',
        `<link rel="preconnect" href="${remote}"><link rel="prefetch" href="${remote}/p"></head>`,
      ),
    );
    const ok = await runCli(rt, ['deck', 'export', '--dir', 'P']);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(hits).toEqual([]);
    expect(spy.requests.length).toBeGreaterThan(0);
    expect(spy.requests.every((url) => url.startsWith('http://popost.local/'))).toBe(true);
  });

  it('a remote URL in an imported document is never requested either', async () => {
    const { rt, spy } = await setup();
    const { html } = await exportDeck(rt, 'P');
    const doc = html.replace(
      /(<div [^>]*data-popost-page="p3"[^>]*>)/,
      `$1<img src="${remote}/pixel.png"><style>@import url(${remote}/a.css);.y{background:url(${remote}/b.png)}</style>`,
    );
    const result = await importDeck(rt, 'P', doc);
    expect(result.changed).toEqual(['p3']);
    expect(await rt.fs.readText('/work/P/pages/p3.html')).not.toContain(remote);
    expect(hits).toEqual([]);
    expect(spy.requests.every((url) => url.startsWith('http://popost.local/'))).toBe(true);
  });

  it('closes the browser when the host aborts, even while it waits for the project', async () => {
    const { rt } = await setup();
    const controller = new AbortController();
    const states = { launched: 0, closed: 0 };
    const launch = rt.launchBrowser;
    const readFile = rt.fs.readFile;
    // the stylesheet read never finishes by itself: the export is stuck inside the browser until the host gives up
    rt.fs.readFile = async (path) => {
      if (path.endsWith('chosen.css')) {
        setTimeout(() => controller.abort(), 100);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      return readFile(path);
    };
    const aborting = Object.assign(rt, {
      signal: controller.signal,
      launchBrowser: async () => {
        const browser = await launch();
        states.launched++;
        browser.on('disconnected', () => states.closed++);
        return browser;
      },
    });
    const started = Date.now();
    await expect(exportDeck(aborting, 'P')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(states).toEqual({ launched: 1, closed: 1 });
  });
});
