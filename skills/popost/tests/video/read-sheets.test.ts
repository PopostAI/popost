import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { writeSheets } from '../../src/video/look/sheets';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { ffmpegReady } from './read-clips';

const ok = await ffmpegReady();
const WIDTH = 16, HEIGHT = 16, BYTES = WIDTH * HEIGHT * 3;

describe.skipIf(!ok)('contact sheets with many separate frame selections', () => {
  let rt: DiskRuntime;
  let video: string;
  let decoded: Uint8Array;

  beforeAll(async () => {
    rt = await createDiskRuntime({ env: { POPOST_CPUS: '1' } });
    video = rt.path.join(rt.dir, 'frames.mkv');
    // A short, lossless clip whose pixels change every frame, including frames far beyond the opening.
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
      "nullsrc=s=16x16:r=500:d=4,geq=lum='mod(N,220)+16':cb=128:cr=128",
      '-c:v', 'ffv1', video]);
    const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', video, '-vf',
      'scale=16:16:in_color_matrix=bt601:in_range=tv:flags=area+accurate_rnd,format=rgb24',
      '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
    decoded = r.stdout;
    expect(decoded.length).toBe(2000 * BYTES);
  });
  afterAll(async () => { await rt?.cleanup(); });

  it.each([200, 400, 1000])('decodes %i non-adjacent frames without dropping or relabelling them', async (count) => {
    const frames = Array.from({ length: count }, (_, i) => i * 2);
    const shown = [frames[0] as number, frames[Math.floor(count / 2)] as number, frames[count - 1] as number];
    const result = await writeSheets(rt, video, [{ file: 'sample.jpg', frames: shown }], {
      width: WIDTH, outDir: rt.path.join(rt.dir, String(count)), keep: frames,
    });
    expect(result.size).toEqual({ width: WIDTH, height: HEIGHT });
    expect([...result.kept.keys()]).toEqual(frames);
    for (const frame of frames) {
      expect(result.kept.get(frame), 'source frame ' + frame).toEqual(decoded.subarray(frame * BYTES, (frame + 1) * BYTES));
    }
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]?.frames).toEqual(shown);
    expect(result.sheets[0]?.seconds).toEqual(shown.map((frame) => frame / 500));
    expect(await rt.fs.stat(result.sheets[0]?.file ?? '')).toMatchObject({ isDirectory: false });
  });
});
