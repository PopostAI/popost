import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverProcesses } from './make-fixtures';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Project, ResolvedItem } from '../../src/video/types';
import { buildPage } from '../../src/video/compile/index';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import { findChromium } from '../../src/render/browser';
import { itemStateAt } from '../../src/video/timeline/frame';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(async () => { await rt.cleanup(); });
const chrome = findChromium(process.env) ?? undefined;

/** 40 frames: red (0..19), a 6-frame fade into blue (17..22), blue (20..39); a bar on frames 5..14, fading in on 5..8. */
const project = (first = 20): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [],
  segments: [
    { id: 'a', frames: first, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { color: '#1030e0' }, in: { transition: 'fade', frames: 6 } },
  ],
  tracks: [{ id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'a', from: 5, to: 15 }, enter: { preset: 'fade', frames: 4 } }],
});

interface StageStyles { bar?: string; barOpacity?: string; a?: string; b?: string }

/** Styles the runtime set in the page: the bar is found by its place (box 0.1, 0.7, 0.8 of 180x320), segments by data-segment. */
const stageStyles = (frame: Frame): Promise<StageStyles> =>
  frame.evaluate(() => {
    const bar = Array.from(document.querySelectorAll('div')).find((d) => d.style.top === '224px' && d.style.width === '144px');
    const seg = (id: string): string | undefined => document.querySelector<HTMLElement>('[data-segment="' + id + '"]')?.style.display;
    return { bar: bar?.style.display, barOpacity: bar?.style.opacity, a: seg('a'), b: seg('b') };
  });

describe.skipIf(!chrome)('preview shell (Chrome)', () => {
  let dir = '';
  let preview: PreviewServer | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let bar: ResolvedItem | undefined;
  const errors: string[] = [];

  const shown = async (): Promise<string> => (await page.locator('#frame-no').textContent()) ?? '';
  const applied = (n: number): Promise<unknown> => page.waitForSelector('body[data-applied="' + n + '"]', { timeout: 5000 });
  const stage = (): Frame => {
    const f = page.frames().find((x) => new URL(x.url()).pathname === '/page');
    if (!f) throw new Error('the stage iframe (/page) is not loaded');
    return f;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'preview-shell-'));
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    bar = (await buildPage(rt, dir)).resolved?.items[0];
    preview = await startPreview(rt, { projectDir: dir });
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(preview.url);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15_000 });
  });
  afterAll(async () => {
    await browser?.close();
    await preview?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('steps with the buttons and the keyboard, and plays', async () => {
    expect(await shown()).toBe('0');
    await page.click('#fwd1');
    await applied(1);
    expect(await shown()).toBe('1');
    await page.keyboard.press('Shift+ArrowRight');
    await applied(11);
    await page.keyboard.press('ArrowLeft');
    await applied(10);
    expect(await shown()).toBe('10');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => Number(document.getElementById('frame-no')?.textContent) > 12, undefined, { timeout: 3000 });
    await page.keyboard.press('Space');
    await page.keyboard.press('Home');
    await applied(0);
    expect(errors).toEqual([]);
  });

  it('shows the item inside its range, mid-entrance, and hides it outside (styles read from the page)', async () => {
    if (!bar) throw new Error('the bar did not resolve');
    const jump = async (n: number): Promise<void> => {
      await page.fill('#jump', String(n));
      await page.press('#jump', 'Enter');
      await applied(n);
      expect(await shown()).toBe(String(n));
    };
    await jump(6);
    const mid = await stageStyles(stage());
    expect(mid.bar).toBe('block');
    expect(Number(mid.barOpacity)).toBeCloseTo(itemStateAt(bar, 6)?.opacity ?? -1, 3);
    await jump(10);
    expect(await stageStyles(stage())).toEqual({ bar: 'block', barOpacity: '1', a: 'block', b: 'none' });
    await jump(30);
    expect(await stageStyles(stage())).toMatchObject({ bar: 'none', a: 'none', b: 'block' });
    await jump(4);
    expect((await stageStyles(stage())).bar).toBe('none');
  });

  it('seeks to the frame clicked in the segment lane and shows that segment in the panel', async () => {
    const track = await page.locator('#lane-segments .lane-track').boundingBox();
    if (!track) throw new Error('the segment lane is not visible');
    // The middle of frame 25 of 40.
    await page.mouse.click(track.x + (track.width * 25.5) / 40, track.y + 8);
    await applied(25);
    expect(await shown()).toBe('25');
    expect(await page.locator('#selection .json').textContent()).toContain('"id": "b"');
    await page.mouse.click(track.x + (track.width * 2.5) / 40, track.y + 8);
    await applied(2);
    expect(await page.locator('#selection .json').textContent()).toContain('"id": "a"');
  });

  it('switches the interface language', async () => {
    const label = page.locator('#lane-segments .lane-label');
    expect(await label.textContent()).toBe('Segments');
    await page.click('#lang-toggle');
    expect(await label.textContent()).toBe('分段');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
    expect(await page.locator('#lang-toggle').textContent()).toBe('English');
    await page.click('#lang-toggle');
    expect(await label.textContent()).toBe('Segments');
  });

  it('has no form and no edit controls: the read-only preview stays read-only', async () => {
    await page.click('#lane-item-bar .lane-label');
    await page.waitForSelector('#selection .json');
    expect(await page.locator('#edit-tools, #edit-form, #edit-status, #edit-layer, .grip, .seg-grip').count()).toBe(0);
    expect(await page.locator('#panel input, #panel textarea, #panel select').count()).toBe(0);
    expect(await page.locator('#status').textContent()).toMatch(/^read-only/);
    expect(await page.evaluate(() => document.body.classList.contains('editing'))).toBe(false);
  });

  it('fits a 1280x720 window without scrolling the page', async () => {
    const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    expect(size.w).toBeLessThanOrEqual(1280);
    expect(size.h).toBeLessThanOrEqual(720);
  });

  it('reloads when video.json changes and keeps the frame', async () => {
    await page.fill('#jump', '12');
    await page.press('#jump', 'Enter');
    await applied(12);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(24), null, 2));
    await page.waitForFunction(() => document.getElementById('project')?.textContent?.includes('44f'), undefined, { timeout: 5000 });
    await page.waitForSelector('body[data-ready="1"][data-applied="12"]', { timeout: 5000 });
    expect(await shown()).toBe('12');
    expect(await page.locator('#frame-no + span').textContent()).toBe(' / 43');
    expect(errors).toEqual([]);
  });
});
