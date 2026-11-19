/**
 * `popost sheet` with the installed Chrome: real renders go in, one JPEG of the planned size comes out, with the pictures
 * and the label bars where the layout puts them. Skipped when no Chrome / Chromium is found (set POPOST_CHROME).
 */
import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/core/image';
import { Project } from '../src/core/project';
import { findChromium, launchChromium } from '../src/render/browser';
import { layoutSheet, type SheetImage } from '../src/render/sheet-layout';
import { createTestRuntime, mountPackageFiles, runCli, type TestRuntime } from '../src/testing/memory';

const chrome = findChromium(process.env);

const chromeRuntime = async (): Promise<TestRuntime> => {
  const rt = createTestRuntime({ launchBrowser: () => launchChromium(process.env) });
  await mountPackageFiles(rt.fs, ['assets/project-starter', 'tests/fixtures']);
  return rt;
};

const COLORS = { p1: '#ff0000', p2: '#0000ff', p3: '#00ff00' } as const;

/** A project whose pages are one flat colour each, rendered with `render`. */
const renderedProject = async (rt: TestRuntime, pids: readonly (keyof typeof COLORS)[]): Promise<Project> => {
  const project = await Project.create(rt, 'P', 'sheet test', 'original', 300, 400);
  for (const pid of pids) {
    if (pid !== 'p1') await project.addPage(pid, pid, 300, 400);
    await project.writePageHtml(
      pid,
      '<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}' +
        `.post{width:300px;height:400px;background:${COLORS[pid]}}</style></head>` +
        '<body><div class="post"><p data-layer-id="t">x</p></div></body></html>',
    );
  }
  const render = await runCli(rt, ['render', '--dir', 'P', '--page', 'all']);
  expect(render.code, render.stdout + render.stderr).toBe(0);
  return project;
};

/** Colour of the pixel at (x, y) of a JPEG, read back through Chrome's own decoder. */
const pixelsOf = async (jpeg: Uint8Array, points: readonly [number, number][]): Promise<number[][]> => {
  const browser = await launchChromium(process.env);
  try {
    const page = await browser.newPage();
    const url = `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
    return (await page.evaluate(
      `(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(url)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return ${JSON.stringify(points)}.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3));
      })()`,
    )) as number[][];
  } finally {
    await browser.close();
  }
};

const near = (actual: readonly number[], expected: readonly number[], tolerance = 40): boolean =>
  expected.every((value, index) => Math.abs(actual[index]! - value) <= tolerance);

const picture = (label: string): SheetImage => ({ label, source: label, width: 300, height: 400 });

describe.skipIf(!chrome)('sheet with Chrome', () => {
  it('draws the rendered pages into one JPEG of the planned size, under dark label bars', async () => {
    const rt = await chromeRuntime();
    await renderedProject(rt, ['p1', 'p2']);
    const result = await runCli(rt, ['sheet', '--dir', 'P']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const json = rt.json();
    const layout = layoutSheet([[picture('p1'), picture('p2')]]);
    expect(json).toMatchObject({ ok: true, path: '/work/P/exports/sheet.jpg', width: layout.width, height: layout.height });
    const jpeg = await rt.fs.readFile('/work/P/exports/sheet.jpg');
    expect(jpeg.byteLength).toBe(json.bytes);
    expect(jpeg.byteLength).toBeGreaterThan(1000);
    expect(sniffImage(jpeg)).toMatchObject({ format: 'jpeg', width: layout.width, height: layout.height });
    expect(layout.width).toBeLessThanOrEqual(2048);

    const [first, second] = layout.tiles;
    const centre = (tile: NonNullable<typeof first>): [number, number] => [
      tile.x + Math.floor(layout.cell.width / 2),
      tile.y + layout.cell.barHeight + Math.floor(layout.cell.boxHeight / 2),
    ];
    const barCorner = (tile: NonNullable<typeof first>): [number, number] => [tile.x + layout.cell.width - 6, tile.y + 6];
    const [red, blue, bar, ground] = await pixelsOf(jpeg, [centre(first!), centre(second!), barCorner(first!), [2, 2]]);
    expect(near(red!, [255, 0, 0]), `first tile ${String(red)}`).toBe(true);
    expect(near(blue!, [0, 0, 255]), `second tile ${String(blue)}`).toBe(true);
    expect(near(bar!, [11, 12, 14], 25), `label bar ${String(bar)}`).toBe(true);
    expect(near(ground!, [36, 38, 42], 25), `sheet ground ${String(ground)}`).toBe(true);
  });

  it('draws --compare: a reference above each page, even when there are fewer references', async () => {
    const rt = await chromeRuntime();
    const project = await renderedProject(rt, ['p1', 'p2', 'p3']);
    await rt.fs.writeFile('/work/ref.png', await rt.fs.readFile('/work/P/exports/p3.png'));
    await project.importReference('ref.png', 'layout');
    const result = await runCli(rt, ['sheet', '--dir', 'P', '--compare', '--out', 'compare.jpg']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const json = rt.json();
    expect((json.tiles as { label: string }[]).map((tile) => tile.label)).toEqual(['ref 1', 'p1', 'p2', 'p3']);
    const layout = layoutSheet([[picture('ref 1')], [picture('p1'), picture('p2'), picture('p3')]]);
    expect(json).toMatchObject({ path: 'compare.jpg', width: layout.width, height: layout.height });
    const jpeg = await rt.fs.readFile('/work/compare.jpg');
    expect(sniffImage(jpeg)).toMatchObject({ format: 'jpeg', width: layout.width, height: layout.height });
    const centre = (index: number): [number, number] => {
      const tile = layout.tiles[index]!;
      return [tile.x + Math.floor(layout.cell.width / 2), tile.y + layout.cell.barHeight + Math.floor(layout.cell.boxHeight / 2)];
    };
    const [ref, one, two, three, emptyCell] = await pixelsOf(jpeg, [
      centre(0),
      centre(1),
      centre(2),
      centre(3),
      [layout.tiles[2]!.x + 100, layout.tiles[0]!.y + 100], // where reference 2 would be
    ]);
    expect(near(ref!, [0, 255, 0]), 'ref 1 is the green page').toBe(true);
    expect(near(one!, [255, 0, 0]), 'p1').toBe(true);
    expect(near(two!, [0, 0, 255]), 'p2').toBe(true);
    expect(near(three!, [0, 255, 0]), 'p3').toBe(true);
    expect(near(emptyCell!, [36, 38, 42], 25), 'no reference 2: the ground shows').toBe(true);
  });

  it('draws arbitrary pictures with --files, labelled as asked', async () => {
    const rt = await chromeRuntime();
    await renderedProject(rt, ['p1']);
    await rt.fs.writeFile('/work/red.png', await rt.fs.readFile('/work/P/exports/p1.png'));
    const result = await runCli(rt, ['sheet', '--files', 'red.png', 'red.png', 'red.png', '--labels', 'a,b,c', '--out', 'files.jpg']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const layout = layoutSheet([[picture('a'), picture('b'), picture('c')]]);
    expect(sniffImage(await rt.fs.readFile('/work/files.jpg'))).toMatchObject({ width: layout.width, height: layout.height });
    expect(rt.json().tiles).toEqual([
      { label: 'a', source: 'red.png' },
      { label: 'b', source: 'red.png' },
      { label: 'c', source: 'red.png' },
    ]);
  });

  it('refuses a file whose bytes look like a PNG but cannot be decoded', async () => {
    const rt = await chromeRuntime();
    const bytes = new Uint8Array(40);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10]);
    await rt.fs.writeFile('/work/broken.png', bytes);
    const result = await runCli(rt, ['sheet', '--files', 'broken.png', '--out', 's.jpg']);
    expect(result.code).toBe(2);
    expect(String(rt.json().error)).toContain('could not be decoded');
    expect(await rt.fs.stat('/work/s.jpg')).toBeNull();
  });
});
