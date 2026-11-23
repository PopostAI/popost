import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { LOOP_PRESETS } from '../../src/video/types';
import type { LoopSpec, Problem, Project, ResolvedItem, ShapeTrack } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { itemStateAt, loopFrame } from '../../src/video/timeline/frame';
import { IDENTITY_LOOP, LOOP_DEFAULTS, loopState } from '../../src/video/presets/loop';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, isNear, pixelAt, playedAndJumped, projectDir } from './make-fixtures';

const W = 180;
const H = 320;

/** 60 frames on black; a white bar (box 0.3 x 0.05 of the canvas, in the middle) on frames 5..54 with a 6-frame fade in and out. */
const project = (loop: LoopSpec, more: Partial<ShapeTrack> = {}): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [],
  segments: [{ id: 's', frames: 60, base: { color: '#000000' } }],
  tracks: [{ id: 'bar', type: 'shape', shape: 'rect', color: '#ffffff', box: [0.35, 0.475, 0.3, 0.05], during: { segment: 's', from: 5, to: 55 }, enter: { preset: 'fade', frames: 6 }, exit: { preset: 'fade', frames: 6 }, loop, ...more }],
});

const at = (problems: Problem[], where: string): Problem => {
  const p = problems.find((x) => x.at === where && x.level === 'error');
  if (!p) throw new Error('No error at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

const bar = (r: ReturnType<typeof resolve>): ResolvedItem => {
  const it = r.items[0];
  if (!it) throw new Error('no item');
  return it;
};

describe('loops: format, check and state', () => {
  it('is the identity at j = 0 for every preset, and reaches its amount where its shape says', () => {
    for (const preset of LOOP_PRESETS) expect(loopState({ preset, period: 20, amount: LOOP_DEFAULTS[preset] }, 0)).toEqual(IDENTITY_LOOP);
    expect(loopState({ preset: 'pulse', period: 20, amount: 0.1 }, 10).scale).toBeCloseTo(1.1, 12);
    expect(loopState({ preset: 'float', period: 20, amount: 0.02 }, 5).translate[1]).toBeCloseTo(-0.02, 12);
    expect(loopState({ preset: 'sway', period: 20, amount: 8 }, 15).rotate).toBeCloseTo(-8, 12);
    expect([9, 10, 19, 20].map((j) => loopState({ preset: 'blink', period: 20, amount: 0.75 }, j).opacity)).toEqual([1, 0.25, 0.25, 1]);
    expect(loopState({ preset: 'spin', period: 40, amount: -1 }, 10).rotate).toBeCloseTo(-90, 12);
  });

  it('runs between the entrance and the exit: j is 0 during the entrance and holds through the exit', () => {
    const r = resolve(project({ preset: 'pulse', period: 20, amount: 0.2 }, { opacity: 0.5, rotate: 30 }));
    const item = bar(r);
    expect(item.loop).toEqual({ preset: 'pulse', period: 20, amount: 0.2 });
    expect([5, 10, 11, 21, 48, 49, 54].map((n) => loopFrame(item, n))).toEqual([0, 0, 0, 10, 37, 38, 38]);
    expect(itemStateAt(item, 10)).toMatchObject({ scale: 1, opacity: 0.5, rotate: 30 });
    expect(itemStateAt(item, 21)?.scale).toBeCloseTo(1.2, 12);
    // The exit fades from the loop's state at its first frame, which then holds.
    const exit = [49, 51, 53].map((n) => itemStateAt(item, n));
    exit.forEach((s) => expect(s?.scale).toBeCloseTo(exit[0]?.scale ?? 0, 12));
    expect(exit.map((s) => s?.opacity)).toEqual([...exit.map((s) => s?.opacity)].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(itemStateAt(item, 49)?.opacity).toBeCloseTo(0.5, 12);
  });

  it('refuses an amount outside the preset\'s range and a period under 2 frames', () => {
    expect(checkProject(project({ preset: 'spin', period: 30 }))).toEqual([]);
    expect(at(checkProject(project({ preset: 'blink', period: 30, amount: 2 })), 'tracks[0].loop.amount').message).toContain('from 0 to 1');
    expect(at(parseProject(project({ preset: 'pulse', period: 1 })).problems, 'tracks[0].loop.period').message).toContain('at least 2');
    expect(at(parseProject(project({ preset: 'wobble' as LoopSpec['preset'], period: 10 })).problems, 'tracks[0].loop.preset').allowed).toEqual([...LOOP_PRESETS]);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('loops: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];

  beforeAll(async () => {
    // A spin of one turn every 40 frames: a quarter turn at j = 10 (frame 21) stands the bar upright.
    dir = await projectDir('make-loop-', project({ preset: 'spin', period: 40 }));
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('turns the bar as the loop says: lying at j = 0, upright a quarter period later', async () => {
    if (!renderer) throw new Error('renderer not open');
    const lying = await decodePng(await renderer.frame(11));
    const upright = await decodePng(await renderer.frame(21));
    const [cx, cy] = [W / 2, H / 2];
    expect(pixelAt(lying, cx + 20, cy)).toSatisfy((c: number[]) => isNear(c, WHITE));
    expect(pixelAt(lying, cx, cy + 20)).toSatisfy((c: number[]) => isNear(c, BLACK));
    expect(pixelAt(upright, cx + 20, cy)).toSatisfy((c: number[]) => isNear(c, BLACK));
    expect(pixelAt(upright, cx, cy + 20)).toSatisfy((c: number[]) => isNear(c, WHITE));
  });

  it('draws frames inside a loop and its exit the same when played and when jumped to', async () => {
    if (!renderer) throw new Error('renderer not open');
    const r = renderer;
    for (const n of [14, 26, 37, 51]) {
      const [played, jumped] = await playedAndJumped((f) => r.frame(f), n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });
});
