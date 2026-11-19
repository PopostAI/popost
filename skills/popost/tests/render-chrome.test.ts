/**
 * Real rendering with the installed Chrome: pages are served from the in-memory file system and nothing else is reachable.
 * Skipped when no Chrome / Chromium is found (set POPOST_CHROME to point at one).
 */
import { unzipSync } from 'fflate';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sniffImage } from '../src/core/image';
import { Project } from '../src/core/project';
import { auditHtmlFiles } from '../src/render/audit';
import { findChromium, launchChromium } from '../src/render/browser';
import { loadPage, openOfflineContext, PROJECT_ORIGIN } from '../src/render/offline';
import { createTestRuntime, mountPackageFiles, runCli, type TestRuntime } from '../src/testing/memory';
import { PNG_1X1, pageHtml } from './workflow-helpers';

const chrome = findChromium(process.env);

const chromeRuntime = async (): Promise<{ rt: TestRuntime; launches: { count: number } }> => {
  const launches = { count: 0 };
  const rt = createTestRuntime({
    env: {},
    launchBrowser: () => {
      launches.count++;
      return launchChromium(process.env);
    },
  });
  await mountPackageFiles(rt.fs, ['assets/project-starter', 'tests/fixtures']);
  return { rt, launches };
};

const project = async (rt: TestRuntime, width = 300, height = 400): Promise<Project> => {
  const created = await Project.create(rt, 'P', 'chrome test', 'original', width, height);
  await created.writePageHtml(
    'p1',
    '<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;box-sizing:border-box}' +
      `.post{position:relative;width:${width}px;height:${height}px;background:#fff;padding:20px}` +
      '</style></head><body><div class="post"><h1 data-layer-id="t">Hello 你好</h1></div></body></html>',
  );
  return created;
};

describe.skipIf(!chrome)('render with Chrome', () => {
  it('renders a page from the in-memory file system to a PNG of the page size, and reuses it', async () => {
    const { rt, launches } = await chromeRuntime();
    await project(rt);
    const first = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(rt.json()).toEqual({ ok: true, png: '/work/P/exports/p1.png', rendered: ['p1'], unchanged: [] });
    const png = await rt.fs.readFile('/work/P/exports/p1.png');
    expect(sniffImage(png)).toMatchObject({ format: 'png', width: 300, height: 400 });
    const receipt = JSON.parse(await rt.fs.readText('/work/P/exports/p1.render.json')) as Record<string, string>;
    expect(receipt.renderer).toBe('popost-png-v2:scale1:offline:fonts-ready');

    await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(launches.count).toBe(1);
    await runCli(rt, ['render', '--dir', 'P', '--page', 'p1', '--force']);
    expect(launches.count).toBe(2);
  });

  it('renders a list of pages in one browser and then only the changed ones', async () => {
    const { rt, launches } = await chromeRuntime();
    const created = await project(rt);
    await created.addPage('p2', 'Two', 200, 200);
    await created.addPage('p3', 'Three', 200, 200);
    const first = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1,p3']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(rt.json()).toEqual({
      ok: true,
      pngs: { p1: '/work/P/exports/p1.png', p3: '/work/P/exports/p3.png' },
      rendered: ['p1', 'p3'],
      unchanged: [],
    });
    expect(launches.count).toBe(1);

    await created.writePageHtml('p3', '<div class="page" style="width:200px;height:200px;background:#eee">changed</div>');
    await runCli(rt, ['render', '--dir', 'P', '--page', 'all']);
    expect(rt.json()).toMatchObject({ ok: true, exported: '/work/P/exports/all.zip', rendered: ['p2', 'p3'], unchanged: ['p1'] });
    expect(launches.count).toBe(2);
  });

  it('exports all pages into one ZIP', async () => {
    const { rt } = await chromeRuntime();
    const created = await project(rt);
    await created.addPage('p2', 'Two', 200, 200);
    const result = await runCli(rt, ['export', '--dir', 'P', '--page', 'all']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const files = unzipSync(await rt.fs.readFile(String(rt.json().exported)));
    expect(Object.keys(files)).toEqual(['p1.png', 'p2.png']);
    expect(sniffImage(files['p2.png']!)).toMatchObject({ width: 200, height: 200 });
  });

  it('shows images from the project and refuses a missing one', async () => {
    const { rt } = await chromeRuntime();
    const created = await project(rt, 1080, 1440);
    await created.writePageHtml('p1', pageHtml('with image', true));
    const missing = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(missing.code).toBe(2);
    expect(rt.json().error).toBe('RuntimeError: page contains missing or unreadable images');
    await created.addAssetBytes(PNG_1X1, 'local.png');
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p1'])).code).toBe(0);
  });

  it('falls back to a .page root when there is no .post', async () => {
    const { rt } = await chromeRuntime();
    const created = await project(rt);
    await created.writePageHtml(
      'p1',
      '<!doctype html><html><body style="margin:0"><div class="page" style="width:300px;height:400px;background:#ccc">x</div></body></html>',
    );
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p1'])).code).toBe(0);
    expect(sniffImage(await rt.fs.readFile('/work/P/exports/p1.png'))).toMatchObject({ width: 300, height: 400 });
  });

  it('reports a page without a .post / .page root', async () => {
    const { rt } = await chromeRuntime();
    const created = await project(rt);
    await created.writePageHtml('p1', '<!doctype html><html><body><main>no root</main></body></html>');
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p1'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('no .post or .page root');
  });
});

describe.skipIf(!chrome)('the offline sandbox', () => {
  let external: Server;
  let hits: string[] = [];
  let base = '';

  beforeAll(async () => {
    external = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG_1X1));
    });
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => external.close(() => resolve())));

  it('aborts every request that is not for the project, whatever loads it', async () => {
    hits = [];
    const { rt } = await chromeRuntime();
    const html =
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${base}/a.css"><link rel="preload" as="image" href="${base}/b.png">` +
      `<style>@import url("${base}/c.css");.post{width:100px;height:100px;background:url(${base}/d.png)}</style>` +
      `</head><body><div class="post"><img src="${base}/e.png"><img src="http://example.invalid/f.png">` +
      `<img src="//127.0.0.1:${new URL(base).port}/g.png"><img src="file:///etc/hostname"></div></body></html>`;
    await rt.fs.writeFile('/work/P/index.html', html);
    const browser = await rt.launchBrowser();
    try {
      const { context, blocked } = await openOfflineContext(rt, browser, '/work/P', { scale: 1 });
      const page = await context.newPage();
      await loadPage(page, 'index.html', 100, 100);
      expect(blocked.length).toBeGreaterThanOrEqual(5);
      for (const name of ['a.css', 'b.png', 'd.png', 'e.png', 'f.png', 'g.png'])
        expect(blocked.some((url) => url.endsWith(`/${name}`)), name).toBe(true);
      expect(await page.evaluate('Array.from(document.images).every((i) => i.naturalWidth === 0)')).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
    expect(hits).toEqual([]);
  });

  it('does not run page scripts or inline handlers, while the renderer can still inspect the page', async () => {
    const { rt } = await chromeRuntime();
    await rt.fs.writeFile('/work/P/app.js', "document.body.setAttribute('data-ran-external', '1')");
    await rt.fs.writeFile(
      '/work/P/index.html',
      '<!doctype html><html><body onload="document.body.setAttribute(\'data-ran-handler\', \'1\')">' +
        "<script>document.body.setAttribute('data-ran-inline', '1')</script><script src=\"app.js\"></script>" +
        '<div class="post">static</div></body></html>',
    );
    const browser = await rt.launchBrowser();
    try {
      const { context } = await openOfflineContext(rt, browser, '/work/P', { scale: 1 });
      const page = await context.newPage();
      await loadPage(page, 'index.html', 100, 100);
      expect(await page.evaluate('1 + 1')).toBe(2);
      expect(await page.evaluate('Object.keys(document.body.dataset).length')).toBe(0);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('serves only files inside the project root, from the file system the runtime gives', async () => {
    const { rt } = await chromeRuntime();
    await rt.fs.writeFile('/work/secret.txt', 'outside the project');
    await rt.fs.writeFile('/work/P/inside.txt', 'inside the project');
    const browser = await rt.launchBrowser();
    try {
      const { context, blocked } = await openOfflineContext(rt, browser, '/work/P', { scale: 1 });
      const page = await context.newPage();
      const inside = await page.goto(`${PROJECT_ORIGIN}/inside.txt`);
      expect(inside?.status()).toBe(200);
      expect(await inside?.text()).toBe('inside the project');
      for (const url of [`${PROJECT_ORIGIN}/../secret.txt`, `${PROJECT_ORIGIN}/%2e%2e/secret.txt`, `${PROJECT_ORIGIN}/..%2fsecret.txt`]) {
        const outside = await page.goto(url);
        expect(await outside?.text(), url).not.toContain('outside the project');
      }
      // other origins and schemes of the project host name are not the project
      await page.goto(`https://popost.local/inside.txt`).catch(() => undefined);
      expect(blocked).toContain('https://popost.local/inside.txt');
      await context.close();
    } finally {
      await browser.close();
    }
  });
});

describe.skipIf(!chrome)('machine audit', () => {
  it('accepts a clean page at scale 2 with a preview, and says it is render-only', async () => {
    const { rt } = await chromeRuntime();
    const report = await auditHtmlFiles(rt, ['/skill/tests/fixtures/render/valid.html'], {
      outDir: '/work/out',
      width: 300,
      height: 400,
      root: '/skill/tests/fixtures/render',
    });
    expect(report.summary).toMatchObject({ total: 1, accepted: 1, failed: 0 });
    expect(report.acceptanceScope).toBe('render-audit-only');
    expect(report.reviews).toEqual([]);
    const page = report.pages[0]!;
    expect(page.status).toBe('accepted');
    expect(sniffImage(await rt.fs.readFile(String(page.artifacts.png)))).toMatchObject({ width: 600, height: 800 });
    expect(sniffImage(await rt.fs.readFile(String(page.artifacts.preview)))).toMatchObject({ width: 375 });
    expect(await rt.fs.readText(`${String(page.artifacts.png)}.sha256`)).toContain(String(page.artifacts.sha256));
    expect(JSON.parse(await rt.fs.readText('/work/out/report.json'))).toMatchObject({ schemaVersion: 'render-audit.v1' });
  });

  it('rejects scripts and a missing root without promoting a PNG', async () => {
    const { rt } = await chromeRuntime();
    const report = await auditHtmlFiles(
      rt,
      ['/skill/tests/fixtures/render/script.html', '/skill/tests/fixtures/render/noroot.html'],
      { outDir: '/work/out', root: '/skill/tests/fixtures/render' },
    );
    const [script, noRoot] = report.pages;
    expect(script!.issues.map((i) => i.code)).toContain('script-present');
    expect(script!.status).toBe('failed');
    expect(noRoot!.issues.map((i) => i.code)).toContain('no-root-page');
    expect(report.summary.failed).toBe(2);
    expect(await rt.fs.stat('/work/out/pages')).toBeNull();
  });

  it('finds content that leaves the canvas or is clipped, and does not promote such a page', async () => {
    const { rt } = await chromeRuntime();
    await rt.fs.writeFile(
      '/work/h/bad.html',
      '<!doctype html><html><body style="margin:0"><div class="post" style="position:relative;width:100px;height:100px">' +
        '<div style="position:absolute;left:80px;top:0;width:60px;height:10px;background:red">out</div>' +
        '<div style="width:40px;height:10px;overflow:hidden"><div style="width:90px;height:5px"></div></div></div></body></html>',
    );
    const report = await auditHtmlFiles(rt, ['/work/h/bad.html'], { outDir: '/work/out', width: 100, height: 100 });
    const codes = report.pages[0]!.issues.map((i) => i.code);
    expect(codes).toContain('out-of-bounds');
    expect(codes).toContain('clipped-hidden');
    expect(report.pages[0]!.status).toBe('failed');
    expect(report.summary.issuesByCode['out-of-bounds']).toBeGreaterThanOrEqual(1);
    expect(await rt.fs.stat('/work/out/pages')).toBeNull();
  });

  it('loads the fonts a project installed through the same sandbox', async () => {
    const { rt } = await chromeRuntime();
    await mountPackageFiles(rt.fs, [
      'assets/fonts/palette.json',
      'assets/fonts/css/editorial-serif.css',
      'assets/fonts/editorial-serif',
    ]);
    const created = await project(rt);
    expect((await runCli(rt, ['font', 'install', '--dir', 'P', '--roles', 'editorial-serif'])).code).toBe(0);
    await created.writePageHtml(
      'p1',
      (await created.readPageHtml('p1')).replace('<h1 ', '<h1 style="font-family:\'Fraunces Variable\';font-size:40px" '),
    );
    const report = await auditHtmlFiles(rt, ['/work/P/pages/p1.html'], {
      outDir: '/work/out',
      width: 300,
      height: 400,
      root: '/work/P',
    });
    const page = report.pages[0]!;
    expect(page.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(page.facts.usedFonts).toContain('Fraunces Variable / loaded');
  });
});
