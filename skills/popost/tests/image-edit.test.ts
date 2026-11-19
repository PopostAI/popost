/**
 * `popost image edit`: the geometry (crop, rotate, flip, resize, in that order) and the refusals that need no browser.
 * `image-edit-chrome.test.ts` draws real pixels.
 */
import { describe, expect, it } from 'vitest';
import { backgroundOf, formatOf, gridStep, parseCrop, planEdit } from '../src/images/edit-plan';
import { createTestRuntime, runCli } from '../src/testing/memory';
import { tinyPng } from './image-helpers';

describe('parseCrop', () => {
  it('takes pixels or percentages of the source', () => {
    expect(parseCrop('10,20,300,400', 1600, 900)).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    expect(parseCrop('50%,0%,50%,100%', 1600, 900)).toEqual({ x: 800, y: 0, width: 800, height: 900 });
    expect(parseCrop(' 25% , 10 , 100 , 50% ', 1000, 500)).toEqual({ x: 250, y: 10, width: 100, height: 250 });
  });

  it('pulls a percentage that rounds past the edge back in, and refuses a pixel box outside the source', () => {
    expect(parseCrop('33.3%,0%,66.7%,100%', 100, 3)).toEqual({ x: 33, y: 0, width: 67, height: 3 });
    expect(() => parseCrop('1500,0,200,100', 1600, 900)).toThrow(/reaches outside the source, which is 1600x900 px \(the box ends at 1700,100\)/);
    expect(() => parseCrop('0,0,0,10', 100, 100)).toThrow(/leaves nothing/);
    expect(() => parseCrop('0,0,10', 100, 100)).toThrow(/x,y,w,h/);
    expect(() => parseCrop('a,0,10,10', 100, 100)).toThrow(/--crop x is not a number/);
  });
});

describe('planEdit', () => {
  it('keeps the source as it is when nothing is asked', () => {
    expect(planEdit(640, 480, {})).toMatchObject({ crop: { x: 0, y: 0, width: 640, height: 480 }, rotate: 0, flip: null, width: 640, height: 480, steps: [] });
  });

  it('keeps the proportions with one side, and swaps the sides of a quarter turn before resizing', () => {
    expect(planEdit(1600, 900, { width: 800 })).toMatchObject({ width: 800, height: 450 });
    expect(planEdit(1600, 900, { height: 300 })).toMatchObject({ width: 533, height: 300 });
    expect(planEdit(1600, 900, { rotate: 90 })).toMatchObject({ width: 900, height: 1600 });
    expect(planEdit(1600, 900, { rotate: 270, width: 450 })).toMatchObject({ width: 450, height: 800 });
    expect(planEdit(200, 100, { scale: 3 })).toMatchObject({ width: 600, height: 300 });
  });

  it('fills the box with cover and shows the whole picture with contain', () => {
    const cover = planEdit(1600, 900, { width: 300, height: 300 });
    expect(cover).toMatchObject({ width: 300, height: 300 });
    expect(cover.draw.height).toBeCloseTo(300);
    expect(cover.draw.width).toBeCloseTo(533.33, 1);
    expect(cover.draw.x).toBeCloseTo(-116.67, 1);
    const contain = planEdit(1600, 900, { width: 300, height: 300, fit: 'contain' });
    expect(contain.draw.width).toBeCloseTo(300);
    expect(contain.draw.height).toBeCloseTo(168.75);
    expect(contain.draw.y).toBeCloseTo(65.625);
  });

  it('lists the steps in the order they run', () => {
    expect(planEdit(1600, 900, { width: 100, flip: 'h', rotate: 180, crop: '0,0,800,450' }).steps).toEqual(['crop 0,0,800,450', 'rotate 180', 'flip h', 'resize -> 100x56']);
  });

  it('refuses options that do not add up and results that are too large', () => {
    expect(() => planEdit(100, 100, { scale: 2, width: 50 })).toThrow(/--scale or --width/);
    expect(() => planEdit(100, 100, { fit: 'contain', width: 50 })).toThrow(/--fit only goes with both/);
    expect(() => planEdit(100, 100, { rotate: 45 })).toThrow(/90, 180 or 270/);
    expect(() => planEdit(100, 100, { width: 0 })).toThrow(/positive/);
    expect(() => planEdit(4000, 4000, { scale: 3 })).toThrow(/12000x12000 px; the limit is 8192 px a side/);
  });
});

describe('grid', () => {
  it('picks a round distance in source pixels', () => {
    expect(gridStep({ x: 0, y: 0, width: 360, height: 190 })).toBe(50);
    expect(gridStep({ x: 0, y: 0, width: 1600, height: 907 })).toBe(200);
    expect(gridStep({ x: 0, y: 0, width: 40, height: 40 })).toBe(5);
    expect(gridStep({ x: 0, y: 0, width: 4, height: 4 })).toBe(1);
  });

  it('places the lines of source coordinates in the enlarged result', () => {
    const plan = planEdit(1600, 900, { crop: '20,10,360,190', scale: 3, grid: true });
    expect(plan.grid?.step).toBe(50);
    expect(plan.grid?.xs.map((line) => [line.label, line.at])).toEqual([['50', 90], ['100', 240], ['150', 390], ['200', 540], ['250', 690], ['300', 840], ['350', 990]]);
    expect(plan.grid?.ys.map((line) => [line.label, line.at])).toEqual([['50', 120], ['100', 270], ['150', 420], ['200', 570]]);
    expect(plan.steps.at(-1)).toBe('grid every 50 source px');
    expect(planEdit(100, 100, {}).grid).toBeNull();
  });

  it('is refused where a line would not be a source coordinate', () => {
    expect(() => planEdit(100, 100, { grid: true, rotate: 90 })).toThrow(/--grid goes with --crop and --scale/);
    expect(() => planEdit(200, 100, { grid: true, width: 50, height: 50 })).toThrow(/--grid goes with/);
  });
});

describe('output format and ground', () => {
  it('reads the format from the extension', () => {
    expect([formatOf('a.png'), formatOf('a.JPG'), formatOf('b.jpeg'), formatOf('c.webp')]).toEqual(['png', 'jpeg', 'jpeg', 'webp']);
    expect(() => formatOf('a.gif')).toThrow(/\.png, \.jpg, \.jpeg or \.webp/);
  });

  it('keeps transparency except in a JPEG', () => {
    expect(backgroundOf('png', undefined)).toBeNull();
    expect(backgroundOf('jpeg', undefined)).toBe('#ffffff');
    expect(backgroundOf('jpeg', 'transparent')).toBe('#ffffff');
    expect(backgroundOf('webp', '#0af')).toBe('#0af');
    expect(() => backgroundOf('png', 'red')).toThrow(/hex colour/);
  });
});

describe('popost image edit refusals', () => {
  const setup = async () => {
    const rt = createTestRuntime({
      launchBrowser: () => {
        throw new Error('no browser is needed for a refusal');
      },
    });
    await rt.fs.writeFile(rt.path.resolve(rt.cwd, 'in.png'), tinyPng([1, 2, 3], 2));
    return rt;
  };
  const errorOf = (stdout: string): string => (JSON.parse(stdout) as { error: string }).error;

  it('refuses before a browser starts: bad extension, the source as --out, a missing file, a crop outside the header size', async () => {
    const rt = await setup();
    const run = (...args: string[]) => runCli(rt, ['image', 'edit', '--file', 'in.png', ...args]);
    const extension = await run('--out', 'out.gif');
    expect(extension.code).toBe(2);
    expect(errorOf(extension.stdout)).toMatch(/must end in \.png/);
    expect(errorOf((await run('--out', './in.png')).stdout)).toMatch(/is the source file/);
    expect(errorOf((await run('--out', 'out.png', '--crop', '0,0,5,5')).stdout)).toMatch(/which is 2x2 px/);
    expect(errorOf((await run('--out', 'out.png', '--quality', '0')).stdout)).toMatch(/1 to 100/);
    const missing = await runCli(rt, ['image', 'edit', '--file', 'nope.png', '--out', 'out.png']);
    expect(missing.code).toBe(2);
    expect(errorOf(missing.stdout)).toBe('file not found: nope.png');
    expect(await rt.fs.stat(rt.path.resolve(rt.cwd, 'out.png'))).toBeNull();
  });
});
