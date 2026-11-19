/** `render` / `export`: argument handling, the receipt cache, ZIP export and error output (no browser needed). */
import { unzipSync } from 'fflate';
import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { pageFingerprint, RENDER_SIGNATURE } from '../src/core/fingerprint';
import { sha256 } from '../src/core/util';
import { selectPages } from '../src/render/page-select';
import { cachedPng, receiptPath } from '../src/render/png';
import { createTestRuntime, runCli, type TestRuntime } from '../src/testing/memory';
import { newProject, newRuntime, pageHtml } from './workflow-helpers';

/** Just enough PNG for the cache check: signature, IHDR length / type, width, height. */
const fakePng = (width: number, height: number): Uint8Array => {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
};

interface Fixture {
  rt: TestRuntime;
  launches: { count: number };
}

/** A runtime that counts browser launches and refuses them: every render must come from the receipt cache. */
const setup = async (): Promise<Fixture> => {
  const launches = { count: 0 };
  const base = await newRuntime();
  const rt = createTestRuntime({
    fs: base.fs,
    launchBrowser: async () => {
      launches.count++;
      throw new Error('no browser in this test');
    },
  });
  return { rt, launches };
};

/** Project `P` (1080x1440) whose `p1` has a PNG and a receipt that match the page. */
const withCachedPage = async (rt: TestRuntime, pid = 'p1') => {
  const project = await newProject(rt, 'P');
  await project.writePageHtml('p1', pageHtml());
  if (pid !== 'p1') await project.addPage(pid, pid, 1080, 1440);
  const png = fakePng(1080, 1440);
  const path = rt.path.join(project.exportsDir, `${pid}.png`);
  await rt.fs.writeFile(path, png);
  await rt.fs.writeFile(
    receiptPath(project, path),
    JSON.stringify({ fingerprint: await pageFingerprint(project, pid), pngHash: sha256(png), renderer: RENDER_SIGNATURE }),
  );
  return { project, png, path };
};

describe('render: arguments', () => {
  it('requires --dir and answers --help', async () => {
    const { rt } = await setup();
    const missing = await runCli(rt, ['render']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('the following arguments are required: --dir');
    expect((await runCli(rt, ['export', '--dir', 'P'])).stderr).toContain('--page');
    const help = await runCli(rt, ['render', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--force');
  });

  it('reports a directory that is not a project as a crash (exit 1), like the Python traceback, without the class name', async () => {
    const { rt } = await setup();
    const result = await runCli(rt, ['render', '--dir', 'nowhere']);
    expect(result.code).toBe(1);
    expect(rt.json()).toMatchObject({ ok: false });
    expect(String(rt.json().error)).toMatch(/^not a v2 project \(no social-studio-project\.json\): nowhere;/);
  });
});

describe('render: the receipt cache', () => {
  it('prints the current PNG without starting a browser', async () => {
    const { rt, launches } = await setup();
    await withCachedPage(rt);
    const result = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(result.code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, png: '/work/P/exports/p1.png', rendered: [], unchanged: ['p1'] });
    expect(launches.count).toBe(0);
  });

  it('exports all pages as a ZIP of the current PNGs, default exports/all.zip', async () => {
    const { rt, launches } = await setup();
    const { png } = await withCachedPage(rt);
    const result = await runCli(rt, ['render', '--dir', 'P']);
    expect(result.code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, exported: '/work/P/exports/all.zip', rendered: [], unchanged: ['p1'] });
    expect(Object.keys(unzipSync(await rt.fs.readFile('/work/P/exports/all.zip')))).toEqual(['p1.png']);
    expect(unzipSync(await rt.fs.readFile('/work/P/exports/all.zip'))['p1.png']).toEqual(png);
    expect(launches.count).toBe(0);
  });

  it('writes --out where asked and prints the path as given', async () => {
    const { rt } = await setup();
    await withCachedPage(rt);
    await runCli(rt, ['export', '--dir', 'P', '--page', 'all', '--out', 'bundle/all.zip']);
    expect(rt.json()).toEqual({ ok: true, exported: 'bundle/all.zip', rendered: [], unchanged: ['p1'] });
    expect(await rt.fs.stat('/work/bundle/all.zip')).not.toBeNull();
  });

  it('cachedPng: a changed page, a broken PNG or a changed dependency invalidates the PNG', async () => {
    const { rt } = await setup();
    const { project, path } = await withCachedPage(rt);
    expect(await cachedPng(project, 'p1')).toBe(path);
    await rt.fs.writeFile(path, 'broken');
    expect(await cachedPng(project, 'p1')).toBeNull();

    const fresh = await withCachedPage(await createFresh());
    expect(await cachedPng(fresh.project, 'p1')).toBe(fresh.path);
    await fresh.project.writePageHtml('p1', pageHtml('another text'));
    expect(await cachedPng(fresh.project, 'p1')).toBeNull();

    const dependency = await withCachedPage(await createFresh());
    await dependency.project.rt.fs.writeFile('/work/P/css/changed.css', '/* dependency changed */');
    expect(await cachedPng(dependency.project, 'p1')).toBeNull();
  });

  it('a stale receipt needs the browser, and a failed launch is reported as JSON with exit 2', async () => {
    const { rt, launches } = await setup();
    const { project } = await withCachedPage(rt);
    await project.writePageHtml('p1', pageHtml('edited'));
    const result = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(result.code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'no browser in this test' });
    expect(launches.count).toBe(1);
  });

  it('--force renders again even when the receipt matches', async () => {
    const { rt, launches } = await setup();
    await withCachedPage(rt);
    const result = await runCli(rt, ['export', '--dir', 'P', '--page', 'p1', '--force']);
    expect(result.code).toBe(2);
    expect(launches.count).toBe(1);
  });

  it('--out is a separate file with its own receipt', async () => {
    const { rt, launches } = await setup();
    await withCachedPage(rt);
    const result = await runCli(rt, ['export', '--dir', 'P', '--page', 'p1', '--out', 'copy.png']);
    expect(result.code).toBe(2);
    expect(launches.count).toBe(1);
  });
});

describe('render: a list of pages in one call', () => {
  /** `P` with p1..p3 cached; `stale` pages are edited afterwards. */
  const withThreePages = async (rt: TestRuntime, stale: readonly string[] = []) => {
    const first = await withCachedPage(rt);
    for (const pid of ['p2', 'p3']) {
      await first.project.addPage(pid, pid, 1080, 1440);
      await first.project.writePageHtml(pid, pageHtml(pid));
      const path = rt.path.join(first.project.exportsDir, `${pid}.png`);
      await rt.fs.writeFile(path, first.png);
      await rt.fs.writeFile(
        receiptPath(first.project, path),
        JSON.stringify({ fingerprint: await pageFingerprint(first.project, pid), pngHash: sha256(first.png), renderer: RENDER_SIGNATURE }),
      );
    }
    for (const pid of stale) await first.project.writePageHtml(pid, pageHtml(`${pid} edited`));
    return first.project;
  };

  it('prints each page PNG and lists the pages as unchanged when every receipt matches', async () => {
    const { rt, launches } = await setup();
    await withThreePages(rt);
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p3, p1'])).code).toBe(0);
    expect(rt.json()).toEqual({
      ok: true,
      pngs: { p3: '/work/P/exports/p3.png', p1: '/work/P/exports/p1.png' },
      rendered: [],
      unchanged: ['p3', 'p1'],
    });
    expect(launches.count).toBe(0);
  });

  it('a one-page list prints png like a single page, and --out needs one page', async () => {
    const { rt } = await setup();
    await withThreePages(rt);
    await runCli(rt, ['render', '--dir', 'P', '--page', 'p2,p2']);
    expect(rt.json()).toMatchObject({ ok: true, png: '/work/P/exports/p2.png', unchanged: ['p2'] });
    expect((await runCli(rt, ['export', '--dir', 'P', '--page', 'p1,p2', '--out', 'x.png'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--out');
  });

  it('names the unknown page of a list and rejects an empty one', async () => {
    const { rt } = await setup();
    await withThreePages(rt);
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p1,p9'])).code).toBe(2);
    expect(rt.json().error).toBe('no such page: p9');
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', ' , '])).code).toBe(2);
    expect(String(rt.json().error)).toContain('comma-separated list');
  });

  it('opens one browser for all the stale pages of a list', async () => {
    const { rt, launches } = await setup();
    await withThreePages(rt, ['p1', 'p3']);
    expect((await runCli(rt, ['render', '--dir', 'P', '--page', 'p1,p2,p3'])).code).toBe(2);
    expect(launches.count).toBe(1);
  });

  it('selectPages: all, one id, a list in the order given, each once', async () => {
    const { rt } = await setup();
    const project = await withThreePages(rt);
    expect(selectPages(project, 'all')).toEqual(['p1', 'p2', 'p3']);
    expect(selectPages(project, 'p2')).toEqual(['p2']);
    expect(selectPages(project, 'p3,p1,p3')).toEqual(['p3', 'p1']);
    expect(() => selectPages(project, 'p1,p9')).toThrow('no such page: p9');
    expect(() => selectPages(project, ',')).toThrow('--page needs');
  });
});

describe('render: the page hygiene it does first', () => {
  it('restores the font links a rewritten page lost and says so', async () => {
    const { rt } = await setup();
    const { project } = await withCachedPage(rt);
    project.manifest.fonts = [{ id: 'serif-a', cssFamily: 'Family serif-a', cssPath: 'css/serif-a.css' }];
    await project.saveManifest();
    await rt.fs.writeFile('/work/P/css/serif-a.css', '/* font */');
    await project.writePageHtml('p1', '<style>.page{width:1080px}</style><div class="page" data-layer-id="a"></div>');
    await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(rt.json()).toMatchObject({ fontLinksRestored: ['p1'] });
    expect(await project.readPageHtml('p1')).toMatch(/^<link rel="stylesheet" href="..\/css\/serif-a.css"><style>/);
  });

  it('puts the problems of the pages in the output, also when the render fails', async () => {
    const { rt } = await setup();
    const { project } = await withCachedPage(rt);
    await project.writePageHtml('p1', pageHtml().replace('</style>', ''));
    const result = await runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    expect(result.code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
    expect((rt.json().problems as { code: string }[]).map((p) => p.code)).toContain('style-unclosed');
  });

  it('export leaves the pages alone', async () => {
    const { rt } = await setup();
    const { project } = await withCachedPage(rt);
    const html = pageHtml().replace('</style>', '');
    await project.writePageHtml('p1', html);
    await runCli(rt, ['export', '--dir', 'P', '--page', 'p1']);
    expect(rt.json()).not.toHaveProperty('problems');
    expect(await project.readPageHtml('p1')).toBe(html);
  });
});

describe('export: errors', () => {
  it('names the unknown page', async () => {
    const { rt } = await setup();
    await withCachedPage(rt);
    expect((await runCli(rt, ['export', '--dir', 'P', '--page', 'nope'])).code).toBe(2);
    expect(rt.json().error).toBe('no such page: nope');
  });

  it('--final refuses while the delivery checks are pending, and records why in build-report.json', async () => {
    const { rt } = await setup();
    await withCachedPage(rt);
    const result = await runCli(rt, ['export', '--dir', 'P', '--page', 'all', '--final']);
    expect(result.code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'final delivery checks pending; inspect build-report.json' });
    const report = JSON.parse(await rt.fs.readText('/work/P/build-report.json')) as { readyToDeliver: boolean };
    expect(report.readyToDeliver).toBe(false);
  });
});

describe('render: the host aborts the command', () => {
  /** A browser whose first context never opens until the browser is closed, like a render that hangs. */
  const hangingBrowser = (signal: AbortSignal, closed: { count: number }): Browser =>
    ({
      newContext: () =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Target page, context or browser has been closed')))),
      close: async () => void closed.count++,
    }) as unknown as Browser;

  it('closes the browser that is rendering, and reports the failure', async () => {
    const base = await setup();
    await (await newProject(base.rt, 'P')).writePageHtml('p1', pageHtml());
    const controller = new AbortController();
    const closed = { count: 0 };
    const rt = createTestRuntime({
      fs: base.rt.fs,
      signal: controller.signal,
      launchBrowser: async () => hangingBrowser(controller.signal, closed),
    });
    const running = runCli(rt, ['render', '--dir', 'P', '--page', 'p1']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect((await running).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
    expect(closed.count).toBeGreaterThanOrEqual(1);
  });

  it('does not start a browser when it is already aborted', async () => {
    const { rt, launches } = await setup();
    await (await newProject(rt, 'P')).writePageHtml('p1', pageHtml());
    const aborted = createTestRuntime({ fs: rt.fs, signal: AbortSignal.abort(), launchBrowser: rt.launchBrowser });
    expect((await runCli(aborted, ['render', '--dir', 'P', '--page', 'p1'])).code).toBe(2);
    expect(launches.count).toBe(0);
  });
});

const createFresh = async (): Promise<TestRuntime> => (await setup()).rt;
