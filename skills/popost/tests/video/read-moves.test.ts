/**
 * Camera moves with keyframes (CameraMove in types.ts: hold, an eased zoom between two scales around a focus point,
 * hold) drawn by read-scene.ts, which shares no code with the presets or the measurement. Each clip's move must come
 * back with its frames, its two scales and its focus point; a shot that zooms at one rate or holds still has no move;
 * a fast push-in is no boundary. One clip is the hand-studied real case: a hard cut followed at once by a 28-frame
 * eased push-in of 2.6x towards a corner. Prints the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { Ease, Measure } from '../../src/video/types';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, H, pool, sourceFrames, W } from './read-clips';
import type { Base, Scene, SceneShot } from './read-scene';
import { renderScene } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

interface Move { from: number; to: number; scale: [number, number]; focus: [number, number]; ease: Ease }
interface Case { name: string; shots: Array<{ frames: number; pic: 'a' | 'b'; move?: Move; zoom?: number }>; }

const CASES: Case[] = [
  { name: 'push-in to the centre, linear', shots: [{ frames: 75, pic: 'a', move: { from: 20, to: 45, scale: [1, 1.6], focus: [0.5, 0.5], ease: 'linear' } }] },
  { name: 'push-in to a corner, ease out', shots: [{ frames: 75, pic: 'a', move: { from: 15, to: 40, scale: [1, 2.2], focus: [0.2, 0.75], ease: 'out' } }] },
  { name: 'pull-out from a corner, in-out', shots: [{ frames: 80, pic: 'a', move: { from: 25, to: 55, scale: [1.6, 1], focus: [0.8, 0.25], ease: 'in-out' } }] },
  { name: 'push-in late in the shot, ease in', shots: [{ frames: 70, pic: 'b', move: { from: 30, to: 52, scale: [1, 1.3], focus: [0.5, 0.25], ease: 'in' } }] },
  { name: 'a cut, then a 2.6x push-in at once', shots: [{ frames: 50, pic: 'b' }, { frames: 70, pic: 'a', move: { from: 0, to: 28, scale: [1, 2.6], focus: [0.85, 0.15], ease: 'out' } }] },
];
const NEGATIVES: Case[] = [
  { name: 'steady push-in (one rate)', shots: [{ frames: 60, pic: 'a', zoom: 0.15 }] },
  { name: 'still', shots: [{ frames: 60, pic: 'b' }] },
];

let pictures: Record<'a' | 'b', Base> = { a: { colour: [0, 0, 0] }, b: { colour: [0, 0, 0] } };
const sceneOf = (c: Case): Scene => ({
  width: W, height: H, fps: 30, items: [], joins: c.shots.slice(1).map(() => undefined),
  shots: c.shots.map((s): SceneShot => ({ frames: s.frames, base: pictures[s.pic], ...(s.move ? { move: s.move } : {}), ...(s.zoom ? { camera: { zoom: s.zoom } } : {}) })),
});

interface Result { c: Case; m: Measure }

/** The true moves in absolute frames, with the shot each belongs to. */
const truthMoves = (c: Case): Array<{ shot: number; start: number; end: number; scale: [number, number]; focus: [number, number]; rate: number }> => {
  let at = 0;
  return c.shots.flatMap((s, k) => {
    const start = at;
    at += s.frames;
    return s.move ? [{ shot: k, start: start + s.move.from, end: start + s.move.to, scale: s.move.scale, focus: s.move.focus, rate: (s.move.scale[1] / s.move.scale[0] - 1) / (s.frames / 30) }] : [];
  });
};

describe.skipIf(!ok)('read: camera moves with keyframes', () => {
  let dir = '';
  let results: Result[] = [];
  let negatives: Result[] = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    pictures = {
      a: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) },
      b: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'testsrc2', 1, 2 * W, 2 * H, true) },
    };
    const run = (cs: Case[], offset: number): Promise<Result[]> => pool(cs, 4, async (c, i) => {
      const out = dir + '/' + (offset + i) + '.mp4';
      await encode(rt, renderScene(sceneOf(c)), W, H, out);
      return { c, m: await measureVideo(rt, out) };
    });
    results = await run(CASES, 0);
    negatives = await run(NEGATIVES, CASES.length);
    const rows = results.flatMap((r) => truthMoves(r.c).map((t) => {
      const got = r.m.shots[t.shot]?.camera;
      const mv = got?.moves?.[0];
      return '  ' + r.c.name.padEnd(36) + (t.start + '-' + t.end + ' x' + t.scale.join('>') + ' @' + t.focus.join(',')).padEnd(26) + ' -> ' +
        (mv ? mv.start + '-' + mv.end + ' x' + mv.scale.map((v) => v.toFixed(3)).join('>') + ' @' + (mv.focus ?? []).map((v) => v.toFixed(3)).join(',') : 'none (' + (got?.kind ?? '-') + ')') +
        ', rate ' + t.rate.toFixed(3) + ' / ' + (got?.zoomPerS ?? 0).toFixed(3) + ', boundaries ' + r.m.boundaries.map((b) => b.kind + '@' + b.frame).join(' ');
    }));
    console.info(['Camera moves on ' + CASES.length + ' clips (' + W + 'x' + H + ', 30 fps)', ...rows,
      'negatives: ' + negatives.map((r) => r.c.name + ' ' + r.m.shots.map((s) => s.camera.kind + (s.camera.moves ? ' with a move' : '')).join(',')).join('; ')].join('\n'));
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('finds each move with its frames, scales and focus point', () => {
    for (const r of results) {
      for (const t of truthMoves(r.c)) {
        const cam = r.m.shots[t.shot]?.camera;
        const mv = cam?.moves?.[0];
        expect(mv, r.c.name).toBeDefined();
        if (!mv || !cam) continue;
        expect(Math.abs(mv.start - t.start), r.c.name + ' start').toBeLessThanOrEqual(FRAMES);
        expect(Math.abs(mv.end - t.end), r.c.name + ' end').toBeLessThanOrEqual(FRAMES);
        expect(Math.abs(mv.scale[1] / mv.scale[0] / (t.scale[1] / t.scale[0]) - 1), r.c.name + ' scale').toBeLessThanOrEqual(SCALE);
        expect(Math.hypot((mv.focus?.[0] ?? 9) - t.focus[0], (mv.focus?.[1] ?? 9) - t.focus[1]), r.c.name + ' focus').toBeLessThanOrEqual(FOCUS);
        expect(Math.abs(cam.zoomPerS - t.rate), r.c.name + ' mean rate').toBeLessThanOrEqual(RATE * Math.abs(t.rate) + 0.01);
      }
    }
  });

  it('reads a fast push-in as a camera move, not a boundary; the cut before one stays a cut', () => {
    expect(results.map((r) => r.c.name + ': ' + r.m.boundaries.map((b) => b.kind + '@' + b.frame).join(' '))).toEqual(
      results.map((r) => r.c.name + ': ' + r.c.shots.slice(1).map((_, k) => 'cut@' + r.c.shots.slice(0, k + 1).reduce((s, x) => s + x.frames, 0)).join(' ')));
  });

  it('gives no move to a shot that holds or zooms at one rate', () => {
    expect(negatives.map((r) => r.c.name + ': ' + r.m.shots.filter((s) => s.camera.moves?.length).length)).toEqual(negatives.map((r) => r.c.name + ': 0'));
  });
});

/** Tolerances the measurement meets on these clips (2026-11-20: every start and end exact, scale ratios within 0.2%,
 *  focus within 0.001, mean rates within 0.3%): frames, the scale ratio, the focus point (fractions of the frame), the
 *  mean rate (share of the true rate, plus 0.01 per second). */
const FRAMES = 1;
const SCALE = 0.01;
const FOCUS = 0.02;
const RATE = 0.02;
