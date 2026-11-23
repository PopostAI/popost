/**
 * Where a zoom or a pan of a reference goes (describe/aim.ts), on clips made with ffmpeg from a still: a steady push-in
 * towards a known region (zoompan), a pull-out from one, a pan along a wide picture (a moving crop), and a still shot.
 * The box must come back within a tenth of the canvas; a still shot has none. shots/NN.md and TEMPLATE.md say it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { cameraAim, type CameraAim } from '../../src/video/describe/aim';
import { describeReference } from '../../src/video/describe/index';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { templateCard } from '../../src/video/template/card';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { Box, Measure } from '../../src/video/types';
import { ffmpegReady } from './read-clips';

const ok = await ffmpegReady();
let rt: DiskRuntime;

/** A still mandelbrot of w x h held for 60 frames at 30 fps, then the filter vf. */
const fromStill = async (name: string, w: number, h: number, vf: string): Promise<string> => {
  const out = rt.path.join(rt.dir, name);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=' + w + 'x' + h + ':r=30',
    '-vf', 'trim=end_frame=1,loop=loop=59:size=1,setpts=N/30/TB' + (vf ? ',' + vf : '') + ',format=yuv420p', '-r', '30', '-frames:v', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', out]);
  return out;
};

/** zoompan from scale a to b (linear over the 60 frames) around the focus point (fx, fy), shown at 320x180. */
const zoom = (a: number, b: number, fx: number, fy: number): string =>
  "zoompan=z='" + a + '+(' + (b - a) + ")*on/59':x='" + fx + "*iw*(1-1/zoom)':y='" + fy + "*ih*(1-1/zoom)':d=1:s=320x180:fps=30";

const near = (got: Box | undefined, want: Box): void => {
  expect(got, 'a box').toBeDefined();
  want.forEach((v, i) => expect(Math.abs((got?.[i] ?? 99) - v), 'box[' + i + '] = ' + got?.[i] + ', expected ' + v).toBeLessThanOrEqual(0.1));
};

describe.skipIf(!ok)('describe: where a zoom or a pan of the reference goes', () => {
  const read: Record<string, Measure> = {};
  beforeAll(async () => {
    rt = await createDiskRuntime();
    const clips: Record<string, string> = {
      push: await fromStill('push.mp4', 640, 360, zoom(1, 2, 0.75, 0.3)),
      pull: await fromStill('pull.mp4', 640, 360, zoom(2, 1, 0.25, 0.7)),
      pan: await fromStill('pan.mp4', 640, 360, "crop=320:180:x='n*160/59':y=90"),
      still: await fromStill('still.mp4', 320, 180, ''),
    };
    for (const [k, file] of Object.entries(clips)) read[k] = await measureVideo(rt, file);
  }, 120_000);
  afterAll(() => rt.cleanup());

  const aimOf = (k: string): CameraAim | undefined => {
    const m = read[k] as Measure;
    expect(m.shots, k + ': one shot').toHaveLength(1);
    return cameraAim(m.shots[0] as Measure['shots'][number], m.source.fps);
  };

  it('gives the region a push-in ends on, within a tenth of the canvas', () => {
    const a = aimOf('push');
    expect(a?.at).toBe('end');
    // Twice as large around (0.75, 0.3): the half of the frame from x 0.375, y 0.15.
    near(a?.box, [0.375, 0.15, 0.5, 0.5]);
  });

  it('gives the region a pull-out starts on, in its last frame', () => {
    const a = aimOf('pull');
    expect(a?.at).toBe('start');
    near(a?.box, [0.125, 0.35, 0.5, 0.5]);
  });

  it('gives where a pan ends, beyond the first frame', () => {
    const a = aimOf('pan');
    expect(a?.at).toBe('end');
    // The picture travels half the canvas to the left: the camera ends on the part right of the first frame.
    near(a?.box, [0.5, 0, 1, 1]);
  });

  it('says nothing about a still shot', () => {
    expect(aimOf('still')).toBeUndefined();
  });

  it('is written in the shot file and in the template card', () => {
    const m = read.push as Measure;
    const shot = describeReference(m, undefined, 'push').files['shots/01.md'] ?? '';
    expect(shot).toMatch(/- The camera ends on \[0\.\d+, 0\.\d+, 0\.\d+, 0\.\d+\] of its first frame \(\[x, y, width, height\] of the canvas\)/);
    const tpl = templateFrom({ measure: m, name: 'push', label: 'push', hash: 'x' });
    expect(tpl.shots[0]?.aim?.at).toBe('end');
    expect(templateCard(tpl, slotsOf(tpl, undefined)).text).toContain('The camera ends on [');
    expect(describeReference(read.still as Measure, undefined, 'still').files['shots/01.md']).not.toContain('The camera ends on');
  });
});
