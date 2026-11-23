import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { hasFfmpeg, probe, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { buildPage } from '../../src/video/compile/index';
import { openRenderer, renderFrame, renderVideo, type Renderer } from '../../src/video/render/index';
import { countPackets } from '../../src/video/render/verify';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const W = 180;
const H = 320;
const RED = [224, 16, 16];
const BLUE = [16, 48, 224];

/**
 * 60 frames: red (0..19), a 10-frame left wipe into blue (frames 15..24), an 8-frame slide into a picture with a
 * camera push (frames 36..43). A Chinese title pops in on frames 6..13; a bar slides in on frames 2..11.
 */
const project = (): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'pic', kind: 'image', file: 'assets/pic.png' }, { id: 'pop', kind: 'audio', file: 'assets/pop.wav' }],
  segments: [
    { id: 'a', frames: 20, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { color: '#1030e0' }, in: { transition: 'wipe', direction: 'left', frames: 10 } },
    { id: 'c', frames: 20, base: { material: 'pic', camera: { zoom: 0.2 } }, in: { transition: 'slide', direction: 'left', frames: 8 } },
  ],
  tracks: [
    { id: 'title', type: 'text', text: '你好，视频', style: 'headline', box: [0.05, 0.08, 0.9, 0.2], during: { segment: 'a', from: 6, to: 50 }, enter: { preset: 'pop' }, sound: 'pop' },
    { id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', radius: 0.3, box: [0.1, 0.7, 0.8, 0.08], during: { segment: 'a', from: 2 }, enter: { preset: 'slide', direction: 'left' } },
  ],
});

const rgb = async (png: Buffer): Promise<{ data: Buffer; width: number; height: number }> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], png);
  // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
  return { data: Buffer.from(r.stdout), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const pixel = (img: { data: Buffer; width: number }, x: number, y: number): number[] => {
  const i = (y * img.width + x) * 3;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
};
const near = (a: number[], b: number[], tol = 24): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

/** Pixels of the box [x0, y0, x1, y1) that are far from the colour c. */
const different = (img: { data: Buffer; width: number }, box: number[], c: number[]): number => {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box;
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!near(pixel(img, x, y), c, 60)) count++;
  return count;
};

describe.skipIf(!ready)('render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'make-render-'));
    await mkdir(path.join(dir, 'assets'));
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=' + W + 'x' + H + ':rate=1', '-frames:v', '1', path.join(dir, 'assets', 'pic.png')]);
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.2', path.join(dir, 'assets', 'pop.wav')]);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const frame = (n: number): Promise<Buffer> => {
    if (!renderer) throw new Error('renderer not open');
    return renderer.frame(n);
  };

  it('renders an MP4 with the asked frame count, size, rate and the sound', async () => {
    const out = path.join(dir, 'out.mp4');
    const res = await renderVideo(rt, { projectDir: dir, out });
    expect(res).toMatchObject({ frames: 60, width: W, height: H, fps: 30 });
    const p = await probe(rt, out);
    expect([p.width, p.height, p.fps, p.hasAudio]).toEqual([W, H, 30, true]);
    expect(p.frames || (await countPackets(rt, out))).toBe(60);
  });

  it('renders a range at a smaller scale, with no audio stream when the project has no audio', async () => {
    const quiet = path.join(dir, 'quiet');
    await mkdir(quiet);
    const p = project();
    await writeFile(path.join(quiet, 'video.json'), JSON.stringify({ ...p, materials: [], segments: p.segments.slice(0, 2), tracks: p.tracks.slice(1) }));
    const out = path.join(dir, 'half.mp4');
    const res = await renderVideo(rt, { projectDir: quiet, out, scale: 0.5, from: 5, to: 20 });
    expect(res).toMatchObject({ frames: 15, width: 90, height: 160, fps: 30 });
    expect((await probe(rt, out)).hasAudio).toBe(false);
    const png = path.join(dir, 'half.png');
    await renderFrame(rt, { projectDir: dir, frame: 20, out: png, scale: 0.5 });
    const img = await rgb(await readFile(png));
    expect([img.width, img.height]).toEqual([90, 160]);
  });

  it('draws frame n the same whether it follows frame n-1 or a jump from frame 0', async () => {
    // Inside the bar's slide and the title's pop (8, 11), the wipe (17, 20, 23), the slide (38, 41), the camera (50).
    for (const n of [8, 11, 17, 20, 23, 38, 41, 50]) {
      await frame(n - 1);
      const played = await frame(n);
      await frame(0);
      const jumped = await frame(n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
    expect((await frame(19)).equals(await frame(20))).toBe(false);
  });

  it('shows the old colour on the left and the new on the right in the middle of a left wipe', async () => {
    const img = await rgb(await frame(20));
    const y = Math.round(H * 0.9);
    expect(pixel(img, Math.round(W * 0.1), y), 'left').toSatisfy((c: number[]) => near(c, RED));
    expect(pixel(img, Math.round(W * 0.9), y), 'right').toSatisfy((c: number[]) => near(c, BLUE));
  });

  it('shows the title only from its start, and whole after its entrance', async () => {
    const box = [Math.round(W * 0.05), Math.round(H * 0.08), Math.round(W * 0.95), Math.round(H * 0.28)];
    expect(different(await rgb(await frame(5)), box, RED)).toBe(0);
    expect(different(await rgb(await frame(14)), box, RED)).toBeGreaterThan(300);
  });

  it('builds no page for a project with errors', async () => {
    const bad = path.join(dir, 'bad');
    await mkdir(bad);
    await writeFile(path.join(bad, 'video.json'), JSON.stringify({ ...project(), segments: [{ id: 'a', base: { color: '#000' } }] }));
    const built = await buildPage(rt, bad);
    expect(built.html).toBeUndefined();
    expect(built.problems.some((p) => p.at === 'segments[0].frames')).toBe(true);
  });
});
