/**
 * Whether a shot keeps moving or enters and then holds (measure/amount.ts, activityIn), what describe says of it
 * (describe/movement.ts), and the named problem of a re-make that stands still where its reference moves throughout
 * (measure/still-shots.ts). The measurements are built by hand: a curve of motion amounts per shot.
 */
import { describe, expect, it } from 'vitest';
import { describeReference } from '../../src/video/describe/index';
import { activityIn, shotActivity } from '../../src/video/measure/amount';
import { stillProblems } from '../../src/video/measure/still-shots';
import { compareShots } from '../../src/video/score/shots';
import type { Measure, ShotMeasure } from '../../src/video/types';

const shot = (index: number, start: number, end: number): ShotMeasure => ({ index, start, end, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#000000', palette: [], events: [] });
/** Shots of 60 frames at 30 fps; each shot's amounts are given by a function of the pair's index in it (0..28). */
const measured = (...shots: ((k: number) => number)[]): Measure => ({
  version: 1,
  source: { width: 180, height: 320, fps: 30, frames: 60 * shots.length, duration: 2 * shots.length, hasAudio: false },
  boundaries: shots.slice(1).map((_s, i) => ({ frame: 60 * (i + 1), kind: 'cut' as const, start: 60 * (i + 1) - 1, end: 60 * (i + 1), confidence: 1 })),
  shots: shots.map((_s, i) => shot(i, 60 * i, 60 * (i + 1))),
  rhythm: { step: 3, change: [] },
  motion: { step: 2, amount: Array.from({ length: 30 * shots.length - 1 }, (_v, k) => (k % 30 === 29 ? 90 : (shots[Math.floor(k / 30)] as (k: number) => number)(k % 30))) },
  signature: { every: 6, width: 8, height: 8, count: 0, data: '' },
});
const moving = (): number => 6, entering = (k: number): number => (k < 5 ? 9 : 0.1), still = (): number => 0.1, late = (k: number): number => (k > 18 ? 5 : 0.1);

describe('when a shot moves', () => {
  const m = measured(moving, entering, still, late);

  it('tells a shot that moves throughout from one that enters then holds, one that moves in parts and a still one', () => {
    expect(shotActivity(m, 0)).toEqual({ kind: 'moves throughout', moving: 1, pairs: 29 });
    expect(shotActivity(m, 1)).toEqual({ kind: 'enters then holds', moving: 0.17, pairs: 29, stillFrom: 0.33 });
    expect(shotActivity(m, 2)).toEqual({ kind: 'still', moving: 0, pairs: 29, stillFrom: 0 });
    expect(shotActivity(m, 3)?.kind).toBe('moves in parts');
    expect(activityIn({ ...m, motion: undefined }, 0, 60)).toBeUndefined();
  });

  it('is said in the description, with the frame strips that must be opened', () => {
    const d = describeReference(m, undefined, 'reference', undefined, undefined, { pictures: true });
    expect(d.files['shots/01.md']).toContain('- Movement: moves throughout (motion on 100% of its frames). Open shots/01-frames.jpg before writing this scene, and read video-motion.md');
    expect(d.files['shots/02.md']).toContain('- Movement: enters then holds (motion on 17% of its frames; still from 0.33 s into the shot)');
    expect(d.files['shots/03.md']).toContain('- Movement: still');
    expect(d.files['timeline.md']).toMatch(/#01 .*MOVES THROUGHOUT \(100% of its frames\)/);
    expect(d.files['timeline.md']).toMatch(/#02 .*enters then holds/);
    expect(d.files['REFERENCE.md']).toContain('- Movement: 1 of 4 shots move throughout (#01)');
    expect(d.files['REFERENCE.md']).toContain('open its shots/NN-frames.jpg and read video-motion.md');
    // No shot moves throughout: nothing to open.
    expect(describeReference(measured(entering, still), undefined, 'reference').files['REFERENCE.md']).not.toContain('- Movement:');
  });
});

describe('a re-make that stands still where its reference moves', () => {
  it('is a named problem with a fix for each such shot, and for no other', () => {
    const ref = measured(moving, moving, entering), mine = measured(entering, moving, still);
    const shots = compareShots(ref, mine).shots;
    const problems = stillProblems(ref, mine, shots);
    expect(problems.map((p) => [p.shot, p.name])).toEqual([[1, 'still-while-reference-moves']]);
    expect(problems[0]).toMatchObject({ reference: { moving: 1 }, other: { moving: 0.17, still: 0.83, stillFrom: 0.33 } });
    expect(problems[0]?.message).toBe('Shot 1 stands still for 83% of its length (nothing moves after 0.33 s into it), while the reference shot moves throughout (motion on 100% of its frames).');
    expect(problems[0]?.fix).toMatch(/shots\/01-frames\.jpg.*video-motion\.md.*to be fixed, not noted/);
    // Still for a third of the shot is within what a re-make may be.
    const partly = measured((k) => (k < 20 ? 6 : 0.1), moving, entering);
    expect(stillProblems(ref, partly, compareShots(ref, partly).shots)).toEqual([]);
  });
});
