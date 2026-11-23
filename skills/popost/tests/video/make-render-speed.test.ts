import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openRenderer, pagesFor, renderVideo } from '../../src/video/render/index';
import { openSession } from '../../src/video/render/session';
import { projectDir } from './make-fixtures';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

/**
 * 60 frames at 180x320. Frames 0..19: a colour and a title that pops in on frames 4..11, then nothing moves.
 * Frames 20..39: a picture with a camera zoom, every frame differs. Frames 40..59: a colour entered by an 8-frame
 * fade (frames 36..43), then nothing moves.
 */
const project = (): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'pic', kind: 'image', file: 'assets/pic.png' }],
  segments: [
    { id: 'a', frames: 20, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { material: 'pic', camera: { zoom: 0.2 } } },
    { id: 'c', frames: 20, base: { color: '#1030e0' }, in: { transition: 'fade', frames: 8 } },
  ],
  tracks: [{ id: 'title', type: 'text', text: '你好', style: 'headline', box: [0.05, 0.08, 0.9, 0.2], during: { segment: 'a', from: 4 }, enter: { preset: 'pop', frames: 8 } }],
});

/** One checksum per decoded frame of a video. */
const frameSums = async (file: string): Promise<string[]> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', 'pipe:1']);
  return Buffer.from(r.stdout).toString('latin1').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()?.trim() ?? '');
};

describe('render: how many pages draw a job', () => {
  it('uses one page for a small job, more for a large one, and what is asked for within the limits', () => {
    const unset = { ...rt, env: { ...rt.env, POPOST_RENDER_PAGES: undefined } };
    expect(pagesFor(unset, { frames: 469, width: 270, height: 480 })).toBe(1);
    expect(pagesFor(unset, { frames: 600, width: 1280, height: 720 })).toBeGreaterThanOrEqual(1);
    expect(pagesFor(unset, { frames: 600, width: 1280, height: 720 })).toBeLessThanOrEqual(4);
    expect(pagesFor(unset, { frames: 60, width: 180, height: 320, pages: 3 })).toBe(3);
    expect(pagesFor(unset, { frames: 2, width: 180, height: 320, pages: 3 })).toBe(2);
    expect(pagesFor(unset, { frames: 600, width: 1280, height: 720, pages: 99 })).toBe(8);
    expect(pagesFor({ ...rt, env: { ...rt.env, POPOST_RENDER_PAGES: '2' } }, { frames: 60, width: 180, height: 320 })).toBe(2);
  });
});

describe.skipIf(!ready)('render: pages side by side and unchanged frames (Chrome + ffmpeg)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await projectDir('make-render-speed-', project());
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=1', '-frames:v', '1', path.join(dir, 'assets', 'pic.png')]);
    await mkdir(path.join(dir, 'out'));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('gives the same frames with one page and every screenshot taken, with reuse, and with three pages', async () => {
    const plain = await renderVideo(rt, { projectDir: dir, out: path.join(dir, 'out', 'plain.mp4'), pages: 1, reuse: false });
    const reused = await renderVideo(rt, { projectDir: dir, out: path.join(dir, 'out', 'reused.mp4'), pages: 1 });
    const three = await renderVideo(rt, { projectDir: dir, out: path.join(dir, 'out', 'three.mp4'), pages: 3 });
    expect([plain.pages, plain.reused]).toEqual([1, 0]);
    // Unchanged: frames 1..3 (before the title), 13..19 after its pop (frame 12 is the first settled one), 45..59 after the fade.
    expect(reused.reused).toBeGreaterThanOrEqual(20);
    expect(reused.reused).toBeLessThanOrEqual(27);
    expect(three.pages).toBe(3);
    expect(three.reused).toBeGreaterThan(0);
    const want = await frameSums(path.join(dir, 'out', 'plain.mp4'));
    expect(want).toHaveLength(60);
    expect(new Set(want).size).toBeGreaterThan(30);
    expect(await frameSums(path.join(dir, 'out', 'reused.mp4'))).toEqual(want);
    expect(await frameSums(path.join(dir, 'out', 'three.mp4'))).toEqual(want);
  });

  it('returns a screenshot again only when the picture is the same, whatever frame came before', async () => {
    const session = await openSession(rt, dir);
    const truth = await openRenderer(rt, dir);
    try {
      // 15 -> 16: nothing moves. 16 -> 25: another picture. 25 -> 16: back. 50 -> 55: nothing moves. 55 -> 16: differs.
      for (const n of [15, 16, 25, 16, 16, 50, 55, 16]) expect((await session.frame(n)).equals(await truth.frame(n)), 'frame ' + n).toBe(true);
      expect(session.counts()).toEqual({ taken: 5, reused: 3 });
    } finally {
      await session.close();
      await truth.close();
    }
  });

  it('writes nothing when a page cannot draw', async () => {
    const bad = await projectDir('make-render-speed-bad-', { ...project(), materials: [{ id: 'pic', kind: 'image', file: 'assets/missing.png' }] });
    try {
      await writeFile(path.join(bad, 'assets', 'note.txt'), 'no picture here');
      await expect(renderVideo(rt, { projectDir: bad, out: path.join(bad, 'out.mp4'), pages: 2 })).rejects.toThrow();
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});
