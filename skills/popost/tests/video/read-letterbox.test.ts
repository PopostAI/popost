/**
 * Cuts of a picture between bars (measure/bars.ts): the bands that never change are found first and the cuts judged
 * inside the box they leave. Unit tests on made-up thumbnails, then clips made with ffmpeg: four shots of 16:9 content
 * in a 9:16 frame, the same shots full frame, and 9:16 content pillarboxed in a 16:9 frame.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { cropThumbs, liveBox } from '../../src/video/measure/bars';
import { measureVideo } from '../../src/video/measure/index';
import type { Thumbs } from '../../src/video/measure/pixels';
import { ffmpegReady } from './read-clips';

/** w x h thumbnails of n frames: pixel (x, y) of frame i from f, gray and rgb alike. */
const thumbs = (w: number, h: number, n: number, f: (x: number, y: number, i: number) => number): Thumbs => {
  const gray = Array.from({ length: n }, (_, i) => Uint8Array.from({ length: w * h }, (_v, p) => f(p % w, Math.floor(p / w), i)));
  return { width: w, height: h, fps: 30, gray, rgb: gray.map((g) => Uint8Array.from({ length: g.length * 3 }, (_v, k) => g[Math.floor(k / 3)] as number)) };
};
/** A picture that changes from frame to frame everywhere (a new shot every frame, in effect). */
const busy = (x: number, y: number, i: number): number => (x * 37 + y * 91 + i * 53) % 256;

describe('bars round the picture', () => {
  it('finds black bands above and below, and leaves the box between them', () => {
    const t = thumbs(18, 32, 10, (x, y, i) => (y < 11 || y >= 22 ? 16 : busy(x, y, i)));
    expect(liveBox(t)).toEqual({ x: 0, y: 11, width: 18, height: 11 });
    const c = cropThumbs(t, { x: 0, y: 11, width: 18, height: 11 });
    expect([c.width, c.height, c.gray[3]?.length, c.rgb[3]?.length]).toEqual([18, 11, 198, 594]);
    expect(c.gray[3]?.[0]).toBe(busy(0, 11, 3));
  });

  it('takes a still title or logo drawn on a bar as part of the bar', () => {
    // A white strip with gaps (a line of text) in the top bar: still, not flat.
    const t = thumbs(18, 32, 10, (x, y, i) => (y >= 4 && y < 7 ? (x % 3 ? 230 : 16) : y < 11 || y >= 22 ? 16 : busy(x, y, i)));
    expect(liveBox(t)).toEqual({ x: 0, y: 11, width: 18, height: 11 });
  });

  it('finds bands at the sides, of any flat colour', () => {
    expect(liveBox(thumbs(32, 18, 10, (x, y, i) => (x < 9 || x >= 23 ? 200 : busy(x, y, i))))).toEqual({ x: 9, y: 0, width: 14, height: 18 });
  });

  it('judges the whole frame when there is no band, a thin one, one that changes, or nothing that moves', () => {
    expect(liveBox(thumbs(18, 32, 10, busy))).toBeUndefined();
    // Two rows of 32 (6%) are an edge of the encoding, not bars.
    expect(liveBox(thumbs(18, 32, 10, (x, y, i) => (y < 2 ? 16 : busy(x, y, i))))).toBeUndefined();
    // Flat in every frame, but another colour from frame to frame: part of the picture.
    expect(liveBox(thumbs(18, 32, 10, (x, y, i) => (y < 11 ? 40 * (i % 3) : busy(x, y, i))))).toBeUndefined();
    // One flat colour throughout: no box is left.
    expect(liveBox(thumbs(18, 32, 10, () => 90))).toBeUndefined();
  });
});

const ok = await ffmpegReady();
let rt: DiskRuntime;
const SOURCES = ['testsrc', 'mandelbrot', 'smptehdbars', 'testsrc2'];

/** Four shots of 45 frames joined by cuts: a source's size, and how it is put on the canvas. */
const clip = async (name: string, size: string, place: string): Promise<string> => {
  const out = rt.path.join(rt.dir, name);
  const inputs = SOURCES.flatMap((s) => ['-f', 'lavfi', '-i', s + '=s=' + size + ':r=30']);
  const shots = SOURCES.map((_s, k) => '[' + k + ':v]trim=end_frame=45,setpts=PTS-STARTPTS,' + place + ',setsar=1,format=yuv420p[s' + k + ']');
  const filter = [...shots, SOURCES.map((_s, k) => '[s' + k + ']').join('') + 'concat=n=' + SOURCES.length + ':v=1:a=0[v]'].join(';');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out]);
  return out;
};
const cuts = async (file: string): Promise<string[]> => (await measureVideo(rt, file)).boundaries.map((b) => b.kind + ' ' + b.frame);

describe.skipIf(!ok)('measure: cuts of a picture between bars', () => {
  beforeAll(async () => { rt = await createDiskRuntime(); }, 60_000);
  afterAll(() => rt.cleanup());

  it('finds every cut of 16:9 content between the bars of a 9:16 frame (none was found before)', async () => {
    expect(await cuts(await clip('letterbox.mp4', '640x360', 'scale=360:202,pad=360:640:0:219:black'))).toEqual(['cut 45', 'cut 90', 'cut 135']);
  }, 60_000);

  it('finds them too with a still title in the top bar, which kept too much of the frame in the box before', async () => {
    // A white strip with gaps near the top: before, the box ran from it to the bottom bar and no cut was found.
    const titled = 'scale=360:202,pad=360:640:0:219:black,drawbox=x=40:y=12:w=280:h=36:color=white:t=fill,drawbox=x=60:y=22:w=20:h=16:color=black:t=fill,drawbox=x=150:y=22:w=20:h=16:color=black:t=fill';
    expect(await cuts(await clip('titled.mp4', '640x360', titled))).toEqual(['cut 45', 'cut 90', 'cut 135']);
  }, 60_000);

  it('finds the same cuts in the same shots full frame', async () => {
    expect(await cuts(await clip('full.mp4', '360x640', 'scale=360:640'))).toEqual(['cut 45', 'cut 90', 'cut 135']);
  }, 60_000);

  it('finds every cut of 9:16 content pillarboxed in a 16:9 frame', async () => {
    expect(await cuts(await clip('pillar.mp4', '360x640', 'scale=202:360,pad=640:360:219:0:black'))).toEqual(['cut 45', 'cut 90', 'cut 135']);
  }, 60_000);
});
