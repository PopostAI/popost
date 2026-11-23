/**
 * The transition dimension of compare's shots (score/shot-transition.ts) and where a render's project says the change
 * stands (score/project-windows.ts), on synthetic measures: a reference whose third shot is entered by a whip of 12
 * frames, against a cut, a whip of 10 frames and a dissolve at the same place, and against a render whose whip stands
 * a second late. The picture is read from the change curve, so the other video needs no measured boundary.
 */
import { describe, expect, it } from 'vitest';
import { lookCommand } from '../../src/video/commands/read';
import { changeWindows } from '../../src/video/score/project-windows';
import { compareShots } from '../../src/video/score/shots';
import type { Boundary, Measure, Project } from '../../src/video/types';

const FPS = 30;
const STEP = 3;
type Change = { from: number; to: number; level: number };
const cut = (frame: number): Boundary => ({ frame, kind: 'cut', start: frame - 1, end: frame, confidence: 1 });
const gradual = (frame: number, kind: Boundary['kind'], length: number, extra: Partial<Boundary> = {}): Boundary =>
  ({ frame, kind, start: frame - Math.floor(length / 2), end: frame - Math.floor(length / 2) + length, confidence: 0.9, ...extra });

/** The change curve: a still picture (a hundredth changes) with the given level over the frames of each change. */
const curveOf = (changes: Change[]): number[] =>
  Array.from({ length: 80 }, (_, k) => changes.find((c) => (k + 1) * STEP > c.from && k * STEP < c.to)?.level ?? 0.01);

/** Four shots; no pictures, text or motion, so the change is all that tells the shots apart. */
const measureOf = (boundaries: Boundary[], changes: Change[], lengths = [60, 60, 60, 60]): Measure => ({
  source: { width: 320, height: 180, fps: FPS, frames: 240, duration: 8, hasAudio: false },
  boundaries,
  shots: lengths.map((_n, index) => ({ index, start: lengths.slice(0, index).reduce((a, b) => a + b, 0), end: lengths.slice(0, index + 1).reduce((a, b) => a + b, 0), events: [], background: '#808080', palette: [] })),
  signature: { count: 0, every: 6, width: 8, height: 8 },
  rhythm: { step: STEP, change: curveOf(changes) },
} as unknown as Measure);

const whip = (frame: number, length: number): Boundary => gradual(frame, 'whip', length, { direction: 'left' });
const plateau = (b: Boundary): Change => ({ from: b.start, to: b.end, level: 0.5 });
const spike = (frame: number): Change => ({ from: frame - 1, to: frame + 1, level: 0.9 });

const refWhip = whip(120, 12);
const reference = measureOf([cut(60), refWhip, cut(180)], [spike(60), plateau(refWhip), spike(180)]);
const rebuilt = (third: Boundary): Measure => measureOf([cut(60), third, cut(180)], [spike(60), plateau(third), spike(180)]);
const cutsOnly = measureOf([cut(60), cut(120), cut(180)], [spike(60), spike(120), spike(180)]);
const against = (other: Measure) => compareShots(reference, other, { worst: 3 });
const transition = (other: Measure): number => against(other).shots[2]?.scores.transition ?? -1;

describe('compare: the transition of a shot', () => {
  it('a whip of 12 frames against a cut is a spike against a plateau: low, and in worst by transition with the change in both videos', () => {
    const c = against(cutsOnly);
    expect(c.shots[2]?.scores.transition).toBeLessThan(0.4);
    expect(c.worst[0]).toMatchObject({ shot: 3, by: 'transition' });
    expect(c.worst[0]?.change?.reference.to).toBeGreaterThan(c.worst[0]?.change?.reference.from ?? 1);
    expect(c.worst[0]?.at.reference).toBeCloseTo(((120 - 6 + 0.5) / FPS + (120 + 6 + 0.5) / FPS) / 2, 1);
  });

  it('no boundary measured where the change is drawn inside a scene: the curve scores it', () => {
    expect(transition(measureOf([cut(60), cut(180)], [spike(60), plateau(refWhip), spike(180)]))).toBeGreaterThan(0.9);
    expect(transition(measureOf([cut(60), cut(180)], [spike(60), spike(180)]))).toBeLessThan(0.4);
  });

  it('a whip of 10 frames in the same direction scores high; a dissolve over the same curve scores low', () => {
    expect(transition(rebuilt(whip(120, 10)))).toBeGreaterThan(0.85);
    expect(transition(rebuilt(gradual(120, 'dissolve', 12)))).toBeLessThan(0.45);
  });

  it('a whip toward another direction scores lower than the same direction', () => {
    expect(transition(rebuilt(gradual(120, 'whip', 12, { direction: 'right' })))).toBeLessThan(transition(rebuilt(whip(120, 12))));
  });

  it('a reference whose label leaves much unexplained is not matched by a plain preset the project draws', () => {
    const custom = { ...refWhip, residual: 0.6 };
    const m = measureOf([cut(60), custom, cut(180)], [spike(60), plateau(custom), spike(180)]);
    const windows = [undefined, undefined, { from: 3.82, to: 4.22, declared: { kind: 'whip' as const, direction: 'left' as const, residual: 0 } }];
    const plain = compareShots(m, rebuilt(whip(120, 12)), { windows }).shots[2]?.scores.transition ?? 1;
    expect(plain).toBeLessThan(compareShots(reference, rebuilt(whip(120, 12)), { windows }).shots[2]?.scores.transition ?? 0);
  });

  it('a change that is a cut in the reference has no transition score', () => {
    const c = against(rebuilt(whip(120, 12)));
    expect(c.shots[0]?.scores.transition).toBeUndefined();
    expect(c.shots[1]?.scores.transition).toBeUndefined();
    expect(c.shots[3]?.scores.transition).toBeUndefined();
    expect(c.shots[2]?.scores.transition).toBeGreaterThan(0.95);
  });

  it('the look command of a transition shows several moments across the change in both videos, a plain shot one', () => {
    const worst = against(cutsOnly).worst[0] as ReturnType<typeof against>['worst'][number];
    const words = lookCommand({ reference: 'ref.mp4', other: 'mine.mp4' }, reference, worst)?.split(' ') ?? [];
    const list = (flag: string): number[] => (words[words.indexOf(flag) + 1] ?? '').split(',').map(Number);
    expect(list('--at')).toHaveLength(6);
    const there = list('--against-at');
    expect(there).toHaveLength(6);
    expect(there.every((t, i) => i === 0 || t > (there[i - 1] as number))).toBe(true);
    expect(lookCommand({ reference: 'ref.mp4', other: 'mine.mp4' }, reference, { ...worst, change: undefined })?.split(' ')[4]).not.toContain(',');
  });
});

describe('compare: where the render of a project has the change', () => {
  const project = (frames: number[]): Pick<Project, 'segments' | 'canvas'> => ({
    canvas: { width: 320, height: 180, fps: FPS },
    segments: frames.map((n, k) => ({ id: 'shot-0' + (k + 1), frames: n, ...(k === 2 ? { in: { transition: 'whip', frames: 12, direction: 'left' } } : {}) })),
  } as unknown as Pick<Project, 'segments' | 'canvas'>);

  it('names the change into each reference shot from the segments: a transition by its frames, a cut at the start, none for the first', () => {
    const w = changeWindows(project([60, 60, 60, 60]), 4, 8) ?? [];
    expect(w[0]).toBeUndefined();
    expect(w[1]).toMatchObject({ from: 2, to: 2 });
    expect(w[2]?.declared?.kind).toBe('whip');
    expect(((w[2]?.to ?? 0) - (w[2]?.from ?? 0)) * FPS).toBeCloseTo(12, 5);
    expect(changeWindows(project([60, 60, 60, 60]), 4, 20)).toBeUndefined();
  });

  it('finds a whip a second late by the project, where the share of the length misses it', () => {
    // The render's second shot is a second longer: its whip stands at frame 150, the reference's at 120.
    const late = whip(150, 12);
    const other = measureOf([cut(60), late, cut(210)], [spike(60), plateau(late), spike(210)], [60, 90, 60, 30]);
    const byShare = compareShots(reference, other).shots[2]?.scores.transition ?? 1;
    const windows = changeWindows(project([60, 90, 60, 30]), 4, 8);
    const byProject = compareShots(reference, other, { windows }).shots[2]?.scores.transition ?? 0;
    expect(byShare).toBeLessThan(0.5);
    expect(byProject).toBeGreaterThan(0.85);
  });
});
