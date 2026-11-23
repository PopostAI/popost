/**
 * A window on a moving decorative ground: an animated backdrop on every side, the same through the video, and the
 * content cutting inside it. The ground keeps no pixel still, so the constant-frame reading found nothing and the
 * reference was re-made full frame. The ground changes slowly and does not jump where the content cuts; the content
 * does: that is a frame with a moving ground. Full-frame cuts, and a still frame, are not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { findInset, findMovingInset, frameOf, insetSamples, insetText } from '../../src/video/describe/inset';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, sourceFrames } from './read-clips';

const ok = await ffmpegReady();
let rt: DiskRuntime;

const SOURCES = ['testsrc', 'mandelbrot', 'smptehdbars', 'testsrc2', 'rgbtestsrc'];
const FRAMES = 45;
/** 640x360, the content in [80, 40, 480, 280]: [0.125, 0.111, 0.75, 0.778] of the canvas. */
const BOX = [80, 40, 480, 280];

/** An abstract backdrop of three soft colour waves at 640x360, drifting a little every frame (t in seconds; speed 0: still). */
const backdrop = (t: number, speed: number): Uint8Array => {
  const rgb = new Uint8Array(640 * 360 * 3);
  for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
    const i = 3 * (y * 640 + x), s = speed * t;
    rgb[i] = 120 + 70 * Math.sin(2 * Math.PI * (x / 520 + 0.9 * s));
    rgb[i + 1] = 110 + 60 * Math.sin(2 * Math.PI * (y / 300 - 0.7 * s) + 1);
    rgb[i + 2] = 150 + 60 * Math.sin(2 * Math.PI * ((x + y) / 700 + 0.5 * s) + 2);
  }
  return rgb;
};

/** The content of shot k in the box, frame by frame, over a backdrop that moves on through the cuts. */
const composed = async (name: string, speed: number): Promise<string> => {
  const [bx, by, bw, bh] = BOX as [number, number, number, number];
  const shots = await Promise.all(SOURCES.map((s) => sourceFrames(rt, s, FRAMES, bw, bh)));
  const frames = shots.flatMap((pics, k) => pics.map((pic, j) => {
    const out = backdrop((k * FRAMES + j) / 30, speed);
    for (let y = 0; y < bh; y++) out.set(pic.subarray(3 * y * bw, 3 * (y + 1) * bw), 3 * ((by + y) * 640 + bx));
    return out;
  }));
  const out = rt.path.join(rt.dir, name + '.mp4');
  await encode(rt, frames, 640, 360, out, 30);
  return out;
};

/** Five shots of 45 frames: 'moving' or 'still' (the content in the box over the backdrop) or 'none' (the shots fill the frame). */
const clip = async (name: string, ground: 'moving' | 'still' | 'none'): Promise<string> => {
  if (ground !== 'none') return composed(name, ground === 'moving' ? 0.12 : 0);
  const out = rt.path.join(rt.dir, name + '.mp4');
  const inputs = SOURCES.flatMap((s) => ['-f', 'lavfi', '-i', s + '=s=640x360:r=30']);
  const cut = SOURCES.map((_s, k) => '[' + k + ':v]trim=end_frame=' + FRAMES + ',setpts=N/30/TB,format=yuv420p[c' + k + ']').join(';');
  const filter = cut + ';' + SOURCES.map((_s, k) => '[c' + k + ']').join('') + 'concat=n=' + SOURCES.length + ':v=1:a=0,format=yuv420p[out]';
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out]);
  return out;
};

describe.skipIf(!ok)('a window on a moving ground', () => {
  beforeAll(async () => { rt = await createDiskRuntime(); });
  afterAll(() => rt.cleanup());

  it('is a frame with a moving ground, the box where the content is', async () => {
    const video = await clip('moving', 'moving');
    const m = await measureVideo(rt, video);
    expect(m.boundaries.length).toBeGreaterThanOrEqual(3);
    const s = await insetSamples(rt, video);
    expect(findInset(s, m)).toBeUndefined();
    const inset = findMovingInset(s, m);
    expect(inset).toMatchObject({ kind: 'frame', moving: true });
    const [x, y, w, h] = inset?.pixels ?? [0, 0, 0, 0];
    for (const [got, want] of [[x, BOX[0]], [y, BOX[1]], [x + w, (BOX[0] ?? 0) + (BOX[2] ?? 0)], [y + h, (BOX[1] ?? 0) + (BOX[3] ?? 0)]] as const) expect(Math.abs(got - (want ?? 0))).toBeLessThanOrEqual(6);
    const text = insetText(inset!, m.shots.length);
    expect(text).toContain('Frame on a moving ground');
    expect(text).toContain('keeps its motion going across the cuts');
  }, 120_000);

  it('is read as moving when the ground moves slowly, where the constant reading finds only the sides', async () => {
    const video = await composed('slow', 0.02);
    const m = await measureVideo(rt, video);
    const s = await insetSamples(rt, video);
    // The constant reading does not find the box here: nothing, or a box of the wrong height (which of the two depends
    // on the encoder's output, so neither is asserted exactly).
    const constant = findInset(s, m);
    expect(constant === undefined || Math.abs((constant.pixels[3] ?? 0) - (BOX[3] ?? 0)) > 6).toBe(true);
    const inset = frameOf(s, m);
    expect(inset?.moving).toBe(true);
    expect(Math.abs((inset?.pixels[1] ?? 0) - (BOX[1] ?? 0))).toBeLessThanOrEqual(6);
    expect(Math.abs((inset?.pixels[3] ?? 0) - (BOX[3] ?? 0))).toBeLessThanOrEqual(6);
  }, 120_000);

  it('is nothing when the shots fill the frame, and a still frame is the constant reading\'s', async () => {
    const full = await clip('full', 'none');
    const mf = await measureVideo(rt, full);
    expect(findMovingInset(await insetSamples(rt, full), mf)).toBeUndefined();
    const still = await clip('still', 'still');
    const ms = await measureVideo(rt, still);
    const ss = await insetSamples(rt, still);
    expect(findInset(ss, ms)).toMatchObject({ kind: 'frame' });
    expect(findInset(ss, ms)?.moving).toBeUndefined();
    expect(findMovingInset(ss, ms)).toBeUndefined();
  }, 120_000);
});
