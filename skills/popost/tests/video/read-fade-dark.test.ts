/**
 * A long fade through black between dark shots (dark designed scenes, fades via black of up to 27 frames). The fade out
 * and the fade in are found as two ramps whose last and first frames are still a little lit, with a few black frames
 * between them: they are one fade via black, not two dissolves. Here the ramps end on frame 57 (lit) and start on 61
 * (lit), black on 58 to 60.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, H, sourceFrames, W } from './read-clips';
import type { Base, Scene } from './read-scene';
import { renderScene } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;
const dark = (): number => 0.4;

describe.skipIf(!ok)('a fade through black between dark shots', () => {
  let pictures: Record<string, Base> = {};
  beforeAll(async () => {
    rt = await createDiskRuntime();
    pictures = {
      bars: { w: W, h: H, frames: await sourceFrames(rt, 'smptebars', 1, W, H, true) },
      mandel: { w: W, h: H, frames: await sourceFrames(rt, 'mandelbrot', 1, W, H, true) },
    };
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('is one fade via black, not two dissolves', async () => {
    const sc: Scene = {
      width: W, height: H, fps: 30, items: [],
      shots: [{ frames: 60, base: pictures.bars as Base, light: dark }, { frames: 60, base: pictures.mandel as Base, light: dark }],
      joins: [{ kind: 'fade', frames: 27, via: 'black' }],
    };
    const out = rt.path.join(rt.dir, 'dark-fade.mp4');
    await encode(rt, renderScene(sc), W, H, out);
    const m = await measureVideo(rt, out);
    expect(m.boundaries.map((b) => b.kind + (b.via ? ' ' + b.via : ''))).toEqual(['fade black']);
    const [b] = m.boundaries;
    expect(Math.abs((b?.frame ?? 0) - 60)).toBeLessThanOrEqual(3);
    expect((b?.end ?? 0) - (b?.start ?? 0)).toBeGreaterThanOrEqual(20);
  }, 60_000);
});
