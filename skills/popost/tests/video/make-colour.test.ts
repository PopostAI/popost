import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { renderVideo } from '../../src/video/render/index';

/**
 * Colours written in a project come back from a render. Tolerances, per channel, on flat areas, with the MP4 decoded
 * the way it is tagged (BT.709 matrix, limited range): flat colours 2; picture bases (an sRGB PNG, a JPEG) 3; video
 * bases (frames extracted from H.264 and encoded again) 3. Measured on the development machine: 1, 1 and 2.
 */
const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const W = 160;
const H = 80;
const COLOURS = ['#000000', '#ffffff', '#808080', '#ff0000', '#00ff00', '#0000ff', '#1a2b3c', '#e8c547'];
const ACC = 'flags=accurate_rnd+full_chroma_int';
const rgbOf = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A w x h RGB picture of the eight colours as 4 x 2 flat patches. */
const patches = (w: number, h: number): Buffer => {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(rgbOf(COLOURS[Math.floor((y * 2) / h) * 4 + Math.floor((x * 4) / w)] ?? '#000000'), (y * w + x) * 3);
  return raw;
};

/** The PNG with an sRGB chunk after IHDR (ffmpeg writes none), as a browser sees a picture saved from a design tool. */
const withSrgbChunk = (png: Buffer): Buffer => {
  const body = Buffer.from([0x73, 0x52, 0x47, 0x42, 0]); // "sRGB", rendering intent 0
  const chunk = Buffer.concat([Buffer.from([0, 0, 0, 1]), body, Buffer.alloc(4)]);
  chunk.writeUInt32BE(crc32(body), 9);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
};

const rawInput = (w: number, h: number): string[] => ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', w + 'x' + h, '-r', '30', '-i', 'pipe:0'];

/** H.264 with the BT.709 matrix, limited range; tagged as such or not tagged at all. */
const writeVideo = (file: string, w: number, h: number, tagged: boolean): Promise<unknown> =>
  runFfmpegOk(rt, ['-loglevel', 'error', '-y', ...rawInput(w, h), '-vf', 'loop=5:1:0,scale=out_color_matrix=bt709:out_range=tv:' + ACC + ',format=yuv420p', '-c:v', 'libx264', '-crf', '10',
    ...(tagged ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] : []), file], patches(w, h));

const segment = (id: string, base: object): Project['segments'][number] => ({ id, frames: 2, base } as Project['segments'][number]);

const project = (): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [
    { id: 'png', kind: 'image', file: 'assets/patches.png' },
    { id: 'jpg', kind: 'image', file: 'assets/patches.jpg' },
    { id: 'bt709', kind: 'video', file: 'assets/bt709.mp4' },
    { id: 'hd', kind: 'video', file: 'assets/untagged-hd.mp4' },
  ],
  segments: [
    ...COLOURS.map((c, i) => segment('flat' + i, { color: c })),
    segment('png', { material: 'png' }),
    segment('jpg', { material: 'jpg' }),
    segment('bt709', { material: 'bt709' }),
    segment('hd', { material: 'hd' }),
  ],
  tracks: [],
});

/** Mean colour of a box of frame f (x0, y0, x1, y1 exclusive), rounded. */
const mean = (rgb: Buffer, f: number, box: [number, number, number, number]): number[] => {
  const [x0, y0, x1, y1] = box;
  const sum = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (rgb[f * W * H * 3 + (y * W + x) * 3 + c] ?? 0);
  return sum.map((s) => Math.round(s / ((x1 - x0) * (y1 - y0))));
};

/** Worst channel error of each patch (its middle half, away from edges) of the picture on frame f. */
const patchErrors = (rgb: Buffer, f: number): { want: string; got: string; err: number }[] =>
  COLOURS.map((c, i) => {
    const px = (i % 4) * (W / 4);
    const py = Math.floor(i / 4) * (H / 2);
    const got = mean(rgb, f, [px + W / 16, py + H / 8, px + (3 * W) / 16, py + (3 * H) / 8]);
    return { want: c, got: got.join(','), err: Math.max(...got.map((v, k) => Math.abs(v - (rgbOf(c)[k] ?? 0)))) };
  });

describe.skipIf(!ready)('colour-true output (Chrome + ffmpeg)', () => {
  let dir = '';
  let rgb: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'make-colour-'));
    await mkdir(path.join(dir, 'assets'));
    const png = path.join(dir, 'assets', 'patches.png');
    await runFfmpegOk(rt, ['-loglevel', 'error', '-y', ...rawInput(W, H), '-frames:v', '1', png], patches(W, H));
    await writeFile(png, withSrgbChunk(await readFile(png)));
    await runFfmpegOk(rt, ['-loglevel', 'error', '-y', ...rawInput(W, H), '-frames:v', '1', '-q:v', '2', path.join(dir, 'assets', 'patches.jpg')], patches(W, H));
    await writeVideo(path.join(dir, 'assets', 'bt709.mp4'), W, H, true);
    // Untagged and HD: read as BT.709, as players do (ffmpeg alone would read it as BT.601).
    await writeVideo(path.join(dir, 'assets', 'untagged-hd.mp4'), 1440, 720, false);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    const out = path.join(dir, 'out.mp4');
    await renderVideo(rt, { projectDir: dir, out });
    rgb = Buffer.from((await runFfmpegOk(rt, ['-loglevel', 'error', '-i', out, '-vf', 'scale=in_color_matrix=bt709:in_range=tv:' + ACC + ',format=rgb24', '-f', 'rawvideo', 'pipe:1'])).stdout);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('brings flat colours back within 2 levels per channel', () => {
    const rows = COLOURS.map((c, i) => {
      const got = mean(rgb, 2 * i + 1, [W / 4, H / 4, (3 * W) / 4, (3 * H) / 4]);
      return { want: c, got: got.join(','), err: Math.max(...got.map((v, k) => Math.abs(v - (rgbOf(c)[k] ?? 0)))) };
    });
    console.log('flat colours\n' + rows.map((r) => r.want + ' -> ' + r.got + '  error ' + r.err).join('\n'));
    expect(Math.max(...rows.map((r) => r.err))).toBeLessThanOrEqual(2);
  });

  it('brings picture bases (an sRGB PNG and a JPEG) back within 3 levels on flat areas', () => {
    for (const [name, k] of [['png', 8], ['jpg', 9]] as const) {
      const rows = patchErrors(rgb, 2 * k + 1);
      console.log(name + ' base\n' + rows.map((r) => r.want + ' -> ' + r.got + '  error ' + r.err).join('\n'));
      expect(Math.max(...rows.map((r) => r.err)), name).toBeLessThanOrEqual(3);
    }
  });

  it('brings video bases (BT.709 tagged, and untagged HD) back within 3 levels on flat areas', () => {
    for (const [name, k] of [['bt709', 10], ['untagged hd', 11]] as const) {
      const rows = patchErrors(rgb, 2 * k + 1);
      console.log(name + ' video base\n' + rows.map((r) => r.want + ' -> ' + r.got + '  error ' + r.err).join('\n'));
      expect(Math.max(...rows.map((r) => r.err)), name).toBeLessThanOrEqual(3);
    }
  });
});
