/**
 * `popost video look` through the CLI: three frames of every shot and a sheet of them, the frames at given seconds,
 * and pairs beside another video at the same share of its length. The videos are synthesized with ffmpeg (two shots
 * of one second each, and a clip of three seconds); skipped without ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, probe, runFfmpegOk } from '../../src/video/media/ffmpeg';

const rt: DiskRuntime = await createDiskRuntime();
afterAll(() => rt.cleanup());
const ffmpeg = await hasFfmpeg(rt);
const at = (p: string): string => rt.path.join(rt.dir, p);
const json = () => rt.json();
/** Width and height of a picture ffmpeg wrote. */
const sizeOf = async (p: string): Promise<[number, number]> => {
  const r = await probe(rt, at(p));
  return [r.width, r.height];
};

describe.skipIf(!ffmpeg)('popost video look', () => {
  beforeAll(async () => {
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', at('a.mp4')]);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', at('b.mp4')]);
    await rt.fs.writeFile(at('desc/measure.json'), JSON.stringify({ source: { width: 160, height: 284, fps: 30, frames: 60 }, shots: [{ index: 0, start: 0, end: 30 }, { index: 1, start: 30, end: 60 }] }));
  }, 60_000);

  it('writes three frames of every shot of a described video and a sheet of each, and lists them', async () => {
    expect((await runCli(rt, ['video', 'look', 'a.mp4', '--out', 'shots', '--reference-dir', 'desc', '--width', '160'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, video: at('a.mp4'), dir: at('shots'), width: 160, shotsFrom: at('desc/measure.json') });
    const pictures = json().pictures as { file: string; shot: number; part: string; frame: number; second: number }[];
    expect(pictures.map((p) => [rt.path.basename(p.file), p.shot, p.part, p.frame])).toEqual([
      ['shot-01-a.jpg', 1, 'a', 8], ['shot-01-b.jpg', 1, 'b', 15], ['shot-01-c.jpg', 1, 'c', 23],
      ['shot-02-a.jpg', 2, 'a', 38], ['shot-02-b.jpg', 2, 'b', 45], ['shot-02-c.jpg', 2, 'c', 53],
    ]);
    expect(pictures[1]?.second).toBe(0.5);
    expect((json().sheets as { file: string; shot: number }[]).map((s) => [rt.path.basename(s.file), s.shot])).toEqual([['shot-01.jpg', 1], ['shot-02.jpg', 2]]);
    expect(await sizeOf('shots/shot-01-a.jpg')).toEqual([160, 284]);
    expect(await sizeOf('shots/shot-02.jpg')).toEqual([480, 284]);
  });

  it('measures the shots itself without a reference directory, and shows the frames at given seconds', async () => {
    expect((await runCli(rt, ['video', 'look', 'a.mp4', '--out', 'measured', '--width', '160'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, shotsFrom: 'measured' });
    expect((json().sheets as unknown[]).length).toBe(2);
    expect((await runCli(rt, ['video', 'look', 'a.mp4', '--out', 'moments', '--at', '0.5,1.5'])).code).toBe(0);
    expect((json().pictures as { file: string; frame: number }[]).map((p) => [rt.path.basename(p.file), p.frame])).toEqual([['at-01.jpg', 15], ['at-02.jpg', 45]]);
    expect(json().sheets).toEqual([]);
    expect((await runCli(rt, ['video', 'look', 'a.mp4', '--out', 'x', '--at', 'soon'])).code).toBe(2);
    expect(String(json().error)).toContain('--at takes seconds');
  });

  it('puts every frame beside the other video\'s frame at the same share of its length, A on the left', async () => {
    expect((await runCli(rt, ['video', 'look', 'a.mp4', '--out', 'pairs', '--at', '1', '--against', 'b.mp4', '--width', '160'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, against: at('b.mp4'), sides: { A: at('a.mp4'), B: at('b.mp4') } });
    expect(json().pictures).toEqual([{ file: at('pairs/at-01.jpg'), frame: 30, second: 1, against: { frame: 45, second: 1.5 } }]);
    // A at 160 x 284; B (16:9) scaled to the same height.
    const [w, h] = await sizeOf('pairs/at-01.jpg');
    expect(h).toBe(284);
    expect(w - 160).toBeGreaterThanOrEqual(502);
    expect(w - 160).toBeLessThanOrEqual(506);
  });
});
