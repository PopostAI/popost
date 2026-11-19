/**
 * `popost image edit` with the installed Chrome: a four-colour picture goes in, and the pixels of the result say that the
 * crop, the turn, the mirror and the resize did what the plan says. Skipped when no Chrome / Chromium is found (set POPOST_CHROME).
 */
import { describe, expect, it } from 'vitest';
import { describePicture } from '../src/core/image-info';
import { findChromium, launchChromium } from '../src/render/browser';
import { createTestRuntime, runCli, type TestRuntime } from '../src/testing/memory';

const chrome = findChromium(process.env);

/** 200x100: red | green on top, blue | yellow below (each quadrant 100x50). */
const QUADRANTS =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<rect x="0" y="0" width="100" height="50" fill="#ff0000"/><rect x="100" y="0" width="100" height="50" fill="#00ff00"/>' +
  '<rect x="0" y="50" width="100" height="50" fill="#0000ff"/><rect x="100" y="50" width="100" height="50" fill="#ffff00"/></svg>';
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

const chromeRuntime = async (): Promise<TestRuntime> => {
  const rt = createTestRuntime({ launchBrowser: () => launchChromium(process.env) });
  await rt.fs.writeFile(rt.path.resolve(rt.cwd, 'q.svg'), QUADRANTS);
  return rt;
};

/** RGBA of the pixels at `points`, read back through Chrome's own decoder. */
const pixelsOf = async (bytes: Uint8Array, mime: string, points: readonly [number, number][]): Promise<number[][]> => {
  const browser = await launchChromium(process.env);
  try {
    const page = await browser.newPage();
    const url = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
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
        return ${JSON.stringify(points)}.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
      })()`,
    )) as number[][];
  } finally {
    await browser.close();
  }
};

const near = (actual: readonly number[], expected: readonly number[], tolerance = 40): boolean =>
  expected.every((value, index) => Math.abs(actual[index]! - value) <= tolerance);

const edit = async (rt: TestRuntime, out: string, ...options: string[]) => {
  const run = await runCli(rt, ['image', 'edit', '--file', 'q.svg', '--out', out, ...options]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const bytes = await rt.fs.readFile(rt.path.resolve(rt.cwd, out));
  return { result: JSON.parse(run.stdout) as Record<string, unknown>, bytes };
};

describe.skipIf(!chrome)('image edit with Chrome', () => {
  it('turns an SVG into a PNG of its own size and reports what it read', async () => {
    const rt = await chromeRuntime();
    const { result, bytes } = await edit(rt, 'out/plain.png');
    expect(result).toMatchObject({ ok: true, path: 'out/plain.png', format: 'png', width: 200, height: 100, steps: [], source: { file: 'q.svg', format: 'svg', width: 200, height: 100 } });
    expect(describePicture(bytes)).toMatchObject({ format: 'png', width: 200, height: 100 });
    const [a, b, c, d] = await pixelsOf(bytes, 'image/png', [[50, 25], [150, 25], [50, 75], [150, 75]]);
    expect([near(a!, RED), near(b!, GREEN), near(c!, BLUE), near(d!, YELLOW)]).toEqual([true, true, true, true]);
  });

  it('crops a region (percentages), then enlarges it', async () => {
    const rt = await chromeRuntime();
    const { result, bytes } = await edit(rt, 'zoom.png', '--crop', '50%,50%,50%,50%', '--scale', '3');
    expect(result).toMatchObject({ width: 300, height: 150, steps: ['crop 100,50,100,50', 'scale 3 -> 300x150'] });
    const [a, b] = await pixelsOf(bytes, 'image/png', [[5, 5], [295, 145]]);
    expect([near(a!, YELLOW), near(b!, YELLOW)]).toEqual([true, true]);
  });

  it('rotates clockwise, then mirrors', async () => {
    const rt = await chromeRuntime();
    const turned = await edit(rt, 'turned.png', '--rotate', '90');
    expect(turned.result).toMatchObject({ width: 100, height: 200 });
    // a quarter turn clockwise: the left column (red over blue) becomes the top row (blue | red)
    const [tl, tr, bl, br] = await pixelsOf(turned.bytes, 'image/png', [[25, 50], [75, 50], [25, 150], [75, 150]]);
    expect([near(tl!, BLUE), near(tr!, RED), near(bl!, YELLOW), near(br!, GREEN)]).toEqual([true, true, true, true]);
    const mirrored = await edit(rt, 'mirrored.png', '--flip', 'h');
    const [left, right] = await pixelsOf(mirrored.bytes, 'image/png', [[50, 25], [150, 25]]);
    expect([near(left!, GREEN), near(right!, RED)]).toEqual([true, true]);
  });

  it('fills a box with cover, and shows the whole picture on a transparent or coloured ground with contain', async () => {
    const rt = await chromeRuntime();
    const cover = await edit(rt, 'cover.png', '--width', '100', '--height', '100');
    // the centre 100x100 of the source: every quadrant keeps a 50x50 corner
    const corners = await pixelsOf(cover.bytes, 'image/png', [[10, 10], [90, 10], [10, 90], [90, 90]]);
    expect(corners.map((pixel, index) => near(pixel, [RED, GREEN, BLUE, YELLOW][index]!))).toEqual([true, true, true, true]);
    const contain = await edit(rt, 'contain.png', '--width', '100', '--height', '100', '--fit', 'contain');
    const [top, middle] = await pixelsOf(contain.bytes, 'image/png', [[50, 5], [25, 40]]);
    expect(top![3]).toBe(0);
    expect(near(middle!, RED)).toBe(true);
    const jpeg = await edit(rt, 'contain.jpg', '--width', '100', '--height', '100', '--fit', 'contain', '--background', '#000000');
    expect(describePicture(jpeg.bytes)).toMatchObject({ format: 'jpeg', width: 100, height: 100 });
    const [ground] = await pixelsOf(jpeg.bytes, 'image/jpeg', [[50, 5]]);
    expect(near(ground!, [0, 0, 0])).toBe(true);
  });

  it('draws grid lines at the source coordinates and says the picture is for looking', async () => {
    const rt = await chromeRuntime();
    const { result, bytes } = await edit(rt, 'grid.png', '--crop', '0,0,100,50', '--scale', '4', '--grid');
    expect(result).toMatchObject({ width: 400, height: 200, grid: { step: 20, unit: 'source px' } });
    // source x=40 is at 160 in the result: a magenta line on the red quadrant; between two lines the red is untouched
    const [onLine, between] = await pixelsOf(bytes, 'image/png', [[160, 150], [200, 150]]);
    expect(near(onLine!, [230, 0, 120], 60)).toBe(true);
    expect(near(between!, RED)).toBe(true);
  });

  it('writes WebP and leaves the source untouched; a crop outside the decoded picture writes nothing', async () => {
    const rt = await chromeRuntime();
    const webp = await edit(rt, 'small.webp', '--scale', '0.5');
    expect(describePicture(webp.bytes)).toMatchObject({ format: 'webp', width: 100, height: 50 });
    expect(new TextDecoder().decode(await rt.fs.readFile(rt.path.resolve(rt.cwd, 'q.svg')))).toBe(QUADRANTS);
    const outside = await runCli(rt, ['image', 'edit', '--file', 'q.svg', '--out', 'no.png', '--crop', '150,0,100,100']);
    expect(outside.code).toBe(2);
    expect((JSON.parse(outside.stdout) as { error: string }).error).toMatch(/reaches outside the source, which is 200x100 px/);
    expect(await rt.fs.stat(rt.path.resolve(rt.cwd, 'no.png'))).toBeNull();
  });
});
