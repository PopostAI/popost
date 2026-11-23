/**
 * The scorer checked the way design section 13.2 asks: a video against itself, against re-encodes, against copies
 * damaged one way at a time (cuts shifted, a transition replaced, an element delayed, a shot removed) and against an
 * unrelated video. The dimension that matches the damage must fall step by step while the others stay in a band.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { Dimension, Measure, Score } from '../../src/video/types';
import { DIMENSIONS } from '../../src/video/types';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { formatScore, scoreMeasures } from '../../src/video/score/index';
import { encode, ffmpegReady, H, pool, sourceFrames, W } from './read-clips';
import type { Base, Scene, SceneItem, SceneJoin } from './read-scene';
import { renderScene } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

interface Damage { shift?: number; replace?: boolean; delay?: number; drop?: boolean }

let pics: Record<string, Base> = {};
/** Four shots: a push-in with a fading title, a pan, a gradient with a sliding card, bars with a popping badge. */
const reference = (d: Damage = {}): Scene => {
  const shift = d.shift ?? 0;
  const shots = [
    { frames: 40 + shift, base: pics.big as Base, camera: { zoom: 0.1 } },
    { frames: 40 - shift, base: pics.wide as Base, camera: { pan: [0.06, 0] as [number, number] } },
    { frames: 40, base: pics.grad as Base },
    { frames: 40, base: pics.bars as Base },
  ];
  const joins: Array<SceneJoin | undefined> = [undefined, d.replace ? { kind: 'wipe', frames: 12, direction: 'left' } : { kind: 'dissolve', frames: 12 }, { kind: 'wipe', frames: 10, direction: 'down' }];
  const title: SceneItem = { from: 8, to: 34, box: [0.1, 0.1, 0.8, 0.12], colour: [250, 250, 250], enter: { how: 'fade', frames: 8, ease: 'out' } };
  const card: SceneItem = { from: 92 + (d.delay ?? 0), to: 116, box: [0.15, 0.55, 0.7, 0.18], colour: [230, 60, 60], enter: { how: 'slide', frames: 10, ease: 'out', direction: 'left' } };
  const badge = (at: number): SceneItem => ({ from: at, to: at + 26, box: [0.55, 0.12, 0.3, 0.1], colour: [20, 20, 20], enter: { how: 'pop', frames: 8, overshoot: 0.12 } });
  if (d.drop) return { width: W, height: H, fps: 30, shots: [shots[0], shots[1], shots[3]] as Scene['shots'], joins: [joins[0], joins[2]], items: [title, badge(92)] };
  return { width: W, height: H, fps: 30, shots, joins, items: [title, card, badge(132)] };
};
/** Nothing in common: other grounds, other cuts, other transitions, no elements. */
const unrelated = (): Scene => ({
  width: W, height: H, fps: 30, items: [],
  shots: [{ frames: 55, base: { colour: [230, 140, 40] } }, { frames: 50, base: pics.mandel as Base, camera: { zoom: -0.08 } }, { frames: 55, base: { colour: [30, 150, 140] } }],
  joins: [{ kind: 'fade', frames: 16, via: 'black' }, { kind: 'flash', frames: 8 }],
});

const reencode = async (src: string, out: string, crf: number, width: number): Promise<void> => {
  await runFfmpegOk(rt, ['-y', '-i', src, '-vf', 'scale=' + width + ':-2', '-c:v', 'libx264', '-crf', String(crf), out]);
};

type Variant = 'self' | 'crf 35' | 'half size' | 'cut +1' | 'cut +3' | 'cut +10' | 'transition replaced' | 'element +3' | 'element +9' | 'shot removed' | 'unrelated';

describe.skipIf(!ok)('read: scoring two measurements', () => {
  let dir = '';
  let ref: Measure | undefined;
  let again: Measure | undefined;
  const scores = new Map<Variant, Score>();
  const s = (v: Variant, d: Dimension): number => (scores.get(v) as Score).dimensions[d].score;
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    pics = {
      big: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'testsrc2', 1, 2 * W, 2 * H, true) },
      wide: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) },
      mandel: { w: 2 * W, h: 2 * H, frames: await sourceFrames(rt, 'mandelbrot', 1, 2 * W, 2 * H, true) },
      grad: { w: W, h: H, frames: await sourceFrames(rt, 'gradients=c0=0x203060:c1=0xe0a040:seed=1:speed=0', 1, W, H, true) },
      bars: { w: W, h: H, frames: await sourceFrames(rt, 'smptebars', 1, W, H, true) },
    };
    const refFile = dir + '/ref.mp4';
    await encode(rt, renderScene(reference()), W, H, refFile);
    const scenes: Array<[Variant, () => Promise<string>]> = [
      ['crf 35', async () => { await reencode(refFile, dir + '/crf.mp4', 35, W); return dir + '/crf.mp4'; }],
      ['half size', async () => { await reencode(refFile, dir + '/half.mp4', 23, W / 2); return dir + '/half.mp4'; }],
      ...([['cut +1', { shift: 1 }], ['cut +3', { shift: 3 }], ['cut +10', { shift: 10 }], ['transition replaced', { replace: true }], ['element +3', { delay: 3 }], ['element +9', { delay: 9 }], ['shot removed', { drop: true }]] as Array<[Variant, Damage]>)
        .map(([v, dmg]): [Variant, () => Promise<string>] => [v, async () => { const f = dir + '/' + v.replace(/\W+/g, '-') + '.mp4'; await encode(rt, renderScene(reference(dmg)), W, H, f); return f; }]),
      ['unrelated', async () => { await encode(rt, renderScene(unrelated()), W, H, dir + '/unrelated.mp4'); return dir + '/unrelated.mp4'; }],
    ];
    const [r, r2, ...others] = await pool([refFile, refFile, ...scenes.map(([, make]) => make)], 4, async (x) => measureVideo(rt, typeof x === 'string' ? x : await x()));
    ref = r;
    again = r2;
    scores.set('self', scoreMeasures(ref as Measure, ref as Measure));
    scenes.forEach(([v], i) => scores.set(v, scoreMeasures(ref as Measure, others[i] as Measure)));
    const head = 'variant              ' + DIMENSIONS.map((d) => d.slice(0, 9).padStart(10)).join('') + ' composite';
    const rows = [...scores.entries()].map(([v, sc]) => v.padEnd(21) + DIMENSIONS.map((d) => (sc.dimensions[d].n > 0 ? sc.dimensions[d].score.toFixed(3) : '-').padStart(10)).join('') + sc.composite.toFixed(3).padStart(10));
    console.info(['Scores against a 4-shot reference (' + (ref as Measure).boundaries.length + ' boundaries)', head, ...rows, '', 'element +9 in full:', formatScore(scores.get('element +9') as Score)].join('\n'));
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('measures the same file the same way, byte for byte, and scores it 1 against itself', () => {
    expect(JSON.stringify(again)).toBe(JSON.stringify(ref));
    const self = scores.get('self') as Score;
    expect(self.composite).toBe(1);
    for (const d of DIMENSIONS) if (self.dimensions[d].n > 0) expect(self.dimensions[d].score, d).toBe(1);
    expect(JSON.stringify(scoreMeasures(ref as Measure, again as Measure))).toBe(JSON.stringify(self));
  });

  it('scores re-encodes close to 1', () => {
    expect((scores.get('crf 35') as Score).composite).toBeGreaterThanOrEqual(REENCODE);
    expect((scores.get('half size') as Score).composite).toBeGreaterThanOrEqual(HALF_SIZE);
  });

  it('lowers structure step by step as a cut moves 1, 3 and 10 frames', () => {
    expect(s('cut +1', 'structure')).toBeGreaterThanOrEqual(s('cut +3', 'structure'));
    expect(s('cut +3', 'structure')).toBeGreaterThan(s('cut +10', 'structure'));
    expect(s('cut +1', 'structure')).toBeGreaterThanOrEqual(1 - SMALL_DROP);
    expect(s('cut +10', 'structure')).toBeLessThanOrEqual(1 - STRUCTURE_DROP);
  });

  it('lowers transitions when one is replaced, motion when an element is late, structure when a shot is missing', () => {
    expect(s('transition replaced', 'transitions')).toBeLessThanOrEqual(1 - TRANSITION_DROP);
    expect(s('element +3', 'motion')).toBeLessThan(s('self', 'motion'));
    expect(s('element +9', 'motion')).toBeLessThan(s('element +3', 'motion'));
    expect(s('element +9', 'motion')).toBeLessThanOrEqual(1 - MOTION_DROP);
    expect(s('shot removed', 'structure')).toBeLessThanOrEqual(1 - SHOT_DROP);
  });

  it('keeps the other dimensions in their band under each damage', () => {
    const others: Array<[Variant, Dimension[]]> = [
      ['cut +10', ['transitions', 'motion', 'colour', 'picture']],
      ['transition replaced', ['structure', 'camera', 'motion', 'colour']],
      ['element +9', ['structure', 'transitions', 'camera', 'colour', 'picture']],
    ];
    for (const [v, dims] of others) for (const d of dims) if ((scores.get(v) as Score).dimensions[d].n > 0) expect(s(v, d), v + ' ' + d).toBeGreaterThanOrEqual(1 - BAND);
  });

  it('scores an unrelated video low', () => {
    expect((scores.get('unrelated') as Score).composite).toBeLessThanOrEqual(UNRELATED);
  });
});

/** What the scorer meets on these clips. */
const REENCODE = 0.9;
const HALF_SIZE = 0.85;
const SMALL_DROP = 0.05;
const STRUCTURE_DROP = 0.15;
const TRANSITION_DROP = 0.2;
const MOTION_DROP = 0.1;
const SHOT_DROP = 0.15;
/** Other dimensions stay within this of 1 under a damage that is not theirs. */
const BAND = 0.2;
const UNRELATED = 0.45;
