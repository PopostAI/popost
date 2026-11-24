import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Measure, ShotMeasure } from '../../src/video/types';
import { describeReference } from '../../src/video/describe/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { amountIn, measureAmount, shotAmount, videoAmount } from '../../src/video/measure/amount';
import { clipAmount, measureVideo } from '../../src/video/measure/index';
import { checkProject } from '../../src/video/project/check';
import { shotItemProblems } from '../../src/video/retarget/items';
import { amountRatio, compareShots } from '../../src/video/score/shots';
import { motionNote } from '../../src/video/commands/read';

const flat = (level: number): Uint8Array => new Uint8Array(64).fill(level);
const shot = (index: number, start: number, end: number): ShotMeasure => ({ index, start, end, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#000000', palette: [], events: [] });

/** Two shots of 60 frames at 30 fps with a cut at 60; the first changes by 'a' levels per 1/15 s, the second by 'b'. */
const measured = (a: number, b: number): Measure => ({
  version: 1,
  source: { width: 180, height: 320, fps: 30, frames: 120, duration: 4, hasAudio: false },
  boundaries: [{ frame: 60, kind: 'cut', start: 59, end: 60, confidence: 1 }],
  shots: [shot(0, 0, 60), shot(1, 60, 120)],
  rhythm: { step: 3, change: [] },
  // The value across the cut (frames 58 .. 60) is the cut, not motion.
  motion: { step: 2, amount: Array.from({ length: 59 }, (_v, k) => (k === 29 ? 90 : k < 29 ? a : b)) },
  signature: { every: 6, width: 8, height: 8, count: 0, data: '' },
});

describe('the motion amount', () => {
  it('is the mean gray change between frames about 1/15 s apart, stated per 1/15 s at any frame rate', () => {
    const ramp = (n: number, perFrame: number): Uint8Array[] => Array.from({ length: n }, (_v, i) => flat(i * perFrame));
    expect(measureAmount(ramp(9, 2), 30)).toEqual({ step: 2, amount: [4, 4, 4, 4] });
    // 60 fps: the same picture change per second is half as much per frame, and reads the same.
    expect(measureAmount(ramp(17, 1), 60)).toEqual({ step: 4, amount: [4, 4, 4, 4] });
    // 24 fps: frames 2 apart are 1/12 s apart, so the change is scaled by 24 / 30.
    expect(measureAmount(ramp(5, 5), 24)).toEqual({ step: 2, amount: [8, 8] });
    expect(measureAmount([flat(7), flat(7), flat(7)], 30).amount).toEqual([0]);
  });

  it('leaves the change of shot out of a shot\'s amount and of the video\'s', () => {
    const m = measured(12, 3);
    expect([shotAmount(m, 0), shotAmount(m, 1), videoAmount(m)]).toEqual([12, 3, 7.5]);
    expect(amountIn(m, 57, 61)).toBeUndefined();
    expect(shotAmount({ ...m, motion: undefined }, 0)).toBeUndefined();
  });

  it('is written into the description as a measurement, per shot and for the video', () => {
    const d = describeReference(measured(12, 3), undefined, 'reference');
    expect(d.files['shots/01.md']).toContain('- Motion amount: 12 (the whole video: 7.5). The mean change of the picture between frames 1/15 s apart');
    expect(d.files['REFERENCE.md']).toContain('- Motion amount: 7.5 over the video, by shot from 3 (#02) to 12 (#01)');
    expect(d.files['REFERENCE.md']).not.toMatch(/sped up|slow motion/);
  });

  it('compare gives both amounts and their ratio per shot, and names the shots that move much less or much more', () => {
    const c = compareShots(measured(12, 3), measured(3, 12));
    expect(c.shots.map((s) => s.motionAmount)).toEqual([{ reference: 12, other: 3, ratio: 0.25 }, { reference: 3, other: 12, ratio: 4 }]);
    expect(c.motion).toEqual({ reference: 7.5, other: 7.5, ratio: 1, less: [1], more: [2] });
    expect(motionNote(c.motion as NonNullable<typeof c.motion>)).toMatch(/Shot 1 moves less than 0\.5 times .* never slow a clip down .* Shot 2 moves more than 2 times/);
    // Close to the reference, and two nearly still shots whose ratio is noise: nobody is named.
    expect(compareShots(measured(12, 0.3), measured(8, 1.4)).motion).toMatchObject({ less: [], more: [] });
    expect([amountRatio(0.1, 0.3), amountRatio(0, 0)]).toEqual([1, 1]);
    // A measurement from before the amount existed compares as before, without it.
    const old = compareShots(measured(12, 3), { ...measured(3, 12), motion: undefined });
    expect([old.motion, old.shots[0]?.motionAmount]).toEqual([undefined, undefined]);
  });

  it('warns about footage slowed below 0.9, in a project and in a fill\'s item, and not about 0.9 or a faster clip', () => {
    const project = (speed: number) => ({
      version: 1 as const, canvas: { width: 180, height: 320, fps: 30 }, materials: [{ id: 'clip', kind: 'video' as const, file: 'assets/clip.mp4' }],
      segments: [{ id: 's0', frames: 30, base: { material: 'clip', speed } }], tracks: [],
    });
    const slow = checkProject(project(0.82)).filter((p) => p.at === 'segments[0].base.speed');
    expect(slow.map((p) => p.level)).toEqual(['warning']);
    expect(slow[0]?.message).toContain('plays at 0.82 of its speed');
    expect(slow[0]?.fix).toContain('Set "speed" to 1 or more');
    expect([0.9, 1, 1.5].flatMap((s) => checkProject(project(s)))).toEqual([]);
    const item = shotItemProblems({ items: [{ video: 'assets/clip.mp4', box: [0, 0, 1, 1], speed: 0.5 }] }, 'shots[0]');
    expect(item.map((p) => p.level + ' ' + p.at)).toEqual(['warning shots[0].items[0].speed']);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });

describe.skipIf(!(await hasFfmpeg(rt)))('the motion amount of a file (ffmpeg)', () => {
  it('doubles when the same clip plays twice as fast, and a still picture has none', async () => {
    const file = (name: string): string => rt.path.join(rt.dir, name);
    const encode = (source: string, filter: string, out: string): Promise<unknown> =>
      runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-vf', filter, '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', file(out)]);
    // A soft pattern that slides sideways at a steady rate; then the same played at twice the speed.
    await encode('testsrc2=s=180x320:r=30:d=4', 'gblur=sigma=6,scroll=horizontal=0.004', 'normal.mp4');
    await encode('testsrc2=s=180x320:r=30:d=4', 'gblur=sigma=6,scroll=horizontal=0.004,setpts=PTS/2,fps=30', 'fast.mp4');
    await encode('color=c=gray:s=180x320:r=30:d=2', 'null', 'still.mp4');
    const [normal, fast, still] = [await clipAmount(rt, file('normal.mp4')), await clipAmount(rt, file('fast.mp4')), await clipAmount(rt, file('still.mp4'))];
    expect(still).toBeLessThan(0.2);
    expect(normal).toBeGreaterThan(1);
    expect((fast ?? 0) / (normal ?? 1)).toBeGreaterThan(1.5);
    expect((fast ?? 0) / (normal ?? 1)).toBeLessThan(2.3);
    // The measurement of a video holds the same curve.
    const m = await measureVideo(rt, file('normal.mp4'));
    expect(Math.abs((videoAmount(m) ?? 0) - (normal ?? 0))).toBeLessThan(0.3);
  });
});
