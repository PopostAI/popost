/**
 * `sheet`: argument handling, which pictures go on the sheet and under which labels, and the errors that say what to run
 * first. The browser is a stub that records the page it is given, so none of this needs Chrome (`sheet-chrome.test.ts` does).
 */
import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { pageFingerprint, RENDER_SIGNATURE } from '../src/core/fingerprint';
import type { Project } from '../src/core/project';
import { sha256 } from '../src/core/util';
import { receiptPath } from '../src/render/png';
import { createTestRuntime, runCli, type TestRuntime } from '../src/testing/memory';
import { newProject, newProjectWithPages, newRuntime, pageHtml } from './workflow-helpers';

/** Just enough PNG for the header checks: signature, IHDR length / type, width, height. */
const fakePng = (width: number, height: number): Uint8Array => {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

interface Shot {
  html: string;
  viewport: { width: number; height: number };
  screenshot: Record<string, unknown>;
}

interface Fixture {
  rt: TestRuntime;
  shots: Shot[];
  launches: { count: number };
}

/** A runtime whose browser only records the page and the screenshot options, and answers "no broken image". */
const setup = async (): Promise<Fixture> => {
  const shots: Shot[] = [];
  const launches = { count: 0 };
  const base = await newRuntime();
  const rt = createTestRuntime({
    fs: base.fs,
    launchBrowser: async () => {
      launches.count++;
      const shot: Shot = { html: '', viewport: { width: 0, height: 0 }, screenshot: {} };
      const page = {
        setViewportSize: async (size: Shot['viewport']) => void (shot.viewport = size),
        setContent: async (html: string) => void (shot.html = html),
        evaluate: async () => false,
        screenshot: async (options: Shot['screenshot']) => {
          shot.screenshot = options;
          shots.push(shot);
          return JPEG;
        },
      };
      const context = { route: async () => undefined, newPage: async () => page, close: async () => undefined };
      return { newContext: async () => context, close: async () => undefined } as unknown as Browser;
    },
  });
  return { rt, shots, launches };
};

/** Give page `pid` a PNG and the receipt that makes it the current render. */
const renderPage = async (rt: TestRuntime, project: Project, pid: string): Promise<void> => {
  const png = fakePng(1080, 1440);
  const path = rt.path.join(project.exportsDir, `${pid}.png`);
  await rt.fs.writeFile(path, png);
  await rt.fs.writeFile(
    receiptPath(project, path),
    JSON.stringify({ fingerprint: await pageFingerprint(project, pid), pngHash: sha256(png), renderer: RENDER_SIGNATURE }),
  );
};

/** A project of `count` rendered pages. */
const renderedProject = async (rt: TestRuntime, count: number): Promise<Project> => {
  const project = await newProjectWithPages(rt, count, 'P');
  for (let i = 1; i <= count; i++) {
    await project.writePageHtml(`p${i}`, pageHtml(`page ${i}`));
    await renderPage(rt, project, `p${i}`);
  }
  return project;
};

/** The cells of the page handed to the browser: label, column x and row y. */
const cells = (html: string): { label: string; x: number; y: number }[] =>
  [...html.matchAll(/<div class="t" style="left:(\d+)px;top:(\d+)px;[^"]*"><div class="bar"[^>]*>([^<]*)<\/div>/g)].map(
    (match) => ({ x: Number(match[1]), y: Number(match[2]), label: match[3]! }),
  );

describe('sheet: arguments', () => {
  it('shows up in the usage and answers --help', async () => {
    const { rt } = await setup();
    expect((await runCli(rt, ['--help'])).stdout).toContain('sheet');
    const help = await runCli(rt, ['sheet', '--help']);
    expect(help.code).toBe(0);
    for (const flag of ['--dir', '--page', '--compare', '--files', '--labels', '--out']) expect(help.stdout).toContain(flag);
  });

  it.each([
    [[], 'give --dir P'],
    [['--dir', 'P', '--files', 'a.png', '--out', 'x.jpg'], 'not both'],
    [['--files', 'a.png'], '--files needs --out'],
    [['--files', 'a.png', '--out', 'x.png'], 'must end in .jpg'],
    [['--files', 'a.png', 'b.png', '--labels', 'one', '--out', 'x.jpg'], '--labels has 1 labels for 2 files'],
    [['--files', 'a.png', '--compare', '--out', 'x.jpg'], 'only go with --dir'],
    [['--files', 'a.png', '--page', 'p1', '--out', 'x.jpg'], 'only go with --dir'],
    [['--dir', 'P', '--labels', 'a'], '--labels only goes with --files'],
    [['--dir', 'P', '--out', 'sheet.png'], 'must end in .jpg'],
  ])('rejects %j', async (argv, message) => {
    const { rt, launches } = await setup();
    await renderedProject(rt, 1);
    const result = await runCli(rt, ['sheet', ...argv]);
    expect(result.code).toBe(2);
    expect(String(rt.json().error)).toContain(message);
    expect(launches.count).toBe(0);
  });

  it('reports an unknown flag as a usage error and a directory that is not a project as a crash', async () => {
    const { rt } = await setup();
    const usage = await runCli(rt, ['sheet', '--dir', 'P', '--bogus']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('unrecognized arguments: --bogus');
    const missing = await runCli(rt, ['sheet', '--dir', 'nowhere']);
    expect(missing.code).toBe(1);
    expect(String(rt.json().error)).toContain('not a v2 project');
  });
});

describe('sheet --dir: the rendered pages', () => {
  it('draws every page under its id and writes exports/sheet.jpg', async () => {
    const { rt, shots } = await setup();
    await renderedProject(rt, 3);
    const result = await runCli(rt, ['sheet', '--dir', 'P']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const json = rt.json();
    expect(json).toMatchObject({ ok: true, path: '/work/P/exports/sheet.jpg', bytes: JPEG.byteLength });
    expect(json.tiles).toEqual([
      { label: 'p1', source: 'exports/p1.png' },
      { label: 'p2', source: 'exports/p2.png' },
      { label: 'p3', source: 'exports/p3.png' },
    ]);
    expect(await rt.fs.readFile('/work/P/exports/sheet.jpg')).toEqual(JPEG);
    expect(shots).toHaveLength(1);
    expect(shots[0]!.viewport).toEqual({ width: json.width, height: json.height });
    expect(shots[0]!.screenshot).toMatchObject({ type: 'jpeg', quality: 80 });
    expect(cells(shots[0]!.html).map((cell) => cell.label)).toEqual(['p1', 'p2', 'p3']);
    expect(Number(json.width)).toBeLessThanOrEqual(2048);
  });

  it('embeds each picture as a data: URL and nothing else', async () => {
    const { rt, shots } = await setup();
    await renderedProject(rt, 2);
    await runCli(rt, ['sheet', '--dir', 'P']);
    const sources = [...shots[0]!.html.matchAll(/src="([^"]*)"/g)].map((match) => match[1]!);
    expect(sources).toHaveLength(2);
    for (const source of sources) expect(source).toMatch(/^data:image\/png;base64,/);
    expect(shots[0]!.html).not.toContain('<script');
  });

  it('writes to --out as the user wrote it, and shows only the pages asked for, in page order', async () => {
    const { rt, shots } = await setup();
    await renderedProject(rt, 4);
    const result = await runCli(rt, ['sheet', '--dir', 'P', '--page', 'p4, p2', '--out', 'out/s.jpg']);
    expect(result.code).toBe(0);
    expect(rt.json().path).toBe('out/s.jpg');
    expect((rt.json().tiles as { label: string }[]).map((tile) => tile.label)).toEqual(['p2', 'p4']);
    expect(cells(shots[0]!.html).map((cell) => cell.label)).toEqual(['p2', 'p4']);
    expect(await rt.fs.stat('/work/out/s.jpg')).not.toBeNull();
  });

  it('says which pages have no current render and what to run, without starting a browser', async () => {
    const { rt, launches } = await setup();
    const project = await renderedProject(rt, 3);
    await rt.fs.rm('/work/P/exports/p3.png');
    await project.writePageHtml('p2', pageHtml('edited after the render'));
    const result = await runCli(rt, ['sheet', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(rt.json().error).toBe(
      'no current render for p2 (changed since it was rendered), p3 (not rendered); run popost render --dir P --page all first',
    );
    expect(launches.count).toBe(0);
  });

  it('names the page in the render command when only one page is wanted', async () => {
    const { rt } = await setup();
    const project = await renderedProject(rt, 2);
    await project.writePageHtml('p2', pageHtml('edited'));
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--page', 'p2'])).code).toBe(2);
    expect(rt.json().error).toContain('run popost render --dir P --page p2 first');
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--page', 'p1'])).code).toBe(0);
  });

  it('refuses a render whose receipt is missing', async () => {
    const { rt } = await setup();
    await renderedProject(rt, 1);
    await rt.fs.rm('/work/P/exports/p1.render.json');
    expect((await runCli(rt, ['sheet', '--dir', 'P'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('changed since it was rendered');
  });

  it('refuses an unknown page and lists the ones there are', async () => {
    const { rt, launches } = await setup();
    await renderedProject(rt, 2);
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--page', 'p1,p9'])).code).toBe(2);
    expect(rt.json().error).toBe('unknown page: p9 (the project has p1, p2)');
    expect(launches.count).toBe(0);
  });
});

describe('sheet --dir --compare: references above the pages', () => {
  const addReference = async (rt: TestRuntime, project: Project, width: number) => {
    await rt.fs.writeFile(`/work/ref${width}.png`, fakePng(width, 1000));
    await project.importReference(`ref${width}.png`, 'layout');
  };

  it('puts the layout references (ref 1, ref 2…) in row 1 and the pages in row 2, when there are more pages', async () => {
    const { rt, shots } = await setup();
    const project = await renderedProject(rt, 4);
    await addReference(rt, project, 600);
    await addReference(rt, project, 700);
    await rt.fs.writeFile('/work/style.png', fakePng(500, 500));
    await project.importReference('style.png', 'style'); // another role: not a layout reference
    const result = await runCli(rt, ['sheet', '--dir', 'P', '--compare']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const tiles = rt.json().tiles as { label: string; source: string }[];
    expect(tiles.map((tile) => tile.label)).toEqual(['ref 1', 'ref 2', 'p1', 'p2', 'p3', 'p4']);
    expect(tiles[0]!.source).toMatch(/^reference\/[0-9a-f]{16}\.png$/);
    expect(tiles[2]!.source).toBe('exports/p1.png');
    const drawn = cells(shots[0]!.html);
    const [ref1, ref2, p1, p2, p3, p4] = drawn;
    expect(ref1!.y).toBe(ref2!.y);
    expect(p1!.y).toBeGreaterThan(ref1!.y);
    expect([p1!.y, p2!.y, p3!.y, p4!.y]).toEqual([p1!.y, p1!.y, p1!.y, p1!.y]);
    expect([ref1!.x, ref2!.x]).toEqual([p1!.x, p2!.x]); // reference N is above page N
    expect(Number(rt.json().width)).toBeLessThanOrEqual(2048);
  });

  it('works when there are more references than pages', async () => {
    const { rt, shots } = await setup();
    const project = await renderedProject(rt, 1);
    for (const width of [600, 700, 800]) await addReference(rt, project, width);
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--compare'])).code).toBe(0);
    expect(cells(shots[0]!.html).map((cell) => cell.label)).toEqual(['ref 1', 'ref 2', 'ref 3', 'p1']);
  });

  it('keeps the page filter for the pages and all the references', async () => {
    const { rt } = await setup();
    const project = await renderedProject(rt, 3);
    await addReference(rt, project, 600);
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--compare', '--page', 'p3'])).code).toBe(0);
    expect((rt.json().tiles as { label: string }[]).map((tile) => tile.label)).toEqual(['ref 1', 'p3']);
  });

  it('says so when there is no layout reference, and when its file is gone', async () => {
    const { rt, launches } = await setup();
    const project = await renderedProject(rt, 1);
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--compare'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('no layout references');
    expect(String(rt.json().error)).toContain('popost reference --dir P --file');
    await addReference(rt, project, 600);
    await rt.fs.rm(`/work/P/${String(project.manifest.sources[0]!.path)}`);
    expect((await runCli(rt, ['sheet', '--dir', 'P', '--compare'])).code).toBe(2);
    expect(String(rt.json().error)).toMatch(/^reference file is missing: reference\//);
    expect(launches.count).toBe(0);
  });
});

describe('sheet --files: any pictures', () => {
  const addFiles = async (rt: TestRuntime, names: readonly string[]) => {
    for (const [index, name] of names.entries()) await rt.fs.writeFile(`/work/${name}`, fakePng(400 + index, 300));
  };

  it('labels the pictures with their file names, and reports where each came from', async () => {
    const { rt, shots } = await setup();
    await addFiles(rt, ['assets/hero.png', 'cutout.png']);
    const result = await runCli(rt, ['sheet', '--files', 'assets/hero.png', 'cutout.png', '--out', 'assets/sheet.jpg']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(rt.json()).toMatchObject({
      ok: true,
      path: 'assets/sheet.jpg',
      tiles: [
        { label: 'hero.png', source: 'assets/hero.png' },
        { label: 'cutout.png', source: 'cutout.png' },
      ],
    });
    expect(cells(shots[0]!.html).map((cell) => cell.label)).toEqual(['hero.png', 'cutout.png']);
    expect(await rt.fs.readFile('/work/assets/sheet.jpg')).toEqual(JPEG);
  });

  it('uses --labels, trimmed, and escapes them', async () => {
    const { rt, shots } = await setup();
    await addFiles(rt, ['a.png', 'b.png']);
    expect((await runCli(rt, ['sheet', '--files', 'a.png', 'b.png', '--labels', 'cover, <b>back</b>', '--out', 's.jpg'])).code).toBe(0);
    expect((rt.json().tiles as { label: string }[]).map((tile) => tile.label)).toEqual(['cover', '<b>back</b>']);
    expect(shots[0]!.html).toContain('&lt;b&gt;back&lt;/b&gt;');
    expect(shots[0]!.html).not.toContain('<b>back</b>');
  });

  it('shortens a long file name in the label bar', async () => {
    const { rt, shots } = await setup();
    const name = 'generated-hero-image-variant-three-final-version.png';
    await addFiles(rt, [name]);
    expect((await runCli(rt, ['sheet', '--files', name, '--out', 's.jpg'])).code).toBe(0);
    const [cell] = cells(shots[0]!.html);
    expect(cell!.label).toContain('…');
    expect(cell!.label.endsWith('.png')).toBe(true);
  });

  it('fails on a missing file, a directory and something that is not a picture, before any browser starts', async () => {
    const { rt, launches } = await setup();
    await rt.fs.writeFile('/work/notes.txt', 'not a picture');
    await rt.fs.mkdir('/work/folder');
    for (const [file, message] of [
      ['gone.png', 'file not found: gone.png'],
      ['folder', 'folder is a folder, not a file'],
      ['notes.txt', 'not a readable picture file: notes.txt'],
    ] as const) {
      expect((await runCli(rt, ['sheet', '--files', file, '--out', 's.jpg'])).code).toBe(2);
      expect(String(rt.json().error)).toContain(message);
    }
    expect(launches.count).toBe(0);
  });

  it('refuses more pictures than one sheet holds', async () => {
    const { rt, launches } = await setup();
    const names = Array.from({ length: 41 }, (_, i) => `f${i}.png`);
    await addFiles(rt, names);
    expect((await runCli(rt, ['sheet', '--files', ...names, '--out', 's.jpg'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('at most 40 pictures');
    expect(launches.count).toBe(0);
  });
});

describe('sheet: a browser that cannot start', () => {
  it('is reported as a failure of the command, not a crash', async () => {
    const rt = createTestRuntime({ fs: (await newRuntime()).fs });
    const project = await newProject(rt, 'P');
    await project.writePageHtml('p1', pageHtml());
    await renderPage(rt, project, 'p1');
    const result = await runCli(rt, ['sheet', '--dir', 'P']);
    expect(result.code).toBe(2);
    expect(String(rt.json().error)).toContain('no browser in this test');
  });
});
