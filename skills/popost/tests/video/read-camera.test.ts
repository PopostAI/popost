/**
 * Camera inside one shot: zooms, pans and their mix drawn by read-scene.ts and by ffmpeg's geq filter (independent of
 * our code), a hand-held shake, a still shot and a flat colour with nothing to track. Prints the error per clip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { CameraMeasure } from '../../src/video/types';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, H, pool, sourceFrames, W } from './read-clips';
import type { Base, Scene } from './read-scene';
import { renderScene } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

interface Truth { kind: CameraMeasure['kind']; zoom: number; pan: [number, number] }
interface Case { name: string; truth: Truth; make: (out: string) => Promise<void> }

let big: Base = { colour: [0, 0, 0] };
const shot = (camera?: { zoom?: number; pan?: [number, number] }, base?: Base): Scene =>
  ({ width: W, height: H, fps: 30, joins: [], items: [], shots: [{ frames: 60, base: base ?? big, ...(camera ? { camera } : {}) }] });
const rendered = (name: string, zoom: number, pan: [number, number]): Case => ({
  name, truth: { kind: 'move', zoom, pan },
  make: (out) => encode(rt, renderScene(shot({ zoom, pan })), W, H, out),
});

/** geq on a 2x still: output pixel X shows the source at c + (X - c - pan W t) / (1 + zoom t), then the centre is cropped. */
const geqClip = (zoom: number, panX: number) => async (out: string): Promise<void> => {
  const S = '(1+' + zoom + '*T)', PX = '(' + panX + '*' + W + '*T)';
  const fx = '(W/2+(X-W/2-' + PX + ')/' + S + ')', fy = '(H/2+(Y-H/2)/' + S + ')';
  const geq = "geq=r='r(" + fx + ',' + fy + ")':g='g(" + fx + ',' + fy + ")':b='b(" + fx + ',' + fy + ")'";
  await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'mandelbrot=s=' + 2 * W + 'x' + 2 * H + ':r=30', '-vf',
    'trim=end_frame=1,loop=loop=59:size=1,setpts=N/30/TB,fps=30,format=gbrp,' + geq + ',crop=' + W + ':' + H + ',format=yuv420p',
    '-r', '30', '-frames:v', '60', '-c:v', 'libx264', '-crf', '16', out]);
};

/** A hand-held shot: the 2x picture cropped at offsets that jump by up to 8 pixels, frame to frame. */
const shaky = async (out: string): Promise<void> => {
  if (!('frames' in big)) throw new Error('read-camera: the 2x picture is not loaded');
  const src = big.frames[0] as Uint8Array, bw = big.w;
  const frames = Array.from({ length: 60 }, (_, n) => {
    const ox = Math.round(W / 2 + 8 * Math.sin(n * 2.3) * Math.cos(n * 0.7)), oy = Math.round(H / 2 + 8 * Math.sin(n * 1.7 + 1));
    const f = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) f.set(src.subarray(((oy + y) * bw + ox) * 3, ((oy + y) * bw + ox + W) * 3), y * W * 3);
    return f;
  });
  await encode(rt, frames, W, H, out);
};

const CASES: Case[] = [
  { name: 'still', truth: { kind: 'static', zoom: 0, pan: [0, 0] }, make: (out) => encode(rt, renderScene(shot()), W, H, out) },
  rendered('slow push-in', 0.04, [0, 0]),
  rendered('push-in', 0.15, [0, 0]),
  rendered('fast push-in', 0.3, [0, 0]),
  rendered('pull-out', -0.06, [0, 0]),
  rendered('pan right', 0, [0.1, 0]),
  rendered('fast pan left', 0, [-0.2, 0]),
  rendered('tilt up', 0, [0, -0.08]),
  rendered('push-in and drift', 0.05, [-0.05, 0.03]),
  { name: 'geq push-in and pan', truth: { kind: 'move', zoom: 0.3, pan: [0.2, 0] }, make: geqClip(0.3, 0.2) },
  { name: 'geq slow push-in', truth: { kind: 'move', zoom: 0.08, pan: [0, 0] }, make: geqClip(0.08, 0) },
  { name: 'hand-held shake', truth: { kind: 'unsteady', zoom: 0, pan: [0, 0] }, make: shaky },
  { name: 'flat colour', truth: { kind: 'unknown', zoom: 0, pan: [0, 0] }, make: (out) => encode(rt, renderScene(shot(undefined, { colour: [40, 90, 200] })), W, H, out) },
];

interface Result { c: Case; got: CameraMeasure; boundaries: number }

describe.skipIf(!ok)('read: camera inside one shot', () => {
  let dir = '';
  let results: Result[] = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    big = { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) };
    results = await pool(CASES, 4, async (c, i) => {
      const out = dir + '/' + i + '.mp4';
      await c.make(out);
      const m = await measureVideo(rt, out);
      return { c, got: (m.shots[0] as { camera: CameraMeasure }).camera, boundaries: m.boundaries.length };
    });
    const rows = results.map((r) => [r.c.name.padEnd(22), r.c.truth.kind.padEnd(9), r.got.kind.padEnd(9),
      (r.c.truth.zoom.toFixed(3) + ' / ' + r.got.zoomPerS.toFixed(3)).padEnd(16),
      (r.c.truth.pan.map((v) => v.toFixed(3)).join(',') + ' / ' + r.got.panPerS.map((v) => v.toFixed(3)).join(',')).padEnd(28)].join(' '));
    console.info(['Camera on ' + CASES.length + ' synthetic clips (' + W + 'x' + H + ', 30 fps, 2 s)', 'clip                   truth     got       zoom/s t/g       pan/s t/g', ...rows].join('\n'));
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('names the kind of camera', () => {
    expect(results.map((r) => r.c.name + ': ' + r.got.kind)).toEqual(results.map((r) => r.c.name + ': ' + r.c.truth.kind));
  });

  it('measures zoom and pan rates of moving shots', () => {
    const moves = results.filter((r) => r.c.truth.kind === 'move');
    for (const r of moves) {
      expect(Math.abs(r.got.zoomPerS - r.c.truth.zoom), r.c.name + ' zoom').toBeLessThanOrEqual(ZOOM_ABS + ZOOM_REL * Math.abs(r.c.truth.zoom));
      expect(Math.abs((r.got.panPerS[0]) - r.c.truth.pan[0]), r.c.name + ' pan x').toBeLessThanOrEqual(PAN_ABS + PAN_REL * Math.abs(r.c.truth.pan[0]));
      expect(Math.abs((r.got.panPerS[1]) - r.c.truth.pan[1]), r.c.name + ' pan y').toBeLessThanOrEqual(PAN_ABS + PAN_REL * Math.abs(r.c.truth.pan[1]));
    }
  });

  it('reports still and untrackable shots without a rate, and no boundary inside any shot', () => {
    for (const r of results.filter((x) => x.c.truth.kind === 'static' || x.c.truth.kind === 'unknown')) expect(r.got.zoomPerS === 0 && r.got.panPerS[0] === 0 && r.got.panPerS[1] === 0, r.c.name).toBe(true);
    expect(results.filter((r) => r.boundaries > 0).map((r) => r.c.name)).toEqual([]);
  });
});

/** Tolerances the measurement meets on these clips (per second): an absolute part plus a share of the true rate. */
const ZOOM_ABS = 0.003;
const ZOOM_REL = 0.02;
const PAN_ABS = 0.003;
const PAN_REL = 0.02;
