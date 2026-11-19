/** `popost deck export|import` without a browser: arguments, exit codes, manifest and receipt handling over a fake converter. */
import { describe, expect, it, vi } from 'vitest';
import { Project } from '../src/core/project';
import { exportDeck } from '../src/deck/export-deck';
import { importDeck } from '../src/deck/import-deck';
import type { DeckSplit, DeckSplitPage } from '../src/deck/types';
import { BrowserUnavailableError } from '../src/render/browser';
import { runCli, type TestRuntime } from '../src/testing/memory';
import { deckProject, fakeSession, reviewEverything } from './deck-helpers';
import { newRuntime } from './workflow-helpers';

const split = (page: Partial<DeckSplitPage> & { id: string }, i: number): DeckSplitPage => ({
  name: `Page ${i + 1}`,
  width: 200,
  height: 200,
  role: 'content',
  html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div class="slide" data-popost-page="${page.id}">${page.id}</div></body></html>`,
  ...page,
});

const deck = (pages: (Partial<DeckSplitPage> & { id: string })[]): DeckSplit => ({
  pages: pages.map(split),
  signatures: pages.map((page) => `sig:${page.id}`),
});

const exists = async (rt: TestRuntime, path: string) => (await rt.fs.stat(path)) !== null;
const manifestOf = async (rt: TestRuntime) => (await Project.load(rt, 'P')).manifest;

describe('deck command line', () => {
  it('needs a sub-command, and each one its options', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    expect((await runCli(rt, ['deck'])).code).toBe(2);
    expect((await runCli(rt, ['deck', 'bogus'])).code).toBe(2);
    const noDir = await runCli(rt, ['deck', 'export']);
    expect(noDir.code).toBe(2);
    expect(noDir.stderr).toContain('--dir');
    const noFile = await runCli(rt, ['deck', 'import', '--dir', 'P']);
    expect(noFile.code).toBe(2);
    expect(noFile.stderr).toContain('--file');
  });

  it('lists deck in the usage text', async () => {
    const rt = await newRuntime();
    expect((await runCli(rt, ['--help'])).stdout).toContain('deck');
  });

  it('reports a directory that is not a project as a crash (1), like the other project commands', async () => {
    const rt = await newRuntime();
    const result = await runCli(rt, ['deck', 'export', '--dir', 'nowhere']);
    expect(result.code).toBe(1);
    expect(rt.json()).toMatchObject({ ok: false });
  });

  it('answers a missing browser with a user error (2) and writes nothing', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const missing = vi.fn(async () => {
      throw new BrowserUnavailableError('No Chrome, Edge or Chromium found.');
    });
    const result = await runCli(Object.assign(rt, { launchBrowser: missing }), ['deck', 'export', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'No Chrome, Edge or Chromium found.' });
    expect(await exists(rt, '/work/P/exports/deck.html')).toBe(false);
  });

  it('import: a missing file and a file without a slide are user errors (2) that never start a browser', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const launch = vi.fn(async () => {
      throw new Error('must not launch');
    });
    Object.assign(rt, { launchBrowser: launch });
    const missing = await runCli(rt, ['deck', 'import', '--file', 'nope.html', '--dir', 'P']);
    expect(missing.code).toBe(2);
    expect(String(rt.json().error)).toContain('nope.html');

    await rt.fs.writeFile('/work/plain.html', '<!doctype html><p>no pages here</p>');
    const plain = await runCli(rt, ['deck', 'import', '--file', 'plain.html', '--dir', 'P']);
    expect(plain.code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'the document has no .slide page: nothing to import' });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('exportDeck', () => {
  it('writes the converter output to exports/deck.html and returns it', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const seen: string[][] = [];
    const session = fakeSession(deck([]));
    const spy: typeof session = (fn) =>
      session((engine) =>
        fn({
          ...engine,
          compile: async (pages) => {
            seen.push(pages.map((p) => `${p.id}:${p.width}x${p.height}:${p.role ?? '-'}:${p.htmlPath}:${p.html.includes('class="post"')}`));
            return engine.compile(pages);
          },
        }),
      );
    const result = await exportDeck(rt, 'P', { session: spy });
    expect(result).toMatchObject({ file: '/work/P/exports/deck.html', pages: 3 });
    expect(await rt.fs.readText(result.file)).toBe(result.html);
    expect(seen).toEqual([
      ['p1:300x400:cover:pages/p1.html:true', 'p2:200x200:-:pages/p2.html:true', 'p3:200x200:-:pages/p3.html:true'],
    ]);
  });

  it('writes to --out, relative to the working directory', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const result = await exportDeck(rt, 'P', { out: 'out/doc.html', session: fakeSession(deck([])) });
    expect(result.file).toBe('/work/out/doc.html');
    expect(await exists(rt, '/work/out/doc.html')).toBe(true);
  });

  it('reports a page file that is gone', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    await rt.fs.rm('/work/P/pages/p2.html');
    await expect(exportDeck(rt, 'P', { session: fakeSession(deck([])) })).rejects.toThrow('page p2: pages/p2.html is missing');
  });
});

describe('importDeck', () => {
  const pageFile = (rt: TestRuntime, id: string) => rt.fs.readText(`/work/P/pages/${id}.html`);

  it('changes only the pages whose slide differs from the baseline, and drops their review and render', async () => {
    const rt = await newRuntime();
    const project = await deckProject(rt);
    await reviewEverything(rt, project);
    const before = { p1: await pageFile(rt, 'p1'), p2: await pageFile(rt, 'p2'), p3: await pageFile(rt, 'p3') };
    const session = fakeSession(deck([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]), {
      p1: 'sig:p1',
      p2: 'sig:EDITED-BEFORE',
      p3: 'sig:p3',
    });

    const result = await importDeck(rt, 'P', '<div class="slide">', { session });

    expect(result).toEqual({ pages: 3, changed: ['p2'], added: [], removed: [] });
    expect(await pageFile(rt, 'p1')).toBe(before.p1);
    expect(await pageFile(rt, 'p3')).toBe(before.p3);
    expect(await pageFile(rt, 'p2')).not.toBe(before.p2);
    expect(await pageFile(rt, 'p2')).toMatch(/^<!doctype html><html>/);
    const manifest = await manifestOf(rt);
    expect(Object.keys(manifest.reviews)).toEqual(['p1', 'p3']);
    expect(manifest.seriesReview).toBeUndefined();
    expect(await exists(rt, '/work/P/exports/p2.png')).toBe(false);
    expect(await exists(rt, '/work/P/exports/p2.render.json')).toBe(false);
    for (const id of ['p1', 'p3']) {
      expect(await exists(rt, `/work/P/exports/${id}.png`)).toBe(true);
      expect(await exists(rt, `/work/P/exports/${id}.render.json`)).toBe(true);
    }
    expect(manifest.revision).toBe((project.manifest.revision ?? 0) + 1);
  });

  it('a page without a baseline (it did not compile, or its file is gone) counts as changed', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const session = fakeSession(deck([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]), { p1: null, p3: 'sig:p3' });
    expect((await importDeck(rt, 'P', 'slide', { session })).changed).toEqual(['p1', 'p2']);
  });

  it('adds new slides, removes dropped pages with their files, reviews and renders, and follows the document order', async () => {
    const rt = await newRuntime();
    const project = await deckProject(rt);
    await reviewEverything(rt, project);
    const session = fakeSession(
      deck([{ id: 'p3' }, { id: 'p-abc123def456', name: 'Fresh', width: 500, height: 600 }, { id: 'p2', name: 'Renamed' }]),
      { p2: 'sig:p2', p3: 'sig:p3' },
    );

    const result = await importDeck(rt, 'P', 'slide', { session });

    expect(result).toEqual({ pages: 3, changed: [], added: ['p-abc123def456'], removed: ['p1'] });
    const manifest = await manifestOf(rt);
    expect(manifest.pages).toEqual([
      expect.objectContaining({ id: 'p3', name: 'Page 1', htmlPath: 'pages/p3.html', width: 200, height: 200 }),
      { id: 'p-abc123def456', name: 'Fresh', htmlPath: 'pages/p-abc123def456.html', width: 500, height: 600, role: 'content' },
      expect.objectContaining({ id: 'p2', name: 'Renamed' }),
    ]);
    expect(await exists(rt, '/work/P/pages/p-abc123def456.html')).toBe(true);
    expect(await exists(rt, '/work/P/pages/p1.html')).toBe(false);
    expect(await exists(rt, '/work/P/exports/p1.png')).toBe(false);
    expect(await exists(rt, '/work/P/exports/p1.render.json')).toBe(false);
    expect(Object.keys(manifest.reviews).sort()).toEqual(['p2', 'p3']);
    expect(manifest.seriesReview).toBeUndefined();
  });

  it('keeps ids, roles and the other manifest fields of pages it keeps', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const session = fakeSession(deck([{ id: 'p2' }, { id: 'p1', width: 300, height: 400 }, { id: 'p3' }]), {
      p1: 'sig:p1',
      p2: 'sig:p2',
      p3: 'sig:p3',
    });
    const result = await importDeck(rt, 'P', 'slide', { session });
    expect(result).toEqual({ pages: 3, changed: [], added: [], removed: [] });
    const { pages } = await manifestOf(rt);
    expect(pages.map((page) => page.id)).toEqual(['p2', 'p1', 'p3']);
    expect(pages[1]).toMatchObject({ id: 'p1', role: 'cover', htmlPath: 'pages/p1.html' });
  });

  it('reordering alone drops the series review but no page review', async () => {
    const rt = await newRuntime();
    const project = await deckProject(rt);
    await reviewEverything(rt, project);
    const session = fakeSession(deck([{ id: 'p2' }, { id: 'p1', width: 300, height: 400 }, { id: 'p3' }]), {
      p1: 'sig:p1',
      p2: 'sig:p2',
      p3: 'sig:p3',
    });
    await importDeck(rt, 'P', 'slide', { session });
    const manifest = await manifestOf(rt);
    expect(Object.keys(manifest.reviews).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(manifest.seriesReview).toBeUndefined();
  });

  it('a document that matches the project writes nothing', async () => {
    const rt = await newRuntime();
    const project = await deckProject(rt);
    await reviewEverything(rt, project);
    const before = await rt.fs.readText('/work/P/social-studio-project.json');
    const session = fakeSession(deck([{ id: 'p1', name: 'Page 1', width: 300, height: 400 }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }]), {
      p1: 'sig:p1',
      p2: 'sig:p2',
      p3: 'sig:p3',
    });
    const result = await importDeck(rt, 'P', 'slide', { session });
    expect(result).toEqual({ pages: 3, changed: [], added: [], removed: [] });
    expect(await rt.fs.readText('/work/P/social-studio-project.json')).toBe(before);
  });

  it('new pages with no size of their own take the project size', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    let asked: unknown;
    const inner = fakeSession(deck([{ id: 'p1', width: 300, height: 400 }]), { p1: 'sig:p1' });
    await importDeck(rt, 'P', 'slide', {
      session: (fn) =>
        inner((engine) =>
          fn({
            ...engine,
            split: async (content, previous, size) => {
              asked = { previous: previous.map((page) => page.id), size };
              return engine.split(content, previous, size);
            },
          }),
        ),
    });
    expect(asked).toEqual({ previous: ['p1', 'p2', 'p3'], size: { width: 300, height: 400 } });
  });

  it('refuses a page size that is not whole pixels in range, and changes nothing', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const before = await rt.fs.readText('/work/P/social-studio-project.json');
    for (const bad of [{ width: Number.NaN }, { height: 0 }, { width: 100.5 }, { height: 99999 }]) {
      const session = fakeSession(deck([{ id: 'p1', ...bad }]), {});
      await expect(importDeck(rt, 'P', 'slide', { session })).rejects.toThrow('canvas size must be whole pixels');
    }
    expect(await rt.fs.readText('/work/P/social-studio-project.json')).toBe(before);
    expect(await exists(rt, '/work/P/pages/p2.html')).toBe(true);
  });

  it('writes pages through the editor sanitizer: no script, no handler, no external URL; the doctype stays', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><script>alert(1)</script></head><body style="margin:0">' +
      '<div class="slide" data-popost-page="p1" onclick="x()"><img src="https://evil.example/a.png" onerror="y()"><p>kept</p></div></body></html>';
    const session = fakeSession(deck([{ id: 'p1', width: 300, height: 400, html }]), {});
    await importDeck(rt, 'P', 'slide', { session });
    const written = await rt.fs.readText('/work/P/pages/p1.html');
    expect(written.startsWith('<!doctype html><html>')).toBe(true);
    expect(written).toContain('<p>kept</p>');
    for (const forbidden of ['<script', 'alert', 'onclick', 'onerror', 'evil.example']) expect(written).not.toContain(forbidden);
  });

  it('puts every file and the manifest back when the write fails half way', async () => {
    const rt = await newRuntime();
    await deckProject(rt);
    const filesBefore = { p1: await rt.fs.readText('/work/P/pages/p1.html'), p2: await rt.fs.readText('/work/P/pages/p2.html') };
    const manifestBefore = await rt.fs.readText('/work/P/social-studio-project.json');
    const rename = rt.fs.rename;
    rt.fs.rename = async (from, to) => {
      if (to.endsWith('social-studio-project.json')) throw new Error('disk full');
      return rename(from, to);
    };
    const session = fakeSession(deck([{ id: 'p1', width: 300, height: 400 }, { id: 'p2' }, { id: 'p-new000000001' }]), {});
    await expect(importDeck(rt, 'P', 'slide', { session })).rejects.toThrow('disk full');
    rt.fs.rename = rename;
    expect(await rt.fs.readText('/work/P/social-studio-project.json')).toBe(manifestBefore);
    expect(await rt.fs.readText('/work/P/pages/p1.html')).toBe(filesBefore.p1);
    expect(await rt.fs.readText('/work/P/pages/p2.html')).toBe(filesBefore.p2);
    expect(await exists(rt, '/work/P/pages/p-new000000001.html')).toBe(false);
  });
});
