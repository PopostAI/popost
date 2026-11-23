import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { findChromium } from '../../src/render/browser';
import { createDiskRuntime } from '../../src/testing/disk';
import { startPreview } from '../../src/video/preview/index';
import { serverProcesses } from './make-fixtures';

const rt = await createDiskRuntime({ processes: serverProcesses });
const chrome = findChromium(process.env) ?? undefined;
afterAll(() => rt.cleanup());

describe.skipIf(!chrome)('editable scene content in Studio (Chrome)', () => {
  it('edits a scene slot, keeps it after reload, and undoes the saved change', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'preview-scene-edit-'));
    await writeFile(path.join(dir, 'scene.html'), '<!doctype html><html><head><style>html,body{margin:0;width:320px;height:200px;overflow:hidden}</style></head><body><h1 data-slot="title">Original</h1></body></html>');
    await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 320, height: 200, fps: 30 }, materials: [], segments: [{ id: 'scene', frames: 30, base: { scene: 'scene.html', slots: { title: 'Before' } } }], tracks: [] }));
    const preview = await startPreview(rt, { projectDir: dir, edit: true });
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
      await page.goto(preview.url);
      await page.waitForSelector('body[data-ready="1"]');
      await page.locator('#lane-segments .seg').first().click();
      const field = page.locator('textarea[data-path="segments[0].base.slots.title"]');
      await expect.poll(() => field.inputValue()).toBe('Before');
      await field.fill('After');
      await field.press('Tab');
      const title = async () => (JSON.parse(await readFile(path.join(dir, 'video.json'), 'utf8')) as { segments: { base: { slots: { title: string } } }[] }).segments[0]?.base.slots.title;
      await expect.poll(title).toBe('After');
      await page.reload();
      await expect.poll(() => field.inputValue()).toBe('After');
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#page')?.contentDocument?.querySelector<HTMLIFrameElement>('iframe')?.contentDocument?.querySelector('[data-slot="title"]')?.textContent === 'After');
      const undone = await fetch(preview.url + 'api/undo', { method: 'POST' });
      expect(undone.status).toBe(200);
      await expect.poll(title).toBe('Before');
      expect(await readFile(path.join(dir, 'scene.html'), 'utf8')).toContain('Original');
    } finally {
      await browser.close();
      await preview.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
