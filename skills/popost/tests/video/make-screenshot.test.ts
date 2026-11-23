import type { Browser, CDPSession, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { captureScreenshot, createScreenshotSession } from '../../src/video/media/screenshot';
import { ffmpegReady } from './read-clips';

const ready = (await ffmpegReady()) && hasChrome();
const WIDTH = 180, HEIGHT = 960;

describe.skipIf(!ready)('screenshots of an emulated portrait viewport', () => {
  let rt: DiskRuntime;
  let browser: Browser;
  let cdp: CDPSession;
  let page: Page;

  beforeAll(async () => {
    rt = await createDiskRuntime({ env: { POPOST_CPUS: '1' } });
    browser = await rt.launchBrowser('frames');
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    page = await context.newPage();
    await page.setContent('<!doctype html><html><body style="margin:0;background:#00ff00">' +
      '<div style="width:180px;height:960px"></div></body></html>');
    cdp = await createScreenshotSession(page, { width: WIDTH, height: HEIGHT }, 1);
  });
  afterAll(async () => { await browser?.close(); await rt?.cleanup(); });

  it.each(['png', 'jpeg'] as const)('keeps every row and the bottom corners in %s', async (format) => {
    const shot = await captureScreenshot(cdp, { format, ...(format === 'jpeg' ? { quality: 95 } : {}),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 }, optimizeForSpeed: true });
    const decoded = await runFfmpegOk(rt, ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], Buffer.from(shot.data, 'base64'));
    expect(decoded.stdout.length).toBe(WIDTH * HEIGHT * 3);
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([WIDTH, HEIGHT]);
    for (let y = 0; y < HEIGHT; y++) {
      for (const x of [0, Math.floor(WIDTH / 2), WIDTH - 1]) {
        const pixel = [...decoded.stdout.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3)];
        const expected = [0, 255, 0];
        expect(pixel.every((value, channel) => Math.abs(value - (expected[channel] ?? 0)) <= 4), x + ',' + y + ': ' + pixel.join(',')).toBe(true);
      }
    }
  });
});
