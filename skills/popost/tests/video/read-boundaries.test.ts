/**
 * Boundaries on synthetic clips: xfade transitions (independent of our code) over four kinds of content, the
 * transitions xfade lacks drawn by read-scene.ts, and negative cases that must give no boundary. Prints a table of
 * precision, recall, span error and kind accuracy per kind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { Boundary } from '../../src/video/types';
import { measureVideo } from '../../src/video/measure/index';
import { kindCredit } from '../../src/video/score/weights';
import { encode, ffmpegReady, H, pool, sourceFrames, W, xfadeClip } from './read-clips';
import type { XShot } from './read-clips';
import type { Base, Scene, SceneJoin } from './read-scene';
import { renderScene, sceneBoundaries } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

const CONTENT: Record<string, [XShot['src'], XShot['src'], XShot['src'], boolean]> = {
  flat: ['color=c=0xd03020', 'color=c=0x2050c0', 'color=c=0x30a050', true],
  gradient: ['gradients=c0=0x203060:c1=0xe0a040:seed=1:speed=0', 'gradients=c0=0x10a060:c1=0xf0e0d0:seed=5:speed=0', 'color=c=0x804020', true],
  detail: ['testsrc2', 'mandelbrot', 'smptebars', true],
  moving: ['testsrc2', 'mandelbrot', 'smptebars', false],
};
const XKINDS = ['cut', 'fade', 'dissolve', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideup', 'coverright', 'revealdown', 'circleopen', 'circleclose', 'zoomin'];
const DURATIONS = [4, 8, 15, 30];
const CONTENTS = Object.keys(CONTENT);

interface Case { name: string; group: string; make: (out: string) => Promise<Boundary[]> }

const xfadeCases: Case[] = XKINDS.flatMap((k, i) => [0, 1, 2].map((j) => {
  const F = k === 'cut' ? 0 : (DURATIONS[(i + j) % 4] as number);
  const content = CONTENTS[(i + 2 * j + (j > 0 ? 1 : 0)) % 4] as string;
  const [a, b, c, still] = CONTENT[content] as [string, string, string, boolean];
  return {
    name: k + ' ' + F + ' ' + content, group: k,
    make: (out: string) => xfadeClip(rt, out, [{ src: a, frames: 40, still }, { src: b, frames: 40, still }, { src: c, frames: 24, still: true }], [{ name: k, frames: F }, { name: 'cut', frames: 0 }]),
  };
}));

let pictures: Record<string, Base> = {};
const scene = (joins: Array<SceneJoin | undefined>, bases: [string, string, string], extra: Partial<Scene> = {}): Scene => ({
  width: W, height: H, fps: 30, items: [], ...extra,
  shots: [{ frames: 40, base: pictures[bases[0]] as Base }, { frames: 40, base: pictures[bases[1]] as Base }, { frames: 24, base: pictures[bases[2]] as Base }].slice(0, joins.length + 1), joins,
});
const SCENE_JOINS: SceneJoin[] = [
  { kind: 'flash', frames: 6 }, { kind: 'flash', frames: 12 }, { kind: 'spin', frames: 8 }, { kind: 'spin', frames: 12 },
  { kind: 'blur', frames: 10 }, { kind: 'blur', frames: 16 }, { kind: 'glitch', frames: 12 }, { kind: 'shake', frames: 10 },
  { kind: 'whip', frames: 8, direction: 'left' }, { kind: 'whip', frames: 12, direction: 'down' }, { kind: 'zoom', frames: 10 }, { kind: 'zoom', frames: 16 },
  { kind: 'dissolve', frames: 12, ease: 'in-out' }, { kind: 'slide', frames: 10, direction: 'right', mode: 'cover', ease: 'in-out' },
  { kind: 'wipe', frames: 10, direction: 'center-out', ease: 'in-out' }, { kind: 'fade', frames: 12, via: 'black' }, { kind: 'fade', frames: 8, via: 'white', ease: 'in-out' },
];
const sceneCases: Case[] = SCENE_JOINS.map((j, i) => ({
  name: j.kind + ' ' + j.frames + (j.direction ? ' ' + j.direction : '') + (j.ease ? ' ' + j.ease : '') + ' scene', group: j.kind,
  make: async (out: string) => {
    const sc = scene([j, undefined], i % 3 === 2 ? ['gradA', 'mandel', 'bars'] : ['test', 'mandel', 'bars']);
    await encode(rt, renderScene(sc), W, H, out);
    return sceneBoundaries(sc);
  },
}));

const single = (base: string, shot: Partial<Scene['shots'][number]>, extra: Partial<Scene> = {}): Scene =>
  ({ width: W, height: H, fps: 30, items: [], joins: [], ...extra, shots: [{ frames: 90, base: pictures[base] as Base, ...shot }] });
const NEGATIVES: Array<[string, () => Scene]> = [
  ['zoom inside one take', () => single('big', { camera: { zoom: 0.25 } })],
  ['fast pan inside one take', () => single('wide', { frames: 60, camera: { pan: [0.45, 0] } })],
  ['brightness ramp inside one take', () => single('test', { light: (t) => 1 - 0.5 * Math.min(1, Math.max(0, (t - 1) / 0.5)) })],
  ['brightness ramp on a gradient', () => single('gradA', { light: (t) => 1 - 0.45 * Math.min(1, Math.max(0, (t - 1) / 0.6)) })],
  ['one-frame flicker', () => single('test', { light: (t) => (Math.abs(t - 1.5) < 0.01 ? 1.7 : 1) })],
  ['large element popping in', () => single('test', {}, { items: [{ from: 40, to: 90, box: [0.15, 0.25, 0.7, 0.45], colour: [250, 250, 245] }] })],
  ['fast object crossing', () => single('mandel', {}, { items: [{ from: 20, to: 40, box: [-0.4, 0.3, 0.45, 0.35], colour: [240, 200, 30], travel: [1.4, 0] }] })],
];
const negativeCases: Case[] = NEGATIVES.map(([name, sc]) => ({
  name, group: 'negative',
  make: async (out: string) => { await encode(rt, renderScene(sc()), W, H, out); return []; },
}));
negativeCases.push({ name: 'moving content', group: 'negative', make: (out) => xfadeClip(rt, out, [{ src: 'testsrc2', frames: 90 }], []) });

interface Result { c: Case; truth: Boundary[]; got: Boundary[]; ms: number }

/** Truth and measured boundaries paired: a measured one matches when its takeover frame is within max(2, half the true span). */
const match = (truth: Boundary[], got: Boundary[]): Array<[Boundary, Boundary | undefined]> => {
  const used = new Set<number>();
  return truth.map((t) => {
    const tol = Math.max(2, Math.ceil((t.end - t.start) / 2));
    let best = -1;
    got.forEach((g, i) => { if (!used.has(i) && Math.abs(g.frame - t.frame) <= tol && (best < 0 || Math.abs(g.frame - t.frame) < Math.abs((got[best] as Boundary).frame - t.frame))) best = i; });
    if (best >= 0) used.add(best);
    return [t, best >= 0 ? got[best] : undefined];
  });
};

describe.skipIf(!ok)('read: boundaries on synthetic clips', () => {
  let dir = '';
  let results: Result[] = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    pictures = {
      test: { w: W, h: H, frames: await sourceFrames(rt, 'testsrc2', 1, W, H, true) },
      mandel: { w: W, h: H, frames: await sourceFrames(rt, 'mandelbrot', 1, W, H, true) },
      bars: { w: W, h: H, frames: await sourceFrames(rt, 'smptebars', 1, W, H, true) },
      gradA: { w: W, h: H, frames: await sourceFrames(rt, 'gradients=c0=0x203060:c1=0xe0a040:seed=1:speed=0', 1, W, H, true) },
      big: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) },
      wide: { w: 3 * W, h: 3 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 3 * W, 3 * H, true) },
    };
    const cases = [...xfadeCases, ...sceneCases, ...negativeCases];
    results = await pool(cases, 4, async (c, i) => {
      const out = dir + '/' + i + '.mp4';
      const truth = await c.make(out);
      const t0 = performance.now();
      const m = await measureVideo(rt, out);
      return { c, truth, got: m.boundaries, ms: performance.now() - t0 };
    });
    console.info(report(results));
  }, 240_000);
  afterAll(() => rt.cleanup());

  const positives = (): Result[] => results.filter((r) => r.c.group !== 'negative');
  const pairs = (): Array<[Boundary, Boundary | undefined]> => positives().flatMap((r) => match(r.truth, r.got));

  it('has at least 40 clips with a transition', () => {
    expect(positives().length).toBeGreaterThanOrEqual(40);
  });

  it('finds the boundaries (precision and recall)', () => {
    const p = pairs();
    const found = p.filter(([, g]) => g).length;
    const measured = positives().reduce((s, r) => s + r.got.length, 0);
    expect(found / p.length).toBeGreaterThanOrEqual(RECALL);
    expect(found / measured).toBeGreaterThanOrEqual(PRECISION);
  });

  it('places the spans', () => {
    const p = pairs().filter((x): x is [Boundary, Boundary] => x[1] !== undefined);
    const mae = (f: (t: Boundary, g: Boundary) => number): number => p.reduce((s, [t, g]) => s + f(t, g), 0) / p.length;
    expect(mae((t, g) => Math.abs(t.start - g.start))).toBeLessThanOrEqual(SPAN_MAE);
    expect(mae((t, g) => Math.abs(t.end - g.end))).toBeLessThanOrEqual(SPAN_MAE);
  });

  it('names the kind', () => {
    const p = pairs().filter((x): x is [Boundary, Boundary] => x[1] !== undefined);
    expect(p.filter(([t, g]) => t.kind === g.kind).length / p.length).toBeGreaterThanOrEqual(KIND_EXACT);
    expect(p.reduce((s, [t, g]) => s + kindCredit(t.kind, g.kind), 0) / p.length).toBeGreaterThanOrEqual(KIND_CREDIT);
    const directed = p.filter(([t, g]) => t.direction && t.kind === g.kind);
    expect(directed.filter(([t, g]) => t.direction === g.direction).length / directed.length).toBeGreaterThanOrEqual(DIRECTION);
  });

  it('reports no boundary inside one take', () => {
    const neg = results.filter((r) => r.c.group === 'negative');
    expect(neg.map((r) => r.c.name + ': ' + r.got.length)).toEqual(neg.map((r) => r.c.name + ': 0'));
  });
});

// Thresholds the code meets on these clips (see the printed table); a regression below them fails the suite.
const RECALL = 0.97;
const PRECISION = 0.97;
const SPAN_MAE = 0.6;
const KIND_EXACT = 0.9;
const KIND_CREDIT = 0.93;
const DIRECTION = 0.95;

const report = (rs: Result[]): string => {
  const groups = [...new Set(rs.map((r) => r.c.group))];
  const lines = ['kind         clips  found/true  extra  startMAE  endMAE  kind ok  dir ok  ms/clip'];
  for (const g of groups) {
    const rr = rs.filter((r) => r.c.group === g);
    const p = rr.flatMap((r) => match(r.truth, r.got)).filter(([t]) => g === 'negative' || t.kind !== 'cut' || g === 'cut');
    const hit = p.filter((x): x is [Boundary, Boundary] => x[1] !== undefined);
    const extra = rr.reduce((s, r) => s + r.got.length, 0) - rr.flatMap((r) => match(r.truth, r.got)).filter(([, x]) => x).length;
    const mae = (f: (t: Boundary, x: Boundary) => number): string => (hit.length ? (hit.reduce((s, [t, x]) => s + f(t, x), 0) / hit.length).toFixed(2) : '-');
    const dir = hit.filter(([t]) => t.direction);
    lines.push([g.padEnd(12), String(rr.length).padStart(5), (hit.length + '/' + p.length).padStart(11), String(extra).padStart(6),
      mae((t, x) => Math.abs(t.start - x.start)).padStart(9), mae((t, x) => Math.abs(t.end - x.end)).padStart(7),
      (hit.length ? hit.filter(([t, x]) => t.kind === x.kind).length + '/' + hit.length : '-').padStart(8),
      (dir.length ? dir.filter(([t, x]) => t.direction === x.direction).length + '/' + dir.length : '-').padStart(7),
      (rr.reduce((s, r) => s + r.ms, 0) / rr.length).toFixed(0).padStart(8)].join(' '));
  }
  const misses = rs.flatMap((r) => match(r.truth, r.got).filter(([t, x]) => !x || x.kind !== t.kind || (t.direction && x.direction !== t.direction)).map(([t, x]) =>
    '  ' + r.c.name + ': truth ' + t.kind + (t.direction ? ' ' + t.direction : '') + ' ' + t.start + '-' + t.end + ' -> ' + (x ? x.kind + (x.direction ? ' ' + x.direction : '') + ' ' + x.start + '-' + x.end + ' (' + x.confidence + ')' : 'missed')));
  const extras = rs.filter((r) => r.got.length > r.truth.length).map((r) => '  extra in ' + r.c.name + ': ' + r.got.map((b) => b.kind + '@' + b.frame).join(', '));
  const all = rs.filter((r) => r.c.group !== 'negative');
  const ps = all.flatMap((r) => match(r.truth, r.got)), hits = ps.filter((x): x is [Boundary, Boundary] => x[1] !== undefined);
  const measured = all.reduce((s, r) => s + r.got.length, 0);
  const overall = 'all ' + all.length + ' clips with ' + ps.length + ' true boundaries: recall ' + (hits.length / ps.length).toFixed(3) + ', precision ' + (hits.length / measured).toFixed(3) +
    ', start MAE ' + (hits.reduce((s, [t, g]) => s + Math.abs(t.start - g.start), 0) / hits.length).toFixed(2) + ', end MAE ' + (hits.reduce((s, [t, g]) => s + Math.abs(t.end - g.end), 0) / hits.length).toFixed(2) +
    ', kind exact ' + (hits.filter(([t, g]) => t.kind === g.kind).length / hits.length).toFixed(3) + ', kind credit ' + (hits.reduce((s, [t, g]) => s + kindCredit(t.kind, g.kind), 0) / hits.length).toFixed(3);
  return ['Boundaries on ' + rs.length + ' synthetic clips (160x284, 30 fps)', ...lines, overall, 'misses and wrong kinds:', ...misses, ...extras].join('\n');
};
