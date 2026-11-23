/**
 * Transitions are scored on paired boundaries. A render re-timed to its voice, or shifted by a few frames, paired none
 * of its boundaries with the reference's by time (within two frames): b3 got "transitions 0" for a render that showed
 * every one of the reference's 16 transitions. A whole render a few frames late pairs after one offset (at most 0.5 s,
 * the one that pairs the most boundaries; structure reports it); a re-timed one pairs in order by share of the length,
 * each span compared with the other's moved onto it. A render with the reference's timing is scored as before.
 */
import { describe, expect, it } from 'vitest';
import { structure, transitions } from '../../src/video/score/time';
import type { Boundary, Measure } from '../../src/video/types';

/** The b3 shape: 17 shots of 9 to 156 frames, blur, wipes, dissolves, fades via black and two cuts. */
const LENGTHS = [96, 156, 45, 72, 30, 120, 9, 60, 84, 40, 66, 110, 24, 90, 50, 132, 72];
const JOINS: Array<Omit<Boundary, 'frame' | 'start' | 'end' | 'confidence'> & { frames: number }> = [
  { kind: 'blur', frames: 15 }, { kind: 'wipe', frames: 22, direction: 'left' }, { kind: 'dissolve', frames: 25 }, { kind: 'fade', frames: 12, via: 'black' },
  { kind: 'wipe', frames: 11 }, { kind: 'cut', frames: 1 }, { kind: 'dissolve', frames: 3 }, { kind: 'blur', frames: 14 }, { kind: 'wipe', frames: 11, direction: 'up' },
  { kind: 'fade', frames: 27, via: 'black' }, { kind: 'dissolve', frames: 8 }, { kind: 'wipe', frames: 6, direction: 'right' }, { kind: 'fade', frames: 5, via: 'black' },
  { kind: 'dissolve', frames: 15 }, { kind: 'cut', frames: 1 }, { kind: 'dissolve', frames: 10 },
];

const measureOf = (lengths: number[]): Measure => {
  const starts = lengths.reduce<number[]>((s, n) => [...s, (s[s.length - 1] ?? 0) + n], []);
  const frames = starts[starts.length - 1] ?? 0;
  const boundaries = JOINS.map(({ frames: f, ...j }, k): Boundary => {
    const at = starts[k] as number, half = Math.floor(f / 2);
    return { ...j, frame: at, start: j.kind === 'cut' ? at - 1 : at - half - 1, end: j.kind === 'cut' ? at : at + f - half, confidence: 0.9 } as Boundary;
  });
  return {
    version: 1, source: { width: 1184, height: 720, fps: 30, frames, duration: frames / 30, hasAudio: false }, boundaries,
    shots: lengths.map((n, k) => ({ index: k, start: (starts[k] ?? n) - n, end: starts[k] as number, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#101820', palette: [], events: [] })),
    rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
  } as Measure;
};
const TOL = 2 / 30;

describe('transitions of a render with other timing', () => {
  const ref = measureOf(LENGTHS);

  it('scores the reference against itself by time, as before', () => {
    const s = transitions(ref, ref, TOL);
    expect(s).toMatchObject({ score: 1, n: 16 });
    expect(s.detail).not.toHaveProperty('pairedBy');
  });

  it('pairs a render re-timed to its voice by share of the length, every transition in its place', () => {
    const reflowed = measureOf(LENGTHS.map((n, k) => Math.round(n * (1.05 + (0.2 * ((k * 7) % 5)) / 4))));
    const s = transitions(ref, reflowed, TOL);
    expect(s.n).toBe(16);
    expect(s.detail).toMatchObject({ pairedBy: 'share of the length', kind: 1, exactKind: 16 });
    expect(s.score).toBeGreaterThan(0.95);
  });

  it('pairs a render shifted by three frames after the offset, and still finds a replaced transition', () => {
    const shifted = measureOf([LENGTHS[0] as number + 3, ...LENGTHS.slice(1)]);
    const same = transitions(ref, shifted, TOL);
    expect(same).toMatchObject({ score: 1, n: 16 });
    expect(same.detail).not.toHaveProperty('pairedBy');
    const replaced = { ...shifted, boundaries: shifted.boundaries.map((b, k) => (k === 2 ? { ...b, kind: 'cut' as const, start: b.frame - 1, end: b.frame } : b)) };
    const s = transitions(ref, replaced, TOL);
    expect(s.n).toBe(16);
    expect(s.detail.exactKind).toBe(15);
    expect(s.score).toBeLessThan(1);
  });

  it('scores low against a video of plain cuts elsewhere', () => {
    const cuts = measureOf([300, 300, ...Array.from({ length: 15 }, () => 44)]);
    const other = { ...cuts, boundaries: cuts.boundaries.map((b) => ({ frame: b.frame, kind: 'cut' as const, start: b.frame - 1, end: b.frame, confidence: 1 })) };
    expect(transitions(ref, other, TOL).score).toBeLessThan(0.5);
  });
});

describe('structure of a render shifted as a whole', () => {
  const ref = measureOf(LENGTHS);

  it('finds no offset against itself', () => {
    const s = structure(ref, ref, TOL);
    expect(s.detail).toMatchObject({ f1: 1, paired: 16, timing: 1 });
    expect(s.detail).not.toHaveProperty('offset');
  });

  it('pairs every boundary of a render three frames late after one offset of 0.1 s, and says so', () => {
    const s = structure(ref, measureOf([LENGTHS[0] as number + 3, ...LENGTHS.slice(1)]), TOL);
    expect(s.detail).toMatchObject({ offset: 0.1, f1: 1, paired: 16, timing: 1 });
  });

  it('takes no offset past half a second, nor one that pairs no more than none does', () => {
    const late = structure(ref, measureOf([LENGTHS[0] as number + 20, ...LENGTHS.slice(1)]), TOL);
    expect(late.detail).toMatchObject({ paired: 0 });
    expect(late.detail).not.toHaveProperty('offset');
    const half = structure(ref, measureOf(LENGTHS.map((n, k) => (k === 8 ? n + 3 : n))), TOL);
    expect(half.detail).toMatchObject({ paired: 8 });
    expect(half.detail).not.toHaveProperty('offset');
  });
});
