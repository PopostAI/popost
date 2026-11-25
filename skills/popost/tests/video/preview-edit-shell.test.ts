import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverProcesses } from './make-fixtures';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Project, TextTrack } from '../../src/video/types';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import { findChromium } from '../../src/render/browser';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(async () => { await rt.cleanup(); });
const chrome = findChromium(process.env) ?? undefined;
const ffmpeg = await hasFfmpeg(rt);

/** 40 frames: red a (0..19), blue b (20..39); a title on 0..19, a bar on 5..14. */
const project = (): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [],
  segments: [
    { id: 'a', frames: 20, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { color: '#1030e0' }, in: { transition: 'fade', frames: 6 } },
  ],
  tracks: [
    { id: 'title', type: 'text', text: 'Hello', box: [0.1, 0.2, 0.8, 0.1], during: { segment: 'a', from: 0, to: 20 }, style: { size: 0.05 } },
    { id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'a', from: 5, to: 15 } },
  ],
});

describe.skipIf(!chrome)('preview shell in edit mode (Chrome)', () => {
  let dir = '';
  let preview: PreviewServer | undefined;
  let browser: Browser | undefined;
  let page: Page;
  const errors: string[] = [];

  const read = async (): Promise<Project> => JSON.parse(await readFile(path.join(dir, 'video.json'), 'utf8')) as Project;
  const stage = (): Frame => {
    const f = page.frames().find((x) => new URL(x.url()).pathname === '/page');
    if (!f) throw new Error('the stage iframe (/page) is not loaded');
    return f;
  };
  const jump = async (n: number): Promise<void> => {
    await page.fill('#jump', String(n));
    await page.press('#jump', 'Enter');
    await page.waitForSelector('body[data-ready="1"][data-applied="' + n + '"]', { timeout: 10_000 });
  };
  const box = async (selector: string): Promise<{ x: number; y: number; width: number; height: number }> => {
    // the lanes are drawn again after each save: wait for the element rather than measure the moment between
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 10_000 });
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(selector + ' is not visible');
    return b;
  };
  /** Presses at (x, y), moves by (dx, dy) in steps, and releases; mid runs while the button is held. */
  const drag = async (x: number, y: number, dx: number, dy: number, mid?: () => Promise<void>): Promise<void> => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    if (mid) await mid();
    await page.mouse.up();
  };
  const selectLane = async (id: string): Promise<void> => {
    await page.click('#lane-item-' + id + ' .lane-label');
    await page.waitForSelector('#edit-form');
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'preview-edit-shell-'));
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    preview = await startPreview(rt, { projectDir: dir, edit: true });
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(preview.url);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15_000 });
    await page.waitForSelector('#edit-tools');
  });
  afterAll(async () => {
    await browser?.close();
    await preview?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('types a new text in the panel and the page shows it at that frame', async () => {
    await jump(10);
    await selectLane('title');
    const area = page.locator('#edit-form textarea[data-path="tracks[0].text"]');
    expect(await area.inputValue()).toBe('Hello');
    await area.fill('Edited title');
    await area.press('Tab');
    await expect.poll(async () => ((await read()).tracks[0] as TextTrack).text, { timeout: 10_000 }).toBe('Edited title');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#page')?.contentDocument;
      return doc?.querySelector('[data-item="title"]')?.textContent === 'Edited title' && document.body.dataset.ready === '1' && document.body.dataset.applied === '10';
    }, undefined, { timeout: 10_000 });
    expect(await stage().evaluate(() => document.querySelector<HTMLElement>('[data-item="title"]')?.style.display)).toBe('flex');
    expect(await page.locator('#edit-status').textContent()).toBe('Saved: title.text');
  });

  it('shows the problem next to the field and in the status line when an edit is refused', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    const w = page.locator('#edit-form input[data-path="tracks[0].box[2]"]');
    await w.fill('0');
    await w.press('Tab');
    await page.waitForSelector('#edit-status.bad');
    expect(await page.locator('#edit-status').textContent()).toMatch(/^Not saved: tracks\[0\]\.box\[2\]: .*Fix: /);
    expect(await page.locator('#edit-form .fprob').first().textContent()).toMatch(/box\[2\]/);
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
  });

  it('drags an item on the stage and writes its new box, within a pixel', async () => {
    await jump(10);
    const frame = await box('#render-view .frame-box');
    const at = (fx: number, fy: number): [number, number] => [frame.x + frame.width * fx, frame.y + frame.height * fy];
    const [x, y] = at(0.5, 0.725);
    await page.mouse.click(x, y);
    await page.waitForSelector('#edit-form input[data-path="tracks[1].box[0]"]');
    await drag(x, y, 27, -36, async () => {
      expect(await page.locator('#drag-readout').textContent()).toMatch(/^x \d+ {2}y \d+ {2}144×16 px/);
    });
    const want = [0.1 * 180 + (27 * 180) / frame.width, 0.7 * 320 - (36 * 320) / frame.height];
    const boxOf = async (): Promise<number[]> => ((await read()).tracks[1] as { box: number[] }).box;
    await expect.poll(async () => (await boxOf())[0], { timeout: 10_000 }).not.toBe(0.1);
    const b = { box: await boxOf() };
    expect(Math.abs((b.box[0] ?? 0) * 180 - (want[0] ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((b.box[1] ?? 0) * 320 - (want[1] ?? 0))).toBeLessThanOrEqual(1);
    expect([b.box[2], b.box[3]]).toEqual([0.8, 0.05]);
    // The status line changes when the server's answer arrives, after video.json is written: wait for it.
    await expect.poll(() => page.locator('#edit-status').textContent(), { timeout: 10_000 }).toBe('Saved: bar.box');
  });

  it('drags a bar in the lanes to move the item in time', async () => {
    const track = await box('#lane-item-bar .lane-track');
    const bar = await box('#lane-item-bar .blk.item');
    const perFrame = track.width / 40;
    await drag(bar.x + bar.width / 2, bar.y + bar.height / 2, 6 * perFrame, 0, async () => {
      expect(await page.locator('#lane-readout').textContent()).toBe('On frames 11..20');
    });
    await expect.poll(async () => ((await read()).tracks[1] as { during: unknown }).during, { timeout: 10_000 }).toEqual({ segment: 'a', from: 11, to: 21 });
  });

  it('drags the border between two segments, and undoes it with the keyboard', async () => {
    const grip = await box('#lane-segments .seg-grip[data-border="0"]');
    const track = await box('#lane-segments .lane-track');
    const perFrame = track.width / 40;
    await drag(grip.x + grip.width / 2, grip.y + grip.height / 2, 5 * perFrame, 0, async () => {
      expect(await page.locator('#lane-readout').textContent()).toBe('a: 20 → 25 frames  · video 40 → 45 (+5)');
    });
    await expect.poll(async () => (await read()).segments[0]?.frames, { timeout: 10_000 }).toBe(25);
    await page.waitForFunction(() => document.getElementById('time')?.textContent?.includes('1.50'), undefined, { timeout: 10_000 });
    await page.locator('#frame-no').click();
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await read()).segments[0]?.frames, { timeout: 10_000 }).toBe(20);
    await expect.poll(() => page.locator('#edit-status').textContent(), { timeout: 10_000 }).toBe('Undone: a.frames');
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await read()).segments[0]?.frames, { timeout: 10_000 }).toBe(25);
  });

  it('adds a text at the playhead, deletes it with the Delete key and keeps the selection over a reload', async () => {
    await jump(22);
    await page.click('#edit-add-text');
    await expect.poll(async () => (await read()).tracks.map((t) => t.id), { timeout: 10_000 }).toEqual(['title', 'bar', 'text']);
    expect((await read()).tracks[2]).toMatchObject({ type: 'text', during: { segment: 'a', from: 22 } });
    await page.waitForSelector('#edit-form textarea[data-path="tracks[2].text"]');
    await page.reload();
    await page.waitForSelector('#edit-form textarea[data-path="tracks[2].text"]', { timeout: 15_000 });
    await page.locator('#frame-no').click();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await read()).tracks.map((t) => t.id), { timeout: 10_000 }).toEqual(['title', 'bar']);
    await page.waitForSelector('#edit-hint');
    await selectLane('bar');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#edit-hint');
  });

  it.skipIf(!ffmpeg)('renders from the page and plays the render in the reference player\'s place', async () => {
    await page.click('#studio-export-open');
    const dialog = page.getByRole('dialog');
    expect(await dialog.getByRole('tab').allTextContents()).toEqual(['Video', 'Draft']);
    await dialog.getByRole('button', { name: '480p', exact: true }).click();
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await page.waitForSelector('.studio-export-result a[download]', { timeout: 60_000 });
    expect(await page.locator('.studio-export-result').textContent()).toContain('480 ×');
    await page.locator('.studio-export-result').getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('#reference-video')?.getAttribute('src')?.startsWith('/project/.studio/exports/'), undefined, { timeout: 5000 });
    expect(await page.locator('#reference-view .caption').textContent()).toContain('Render');
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('reference-view')?.isConnected, undefined, { timeout: 5000 });
  });

  it('fits a 1280x720 window without scrolling the page, the panel scrolling inside', async () => {
    await selectLane('title');
    const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    expect(size.w).toBeLessThanOrEqual(1280);
    expect(size.h).toBeLessThanOrEqual(720);
    const header = await page.evaluate(() => { const el = document.querySelector('header'); return el ? el.scrollWidth <= el.clientWidth : false; });
    expect(header).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('panel') as HTMLElement).overflowY)).toBe('auto');
    expect(errors).toEqual([]);
  });
});
