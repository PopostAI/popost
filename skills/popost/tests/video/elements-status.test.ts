/**
 * How each value is known: the labels of the reading (measure.json "known", the tags in describe's files) and the labels
 * of elements.json ("status" per field), which the elements check holds to the reading. Hand-written measurements and
 * entries only.
 */
import { describe, expect, it } from 'vitest';
import { describeReference } from '../../src/video/describe/index';
import { knownOf, tag } from '../../src/video/describe/known';
import { tracksFile } from '../../src/video/describe/paths';
import { checkElements } from '../../src/video/elements/check';
import { questionShots } from '../../src/video/elements/questions';
import { readElements } from '../../src/video/elements/read';
import type { Measure, Problem, ShotMeasure, Trajectory } from '../../src/video/types';

const shot = (index: number, start: number, end: number, camera: ShotMeasure['camera']['kind'] = 'static'): ShotMeasure =>
  ({ index, start, end, camera: { kind: camera, zoomPerS: 0, panPerS: [0, 0], confidence: camera === 'unknown' ? 0 : 0.8 }, background: '#101820', palette: [{ hex: '#101820', share: 0.7 }], events: index === 1 ? [{ start: 70, end: 80, box: [0.1, 0.1, 0.3, 0.1], kind: 'appear', how: 'fade', confidence: 0.9 }] : [] });

/** The change into shot 2 as a path: an object crosses level in 1.2 s and the new picture opens as a wedge over 1.8 s. */
const PATH: Trajectory = {
  id: 'transition-02', of: 'transition', shot: 2, what: 'object', method: 'reveal-front', start: 36, end: 72,
  samples: [{ frame: 36, centre: [0.06, 0.5], size: [0.15, 0.3], cover: 0.02 }, { frame: 72, centre: [0.95, 0.5], size: [0.15, 0.3], cover: 0.6 }],
  path: { from: [0.06, 0.5], to: [0.95, 0.5], angle: 0, length: 0.89, speed: 0.74, straightness: 1, ease: 'linear' }, size: [0.15, 0.3],
  reveal: { start: 34, end: 88, edge: { shape: 'wedge', fit: 0.93, share: 0.9, angle: 0, spread: 45 } }, confidence: 0.88,
};

/** Four shots at 30 fps: a slide that fits (with the path above), a dissolve that fits, a wipe nothing explains. */
const MEASURE: Measure = {
  version: 1, source: { width: 1280, height: 720, fps: 30, frames: 360, duration: 12, hasAudio: false },
  boundaries: [
    { frame: 60, kind: 'slide', mode: 'cover', direction: 'right', start: 50, end: 70, confidence: 0.76, residual: 0.07, bend: 0 },
    { frame: 150, kind: 'dissolve', start: 144, end: 155, confidence: 0.9, residual: 0.05 },
    { frame: 240, kind: 'wipe', direction: 'up', start: 230, end: 250, confidence: 0.21, residual: 0.38, bend: 0 },
  ],
  shots: [shot(0, 0, 60, 'unknown'), shot(1, 60, 150), shot(2, 150, 240), shot(3, 240, 360)],
  tracks: [PATH],
  rhythm: { step: 3, change: Array.from({ length: 120 }, () => 0.01) }, motion: { step: 2, amount: Array.from({ length: 179 }, () => 2) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};

const layers = [{ id: 'ground', kind: 'ground', box: [0, 0, 1, 1], look: 'flat dark blue', role: 'design' }];
const entry = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ shot: n, time: [[0, 2], [2, 5], [5, 8], [8, 12]][n - 1], layout: 'a title card', layers, ...(n > 1 ? { transitionIn: { kind: 'cut' } } : {}), ...extra });
const file = (second: Record<string, unknown>, third: Record<string, unknown> = { kind: 'dissolve', seconds: 0.33 }, first: Record<string, unknown> = {}): unknown =>
  ({ shots: [entry(1, first), entry(2, { transitionIn: second }), entry(3, { transitionIn: third }), entry(4, { transitionIn: { kind: 'custom', seconds: 0.6, description: 'Tiles flip over one after another from the bottom row up.' } })] });
const problems = (raw: unknown): Problem[] => checkElements(readElements(raw), MEASURE).problems;
const places = (raw: unknown): string[] => problems(raw).map((p) => p.level + ' ' + p.at);
const CUSTOM = { kind: 'custom', seconds: 1.8, description: 'An object flies level from the left edge to the right and the next picture opens as a wedge behind it.' };

describe('how the values of a reading are known', () => {
  it('labels every value by its path: measured with its confidence, inferred when no model fits, unknown with the reason', () => {
    const known = knownOf(MEASURE);
    // The slide's model fits, but the path measured for the change is an effect of its own: the kind is a guess.
    expect(known['boundaries[0].kind']).toMatchObject({ status: 'inferred', confidence: 0.76, basis: 'its measured path is an effect of its own (an object leads it); slide is the nearest standard kind' });
    expect(known['boundaries[1].kind']).toMatchObject({ status: 'measured', confidence: 0.9 });
    expect(known['boundaries[2].kind']).toMatchObject({ status: 'inferred', confidence: 0.21 });
    expect(known['boundaries[2].kind']?.basis).toContain('no standard transition explains the frames (38% of the change unexplained); wipe is the nearest');
    expect(known['boundaries[2].path']).toMatchObject({ status: 'unknown' });
    expect(known['boundaries[0].path']).toBeUndefined();
    expect(known['shots[0].camera']).toMatchObject({ status: 'unknown' });
    expect(known['shots[1].camera']).toMatchObject({ status: 'measured', confidence: 0.8 });
    expect(known['shots[1].events[0]']).toMatchObject({ status: 'measured', confidence: 0.9 });
    expect(known['tracks[0]']).toEqual({ status: 'measured', confidence: 0.88, basis: 'reveal-front' });
    expect(known['tracks[0].reveal.edge']).toMatchObject({ status: 'measured', confidence: 0.93 });
    expect(Object.values(known).every((s) => ['measured', 'inferred', 'unknown'].includes(s.status) && typeof s.basis === 'string')).toBe(true);
    expect(tag({ status: 'unknown', basis: 'why' })).toBe(' [unknown: why]');
    expect(tracksFile(MEASURE)).toMatchObject({ known: { 'transition-02': { status: 'measured' }, 'transition-02.edge': { status: 'measured' } } });
  });

  it('describe prints the same labels as tags, and the card says what they mean', () => {
    const d = describeReference(MEASURE, undefined, 'reference');
    expect(d.files['REFERENCE.md']).toContain('Every value says how it is known, in square brackets');
    expect(d.files['shots/02.md']).toMatch(/- In: slide cover right 19f, mixed on frames 51-69, confidence 0\.76 \[inferred 0\.76: its measured path is an effect of its own/);
    expect(d.files['shots/02.md']).toMatch(/- Out: dissolve 10f \[measured 0\.90\]/);
    expect(d.files['shots/02.md']).toMatch(/- Camera: still \(confidence 0\.80\) \[measured 0\.80\]/);
    expect(d.files['shots/02.md']).toMatch(/appear, fade \[measured 0\.90\]/);
    expect(d.files['shots/02.md']).toMatch(/By reveal-front\. \[measured 0\.88\]/);
    expect(d.files['shots/01.md']).toMatch(/- Camera: unknown \[unknown: the frames could not be laid onto each other/);
    expect(d.files['shots/04.md']).toMatch(/- In: wipe up 19f \(does not fit well.*\[inferred 0\.21: no standard transition explains the frames/);
    expect(d.files['shots/04.md']).toMatch(/- Path of the change in: \[unknown: the pictures move or mix during the change/);
    // The shot whose change has a path does not say its path is unknown.
    expect(d.files['shots/02.md']).not.toContain('Path of the change in:');
  });

  it('the questions for the reader give the measured path of a change beside its label', () => {
    expect(questionShots(MEASURE)[1]?.in).toBe('slide cover right 19f; measured path: an object at 0 degrees leads a wedge edge, 1.80 s (shots/02.md, "Paths")');
  });
});

describe('the labels of elements.json', () => {
  it('a file without labels is valid as before, and is counted as unlabelled', () => {
    const r = checkElements(readElements(file(CUSTOM)), MEASURE);
    expect(r.problems).toEqual([]);
    expect(r.labels).toEqual({ measured: 0, inferred: 0, unknown: 0, unlabelledShots: [1, 2, 3, 4] });
  });

  it('keeps well-formed labels on a shot, a layer and a change, and counts them', () => {
    const raw = file({ ...CUSTOM, status: { kind: 'inferred', seconds: 'measured' } }, { kind: 'dissolve', seconds: 0.33, status: { kind: 'measured' } },
      { status: { time: 'measured', layout: 'inferred' }, layers: [{ ...layers[0], status: { box: 'measured', look: { status: 'inferred', note: 'the blue may be a gradient' }, enters: 'unknown' } }] });
    const read = readElements(raw);
    expect(read.problems).toEqual([]);
    expect(read.elements.shots[0]?.status).toEqual({ time: 'measured', layout: 'inferred' });
    expect(read.elements.shots[0]?.layers[0]?.status).toEqual({ box: 'measured', look: { status: 'inferred', note: 'the blue may be a gradient' }, enters: 'unknown' });
    expect(read.elements.shots[1]?.transitionIn?.status).toEqual({ kind: 'inferred', seconds: 'measured' });
    const r = checkElements(read, MEASURE);
    // The one field labelled unknown asks for its entry in "unrecovered" (unrecovered.test.ts).
    expect(r.problems.map((p) => p.level + ' ' + p.at)).toEqual(['warning shots[0].status']);
    expect(r.labels).toEqual({ measured: 4, inferred: 3, unknown: 1, unlabelledShots: [4] });
  });

  it('refuses a label that is not one of the three words, and ignores a label of no field', () => {
    const p = problems(file({ ...CUSTOM, status: { kind: 'guessed', path: 'measured' } }, undefined, { status: 'measured' }));
    // The change whose label is wrong is left out of its shot, which then does not say how it begins.
    expect(p.map((x) => x.level + ' ' + x.at)).toEqual(['error shots[0].status', 'error shots[1].transitionIn.status.kind', 'warning shots[1].transitionIn.status.path', 'warning shots[1].transitionIn']);
    expect(p[1]?.allowed).toEqual(['measured', 'inferred', 'unknown']);
  });

  it('warns when the length of a change contradicts the measured one without a note, labelled or not', () => {
    const off = problems(file({ ...CUSTOM, seconds: 0.8 }));
    expect(off.map((p) => p.level + ' ' + p.at)).toEqual(['warning shots[1].transitionIn.seconds']);
    expect(off[0]?.message).toBe('The change into shot 2 lasts 1.80 s in the measurement (its path, frames 34-88), and the entry says 0.8 s.');
    expect(off[0]?.fix).toContain('Copy 1.80 with "status": {"seconds": "measured"}');
    expect(places(file({ ...CUSTOM, seconds: 0.8, status: { seconds: 'measured' } }))).toEqual(['warning shots[1].transitionIn.seconds']);
    expect(places(file({ ...CUSTOM, seconds: 0.8, status: { seconds: { status: 'inferred', note: 'the frames show the wedge closed by 0.9 s' } } }))).toEqual([]);
    // Within the tolerance, and a change with no path held to its mixed frames (10 of them: 0.33 s).
    expect(places(file({ ...CUSTOM, seconds: 1.6 }))).toEqual([]);
    expect(places(file(CUSTOM, { kind: 'dissolve', seconds: 1.2 }))).toEqual(['warning shots[2].transitionIn.seconds']);
  });

  it('warns when a change the measurement followed as an effect of its own, or read with a model that fits, is called something else without a reason', () => {
    const led = problems(file({ kind: 'wipe', seconds: 1.8 }));
    expect(led.map((p) => p.at)).toEqual(['shots[1].transitionIn.kind']);
    expect(led[0]?.message).toContain('as an effect of its own (an object at 0 degrees leads a wedge edge, 1.80 s), and the entry calls it "wipe" without saying why');
    expect(places(file({ kind: 'wipe', seconds: 1.8, description: 'A plain edge crosses; the object is part of the footage.' }))).toEqual([]);
    expect(places(file(CUSTOM, { kind: 'fade', seconds: 0.33 }))).toEqual(['warning shots[2].transitionIn.kind']);
    expect(places(file(CUSTOM, { kind: 'fade', seconds: 0.33, status: { kind: { status: 'inferred', note: 'the picture dips to black on two frames' } } }))).toEqual([]);
    expect(places(file(CUSTOM, { kind: 'fade', seconds: 0.33, description: 'It dips to black.', status: { kind: 'measured' } }))).toEqual(['warning shots[2].transitionIn.status.kind']);
  });

  it('warns when a field the reading does not measure is labelled measured', () => {
    const p = problems(file(CUSTOM, undefined, { status: { job: 'measured' }, layers: [{ ...layers[0], content: 'a ground', status: { content: 'measured', box: 'measured' } }] }));
    expect(p.map((x) => x.level + ' ' + x.at)).toEqual(['warning shots[0].status.job', 'warning shots[0].layers[0].status.content']);
    expect(p[0]?.fix).toContain('"job": "inferred"');
  });
});
