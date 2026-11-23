/**
 * The caption band in a capture plan: a zoom ends with its element above the band when the camera can do it, says so
 * when it cannot, and a highlight under the band is noted. The geometry alone (zoomPlan), then recordings of pages
 * written here, through the library and through popost video capture --caption-band.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { capturePage } from '../../src/video/capture/index';
import { zoomPlan } from '../../src/video/capture/steps';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();
const VIEW = { width: 320, height: 200 };
const BOX = { x: 110, y: 130, width: 100, height: 60 };

describe('zoomPlan with a caption band', () => {
  it('without a band, centres the box in the window as before', () => {
    const p = zoomPlan(BOX, { scrollX: 0, scrollY: 0, maxScroll: 400 }, VIEW, 0.7);
    expect(p.camera.s).toBeCloseTo(2.24, 2);
    // The box's middle (160 px down the page) is seen in the middle of the window.
    expect(p.camera.s * (160 - p.scrollY - p.camera.y)).toBeCloseTo(100, 1);
    expect(p.under).toBeUndefined();
  });

  it('with a band, fills the room above it and centres the box there', () => {
    const p = zoomPlan(BOX, { scrollX: 0, scrollY: 0, maxScroll: 400 }, VIEW, 0.7, 150);
    expect(p.camera.s).toBeCloseTo(1.75, 2);
    expect(p.camera.s * (160 - p.scrollY - p.camera.y)).toBeCloseTo(75, 1);
    expect(p.camera.s * (190 - p.scrollY - p.camera.y)).toBeLessThanOrEqual(150);
    expect(p.under).toBeUndefined();
  });

  it('says by how much the box stays under the band when the page cannot scroll it higher', () => {
    const p = zoomPlan(BOX, { scrollX: 0, scrollY: 0, maxScroll: 0 }, VIEW, 0.7, 150);
    expect(p.under).toBeGreaterThan(20);
  });
});

describe.skipIf(!ready)('capture with a caption band', () => {
  let dir = '';
  const page = (height: number): string => '<!doctype html><html><body style="margin:0;background:#ffffff">' +
    '<div style="height:' + height + 'px"></div>' +
    '<div id="top" style="position:absolute;left:110px;top:20px;width:100px;height:40px;background:#2040c0"></div>' +
    '<div id="target" style="position:absolute;left:110px;top:130px;width:100px;height:60px;background:#00c040"></div></body></html>';
  const url = (name: string): string => pathToFileURL(join(dir, name)).href;
  /** The RGB of a pixel of the last frame of a recording. */
  const last = async (file: string, frames: number, x: number, y: number): Promise<number[]> => {
    const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-vf', 'select=eq(n\\,' + (frames - 1) + '),crop=2:2:' + x + ':' + y + ',scale=1:1:flags=area,format=rgb24', '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
    return [...r.stdout.subarray(0, 3)];
  };
  const green = (p: number[]): boolean => (p[1] ?? 0) > 150 && (p[0] ?? 255) < 90;
  const zoom = [{ zoom: { to: '#target', frames: 4, fill: 0.7 } }, { hold: 2 }];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'popost-video-band-'));
    await writeFile(join(dir, 'long.html'), page(600));
    await writeFile(join(dir, 'short.html'), page(200));
    await writeFile(join(dir, 'plan.json'), JSON.stringify(zoom));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('ends a zoom with its element above the band, where without the band it reaches under it', async () => {
    const banded = await capturePage(rt, { url: url('long.html'), out: join(dir, 'banded.mp4'), ...VIEW, fps: 30, settleMs: 100, steps: zoom, captionBand: 0.75 });
    expect(banded.notes.filter((n) => n.includes('caption band'))).toEqual([]);
    expect(green(await last(join(dir, 'banded.mp4'), banded.frames, 160, 100))).toBe(true);
    expect(green(await last(join(dir, 'banded.mp4'), banded.frames, 160, 160))).toBe(false);
    const plain = await capturePage(rt, { url: url('long.html'), out: join(dir, 'plain.mp4'), ...VIEW, fps: 30, settleMs: 100, steps: zoom });
    expect(green(await last(join(dir, 'plain.mp4'), plain.frames, 160, 160))).toBe(true);
  });

  it('says when the camera cannot put the element above the band, and when a highlight lies under it', async () => {
    const r = await capturePage(rt, { url: url('short.html'), out: join(dir, 'short.mp4'), ...VIEW, fps: 30, settleMs: 100, captionBand: 0.75,
      steps: [...zoom, { zoom: { to: 'page', frames: 3 } }, { highlight: { to: '#target', frames: 3 } }, { clear: 2 }, { highlight: { to: '#top', frames: 3 } }] });
    const notes = r.notes.filter((n) => n.includes('caption band'));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^steps\[0\]: "#target" still reaches \d+ px under the top of the caption band \(75% of the height\) after the zoom: it is at the bottom of the page or taller than the room above the band; /);
    expect(notes[1]).toBe('steps[3]: the highlight of "#target" lies under the caption band: its box reaches 98% of the height and the band starts at 75%, so the captions will cover it; scroll or zoom so that it sits higher.');
  });

  it('takes the band from popost video capture --caption-band, in pixels of the video or as a fraction', async () => {
    expect((await runCli(rt, ['video', 'capture', url('short.html'), '--size', '320x200', '--plan', join(dir, 'plan.json'), '--caption-band', '150', '--out', join(dir, 'cli.mp4')])).code).toBe(0);
    expect((rt.json() as { notes: string[] }).notes.some((n) => n.includes('under the top of the caption band (75% of the height)'))).toBe(true);
    expect((await runCli(rt, ['video', 'capture', url('short.html'), '--size', '320x200', '--plan', join(dir, 'plan.json'), '--caption-band', '1.5', '--out', join(dir, 'cli.mp4')])).code).toBe(0);
    expect((await runCli(rt, ['video', 'capture', url('long.html'), '--size', '320x200', '--plan', join(dir, 'plan.json'), '--caption-band', '0', '--out', join(dir, 'cli.mp4')])).code).toBe(2);
    expect(String(rt.json().error)).toContain('the caption band');
  });
});
