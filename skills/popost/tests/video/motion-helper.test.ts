/**
 * The pure half of the motion helper (assets/video/motion.js), run in Node with a page that has no layout: its
 * easings are the curves the curve measurement names (measure/easing.ts), its random numbers are seeded, a bounce is
 * parabolic arcs that keep a share of the speed, and a group's offsets follow the order asked for. The effects
 * themselves are drawn in Chrome by tests/video/scene-catalogue.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/testing/memory';
import { CUE_NAMES } from '../../src/video/page/contract';
import { easeNamed, EASES } from '../../src/video/measure/easing';

interface Motion {
  CUES: string[]; problems: string[];
  ease(name: string): (u: number) => number;
  rng(seed: number): (() => number) & { range(a: number, b: number): number; int(n: number): number };
  hash(i: number, seed: number): number; noise(x: number, seed: number): number;
  stepped(seconds: number, fps: number, hold?: number): number;
  bouncePath(o: object): { at(u: number): { y: number; v: number; contact: number }; contacts: number[]; end: number; restitution: number };
  offsets(n: number, each: number, order: string, o?: object): number[];
  cue(at: number, name: string, gain?: number, effect?: string): void; cues(): { at: number; cue: string; gain: number; effect: string }[];
}

const load = (): { M: Motion; scene: { cues: unknown[]; render(s: number, fps: number): void } } => {
  const window: Record<string, unknown> = { innerWidth: 0, innerHeight: 0 };
  const document = { documentElement: { clientWidth: 0, clientHeight: 0 }, body: {}, querySelector: () => null, querySelectorAll: () => [] };
  vm.runInNewContext(readFileSync(path.join(PACKAGE_ROOT, 'assets/video/motion.js'), 'utf8'), { window, document, WeakMap, Math, Array, String, Number, isFinite, Object });
  return { M: window.popostMotion as Motion, scene: window.__popostScene as { cues: unknown[]; render(s: number, fps: number): void } };
};

describe('the motion helper, without a page', () => {
  const { M, scene } = load();

  it('names the same curves as the curve measurement, so that a measured ease can be pasted', () => {
    for (const e of EASES) {
      const mine = M.ease(e.name);
      for (const u of [0, 0.1, 0.37, 0.5, 0.82, 1]) expect(mine(u), e.name + ' at ' + u).toBeCloseTo(e.f(u), 6);
    }
    expect(M.problems).toEqual([]);
    // In, out and both ways of every family; steps; and the short names the other helpers use.
    expect(M.ease('power2.in')(0.5)).toBeCloseTo(0.125, 9);
    expect(M.ease('back.in(1.7)')(0.5)).toBeLessThan(0);
    expect(M.ease('bounce.in')(0.25)).toBeCloseTo(1 - (easeNamed('bounce.out') as (u: number) => number)(0.75), 9);
    expect([0, 0.2, 0.26, 0.99, 1].map(M.ease('steps(4)'))).toEqual([0, 0, 0.25, 0.75, 1]);
    expect(M.ease('in-out')(0.5)).toBeCloseTo(0.5, 9);
    // An unknown name is said once, and something sensible is used.
    expect(M.ease('wobble')(1)).toBeCloseTo(1, 9);
    expect(M.problems.join(' ')).toContain('no ease named "wobble"');
  });

  it('gives the same random numbers for the same seed, and holds the time on twos', () => {
    const a = M.rng(7), b = M.rng(7), c = M.rng(8);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(xs);
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(xs.map((v) => Math.floor(v * 10))).size).toBeGreaterThan(7);
    expect(M.hash(3, 5)).toBe(M.hash(3, 5));
    expect(Math.abs(M.noise(2.5, 9))).toBeLessThanOrEqual(1);
    expect(M.noise(4, 9)).toBeCloseTo(M.hash(4, 9) * 2 - 1, 9);
    // On twos at 30 fps: frames 0 and 1 show the first drawing, 2 and 3 the second.
    expect([0, 1, 2, 3, 4].map((f) => Math.round(M.stepped(f / 30, 30, 2) * 30))).toEqual([0, 0, 2, 2, 4]);
  });

  it('bounces on parabolic arcs that keep a share of the speed', () => {
    const p = M.bouncePath({ height: 300, bounces: 3, restitution: 0.6, for: 1.6 });
    expect(p.contacts).toHaveLength(4);
    expect(p.end).toBeCloseTo(1.6, 6);
    // Each bounce lasts the restitution times the one before; the first is twice the fall times the restitution.
    const [c0, c1, c2, c3] = p.contacts as [number, number, number, number];
    expect((c1 - c0) / c0).toBeCloseTo(1.2, 6);
    expect((c2 - c1) / (c1 - c0)).toBeCloseTo(0.6, 6);
    expect((c3 - c2) / (c2 - c1)).toBeCloseTo(0.6, 6);
    expect(p.at(0).y).toBe(300);
    expect(p.at(c0).y).toBeCloseTo(0, 3);
    // The top of the first bounce is the restitution squared of the drop; it is in the air there, and touching at a contact.
    const top = p.at((c0 + c1) / 2);
    expect(top.y).toBeCloseTo(300 * 0.36, 3);
    expect(top.contact).toBe(0);
    expect(p.at(c1).contact).toBeCloseTo(1, 6);
    expect(Math.abs(p.at(c0 - 0.001).v)).toBeGreaterThan(Math.abs(p.at(c1 - 0.001).v));
    expect(p.at(5).y).toBe(0);
  });

  it('orders a staggered group', () => {
    const r = (xs: number[]): number[] => xs.map((v) => Math.round(v * 100) / 100);
    expect(r(M.offsets(4, 0.1, 'start'))).toEqual([0, 0.1, 0.2, 0.3]);
    expect(r(M.offsets(4, 0.1, 'end'))).toEqual([0.3, 0.2, 0.1, 0]);
    expect(r(M.offsets(5, 0.1, 'center'))).toEqual([0.2, 0.1, 0, 0.1, 0.2]);
    expect(r(M.offsets(6, 0.1, 'diagonal', { cols: 3 }))).toEqual([0, 0.1, 0.2, 0.1, 0.2, 0.3]);
    expect(M.offsets(6, 0.1, 'random', { seed: 3 })).toEqual(M.offsets(6, 0.1, 'random', { seed: 3 }));
  });

  it('collects sound cues by time, with the names the page contract lists', () => {
    expect(M.CUES).toEqual([...CUE_NAMES]);
    M.cue(1.5, 'impact', 1, 'test');
    M.cue(0.25, 'whoosh', 0.5);
    expect(scene.cues).toEqual([{ at: 0.25, cue: 'whoosh', gain: 0.5, effect: 'custom' }, { at: 1.5, cue: 'impact', gain: 1, effect: 'test' }]);
    M.cue(2, 'kazoo');
    expect(M.problems.join(' ')).toContain('no cue named "kazoo"');
    // A page with no layout: rendering a frame sets nothing up and throws nothing.
    expect(() => scene.render(0.5, 30)).not.toThrow();
  });
});
