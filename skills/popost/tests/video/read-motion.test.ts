/**
 * Motion events inside one shot: elements that appear and disappear (instant, fade, slide, scale with and without
 * overshoot, wipe) drawn by read-scene.ts over flat, gradient and detailed backgrounds, boxes switched on and off by
 * ffmpeg's drawbox (independent of our code), and shots whose whole picture changes, which must give no event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { MotionEvent } from '../../src/video/types';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, H, pool, sourceFrames, W } from './read-clips';
import type { Base, Scene, SceneItem } from './read-scene';
import { renderScene, sceneEvents } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

const SET_A: SceneItem[] = [
  { from: 10, to: 70, box: [0.1, 0.1, 0.5, 0.12], colour: [220, 40, 40], enter: { how: 'fade', frames: 8, ease: 'out' }, exit: { how: 'fade', frames: 6, ease: 'in' } },
  { from: 20, to: 90, box: [0.2, 0.32, 0.6, 0.1], colour: [30, 120, 220], enter: { how: 'slide', frames: 10, ease: 'out', direction: 'left' } },
  { from: 30, to: 80, box: [0.3, 0.55, 0.4, 0.15], colour: [30, 160, 60], enter: { how: 'pop', frames: 10, overshoot: 0.15 }, exit: { how: 'instant', frames: 1 } },
  { from: 45, to: 90, box: [0.1, 0.8, 0.7, 0.08], colour: [240, 180, 20], enter: { how: 'wipe', frames: 12, ease: 'linear', direction: 'right' } },
  { from: 55, to: 90, box: [0.6, 0.1, 0.3, 0.1], colour: [120, 30, 160], enter: { how: 'instant', frames: 1 } },
];
const SET_B: SceneItem[] = [
  { from: 8, to: 60, box: [0.55, 0.08, 0.35, 0.14], colour: [250, 250, 250], enter: { how: 'slide', frames: 12, ease: 'in-out', direction: 'up' }, exit: { how: 'slide', frames: 8, ease: 'in', direction: 'right' } },
  { from: 25, to: 90, box: [0.1, 0.4, 0.35, 0.2], colour: [255, 120, 40], enter: { how: 'scale', frames: 10, ease: 'out' } },
  { from: 40, to: 76, box: [0.5, 0.45, 0.4, 0.12], colour: [60, 200, 220], enter: { how: 'fade', frames: 15, ease: 'linear' }, exit: { how: 'scale', frames: 8, ease: 'in' } },
  { from: 50, to: 90, box: [0.08, 0.72, 0.84, 0.1], colour: [200, 60, 160], enter: { how: 'wipe', frames: 10, ease: 'linear', direction: 'down' } },
];

let pictures: Record<string, Base> = {};
const scene = (base: string, items: SceneItem[], camera?: { pan: [number, number] }, light?: (t: number) => number): Scene => ({
  width: W, height: H, fps: 30, joins: [], items,
  shots: [{ frames: 90, base: pictures[base] as Base, ...(camera ? { camera } : {}), ...(light ? { light } : {}) }],
});

interface Case { name: string; make: (out: string) => Promise<MotionEvent[]> }
const rendered = (name: string, sc: () => Scene): Case => ({
  name, make: async (out) => { const s = sc(); await encode(rt, renderScene(s), W, H, out); return sceneEvents(s); },
});

/** Boxes switched on and off by drawbox: instant appear at frame a, instant disappear at frame b. */
const DRAWN: Array<{ box: [number, number, number, number]; colour: string; a: number; b?: number }> = [
  { box: [0.1, 0.15, 0.5, 0.15], colour: '0xffffff', a: 15, b: 50 },
  { box: [0.4, 0.6, 0.45, 0.2], colour: '0xe03030', a: 30 },
];
const drawbox = async (out: string): Promise<MotionEvent[]> => {
  const boxes = DRAWN.map((d) => 'drawbox=x=' + Math.round(d.box[0] * W) + ':y=' + Math.round(d.box[1] * H) + ':w=' + Math.round(d.box[2] * W) + ':h=' + Math.round(d.box[3] * H) +
    ':color=' + d.colour + ':t=fill:enable=' + "'" + (d.b !== undefined ? 'between(n,' + d.a + ',' + (d.b - 1) + ')' : 'gte(n,' + d.a + ')') + "'");
  await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=0x283040:s=' + W + 'x' + H + ':r=30', '-vf', boxes.join(',') + ',format=yuv420p', '-frames:v', '75', '-c:v', 'libx264', '-crf', '18', out]);
  const ev = (d: (typeof DRAWN)[number], kind: 'appear' | 'disappear', f: number): MotionEvent =>
    ({ start: f, end: f + 1, box: d.box, kind, how: 'instant', ease: 'instant', colour: '#' + d.colour.slice(2), confidence: 1 });
  return DRAWN.flatMap((d) => [ev(d, 'appear', d.a), ...(d.b !== undefined ? [ev(d, 'disappear', d.b)] : [])]);
};

const CASES: Case[] = [
  rendered('set A on a light flat colour', () => scene('light', SET_A)),
  rendered('set A on a gradient', () => scene('grad', SET_A)),
  rendered('set B on a dark flat colour', () => scene('dark', SET_B)),
  rendered('set B on a detailed picture', () => scene('mandel', SET_B)),
  { name: 'drawbox on a flat colour', make: drawbox },
];
const NEGATIVES: Case[] = [
  rendered('pan over a detailed picture', () => scene('big', [], { pan: [0.12, 0.04] })),
  rendered('brightness ramp', () => scene('test', [], undefined, (t) => 1 - 0.4 * Math.min(1, Math.max(0, t - 1)))),
];

const iou = (a: readonly number[], b: readonly number[]): number => {
  const x0 = Math.max(a[0] as number, b[0] as number), y0 = Math.max(a[1] as number, b[1] as number);
  const x1 = Math.min((a[0] as number) + (a[2] as number), (b[0] as number) + (b[2] as number)), y1 = Math.min((a[1] as number) + (a[3] as number), (b[1] as number) + (b[3] as number));
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / ((a[2] as number) * (a[3] as number) + (b[2] as number) * (b[3] as number) - inter);
};

/** A measured event matches a true one of the same kind when its start is within 3 frames and its box overlaps (IoU 0.5). */
const match = (truth: MotionEvent[], got: MotionEvent[]): Array<[MotionEvent, MotionEvent | undefined]> => {
  const used = new Set<number>();
  return truth.map((t) => {
    const i = got.findIndex((g, k) => !used.has(k) && g.kind === t.kind && Math.abs(g.start - t.start) <= 3 && iou(g.box, t.box) >= 0.5);
    if (i >= 0) used.add(i);
    return [t, i >= 0 ? got[i] : undefined];
  });
};

interface Result { c: Case; truth: MotionEvent[]; got: MotionEvent[] }
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

describe.skipIf(!ok)('read: motion events', () => {
  let dir = '';
  let results: Result[] = [];
  let negatives: Result[] = [];
  let pairs: Array<[MotionEvent, MotionEvent]> = [];
  let found = 0, total = 0, measured = 0;
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    pictures = {
      light: { colour: [235, 235, 240] }, dark: { colour: [25, 25, 35] },
      grad: { w: W, h: H, frames: await sourceFrames(rt, 'gradients=c0=0x202840:c1=0x405070:seed=3:speed=0', 1, W, H, true) },
      mandel: { w: W, h: H, frames: await sourceFrames(rt, 'mandelbrot', 1, W, H, true) },
      test: { w: W, h: H, frames: await sourceFrames(rt, 'testsrc2', 1, W, H, true) },
      big: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) },
    };
    const run = (cs: Case[], offset: number): Promise<Result[]> => pool(cs, 4, async (c, i) => {
      const out = dir + '/' + (offset + i) + '.mp4';
      const truth = await c.make(out);
      const m = await measureVideo(rt, out);
      return { c, truth, got: m.shots.flatMap((s) => s.events) };
    });
    results = await run(CASES, 0);
    negatives = await run(NEGATIVES, CASES.length);
    const lines: string[] = [];
    for (const r of results) {
      const m = match(r.truth, r.got);
      total += r.truth.length;
      measured += r.got.length;
      for (const [t, g] of m) {
        if (g) { found++; pairs.push([t, g]); }
        const f = (e: MotionEvent): string => [e.kind, e.start + '-' + e.end, e.how, e.direction ?? '', e.ease ?? '', e.overshoot ?? ''].join(' ');
        lines.push('  ' + r.c.name + ': ' + f(t) + ' -> ' + (g ? f(g) : 'missed'));
      }
      const extra = r.got.filter((g) => !m.some(([, x]) => x === g));
      for (const g of extra) lines.push('  ' + r.c.name + ': extra ' + g.kind + ' ' + g.start + '-' + g.end + ' ' + (g.how ?? ''));
    }
    pairs = pairs.filter(([t]) => t !== undefined);
    console.info(['Motion events on ' + results.length + ' synthetic clips (' + W + 'x' + H + ', 30 fps): ' + found + '/' + total + ' found, ' + measured + ' measured',
      'how ' + pairs.filter(([t, g]) => t.how === g.how).length + '/' + pairs.length +
      ', direction ' + pairs.filter(([t, g]) => t.direction && t.direction === g.direction).length + '/' + pairs.filter(([t]) => t.direction).length +
      ', ease ' + pairs.filter(([t, g]) => t.ease === g.ease).length + '/' + pairs.length +
      ', start MAE ' + mean(pairs.map(([t, g]) => Math.abs(t.start - g.start))).toFixed(2) + ', end MAE ' + mean(pairs.map(([t, g]) => Math.abs(t.end - g.end))).toFixed(2) +
      ', box IoU mean ' + mean(pairs.map(([t, g]) => iou(t.box, g.box))).toFixed(3) + ' min ' + Math.min(...pairs.map(([t, g]) => iou(t.box, g.box))).toFixed(3) +
      ', overshoot error ' + pairs.filter(([t]) => (t.overshoot ?? 0) > 0).map(([t, g]) => Math.abs((g.overshoot ?? 0) - (t.overshoot ?? 0)).toFixed(2)).join(' '),
      ...lines, 'negatives: ' + negatives.map((r) => r.c.name + ' ' + r.got.length).join(', ')].join('\n'));
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('finds the events (precision and recall)', () => {
    expect(found / total).toBeGreaterThanOrEqual(RECALL);
    expect(found / measured).toBeGreaterThanOrEqual(PRECISION);
  });

  it('times and places them', () => {
    expect(mean(pairs.map(([t, g]) => Math.abs(t.start - g.start)))).toBeLessThanOrEqual(START_MAE);
    expect(mean(pairs.map(([t, g]) => Math.abs(t.end - g.end)))).toBeLessThanOrEqual(END_MAE);
    expect(Math.min(...pairs.map(([t, g]) => iou(t.box, g.box)))).toBeGreaterThanOrEqual(MIN_IOU);
  });

  it('says how they enter and leave', () => {
    expect(pairs.filter(([t, g]) => t.how === g.how).length / pairs.length).toBeGreaterThanOrEqual(HOW);
    expect(pairs.filter(([t, g]) => t.ease === g.ease).length / pairs.length).toBeGreaterThanOrEqual(EASE);
    const directed = pairs.filter(([t]) => t.direction);
    expect(directed.filter(([t, g]) => t.direction === g.direction).length / directed.length).toBeGreaterThanOrEqual(DIRECTION);
    const pops = pairs.filter(([t]) => (t.overshoot ?? 0) > 0);
    for (const [t, g] of pops) expect(Math.abs((g.overshoot ?? 0) - (t.overshoot ?? 0))).toBeLessThanOrEqual(OVERSHOOT);
  });

  it('reports no event when the whole picture changes', () => {
    expect(negatives.map((r) => r.c.name + ': ' + r.got.length)).toEqual(negatives.map((r) => r.c.name + ': 0'));
  });
});

/** What the measurement meets on these clips. */
const RECALL = 0.95;
const PRECISION = 0.95;
const START_MAE = 0.6;
const END_MAE = 1;
const MIN_IOU = 0.75;
const HOW = 0.95;
const DIRECTION = 0.95;
/** Eased curves end a frame or two early on 8 to 12 frame changes, which can tip out into linear. */
const EASE = 0.75;
const OVERSHOOT = 0.03;
