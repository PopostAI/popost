/**
 * The one list of what was not recovered of a reference: describe fills it (unrecovered.json, REFERENCE.md), the reader
 * of the frames appends to it in elements.json, a template and a project's record keep it, and compare prints it for
 * the delivery notes. Hand-written measurements and entries only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { describeReference } from '../../src/video/describe/index';
import { unrecoveredFile, unrecoveredLine, unrecoveredOf } from '../../src/video/describe/unrecovered';
import { checkElements } from '../../src/video/elements/check';
import { readElements } from '../../src/video/elements/read';
import { factsOf } from '../../src/video/template/facts';
import { loadTemplate } from '../../src/video/template/save';
import type { Measure, ShotMeasure, Trajectory, Unrecovered } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);
const put = async (file: string, value: unknown): Promise<void> => { await mkdir(path.dirname(at(file)), { recursive: true }); await writeFile(at(file), JSON.stringify(value)); };

const shot = (index: number, start: number, end: number, camera: ShotMeasure['camera']['kind'] = 'static'): ShotMeasure =>
  ({ index, start, end, camera: { kind: camera, zoomPerS: 0, panPerS: [0, 0], confidence: camera === 'unknown' ? 0 : 0.8 }, background: '#101820', palette: [{ hex: '#101820', share: 0.7 }], events: [] });
const path2 = (edge: 'wedge' | 'irregular'): Trajectory => ({
  id: 'transition-02', of: 'transition', shot: 2, what: 'object', method: 'reveal-front', start: 36, end: 72,
  samples: [{ frame: 36, centre: [0.06, 0.5], size: [0.15, 0.3] }, { frame: 72, centre: [0.95, 0.5], size: [0.15, 0.3] }],
  path: { from: [0.06, 0.5], to: [0.95, 0.5], angle: 0, length: 0.89, speed: 0.74, straightness: 1, ease: 'linear' }, size: [0.15, 0.3],
  reveal: { start: 34, end: 88, edge: { shape: edge, fit: edge === 'wedge' ? 0.93 : 0.55, share: 0.9, ...(edge === 'wedge' ? { angle: 0, spread: 45 } : {}) } }, confidence: 0.88,
});
/** Three shots at 30 fps with sound: a change with a measured path, then a wipe that nothing explains; the first camera could not be read. */
const measure = (edge: 'wedge' | 'irregular' = 'wedge'): Measure => ({
  version: 1, source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [
    { frame: 60, kind: 'slide', mode: 'cover', direction: 'right', start: 50, end: 70, confidence: 0.76, residual: 0.07, bend: 0 },
    { frame: 180, kind: 'wipe', direction: 'up', start: 170, end: 190, confidence: 0.21, residual: 0.38, bend: 0 },
  ],
  shots: [shot(0, 0, 60, 'unknown'), shot(1, 60, 180), shot(2, 180, 300)], tracks: [path2(edge)],
  rhythm: { step: 3, change: Array.from({ length: 100 }, () => 0.01) }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
});

const layers = [{ id: 'ground', kind: 'ground', box: [0, 0, 1, 1], look: 'flat dark blue', role: 'design' }];
const CUSTOM = { kind: 'custom', seconds: 1.8, description: 'An object flies level across and the next picture opens as a wedge behind it.' };
const elements = (extra: Record<string, unknown> = {}, third: Record<string, unknown> = {}): Record<string, unknown> => ({
  shots: [
    { shot: 1, time: [0, 2], layout: 'a title card', layers },
    { shot: 2, time: [2, 6], layout: 'a title card', layers, transitionIn: CUSTOM },
    { shot: 3, time: [6, 10], layout: 'a title card', layers, transitionIn: { kind: 'custom', seconds: 0.6, description: 'Tiles flip over from the bottom row up.' }, ...third },
  ],
  ...extra,
});
const OWN: Unrecovered = { what: 'what the small label under the title says', where: { shot: 3 }, why: 'too small to read in the frames', assumed: 'left out of the re-make' };

describe('what describe did not recover', () => {
  it('lists a change nothing explains, a camera that could not be read and what no tool read, each with where, why and how to settle it', () => {
    const list = unrecoveredOf(measure());
    expect(list.map((u) => u.what)).toEqual(['how shot 03 begins: the kind of the change and the path of what moves in it', 'the camera of shot 01', 'the on-screen text: captions, titles, labels, watermarks', 'what is said']);
    expect(list[0]).toMatchObject({ where: { transition: 3, time: [5.7, 6.33] }, by: 'measurement' });
    expect(list[0]?.why).toContain('no standard transition explains the frames');
    expect(list[0]?.settle).toContain('transitions/03.jpg');
    expect(list[1]).toMatchObject({ where: { shot: 1, time: [0, 2] } });
    expect(list.every((u) => u.why && u.settle)).toBe(true);
    // The change whose path was measured is recovered, whatever its label; with an edge no model fits, the edge is not.
    expect(list.some((u) => u.where.transition === 2)).toBe(false);
    expect(unrecoveredOf(measure('irregular')).filter((u) => u.where.transition === 2).map((u) => u.what)).toEqual(['how shot 02 begins: the kind of the change', 'the shape of the edge that opens shot 02']);
    // A silent video does not miss its speech; a reading with a text reader does not miss its text.
    const silent = { ...measure(), source: { ...measure().source, hasAudio: false } };
    expect(unrecoveredOf(silent, { text: { step: 6, sampled: 10, cues: [] } }).map((u) => u.what)).toEqual(['how shot 03 begins: the kind of the change and the path of what moves in it', 'the camera of shot 01']);
  });

  it('is printed in REFERENCE.md under one heading and returned for unrecovered.json', () => {
    const d = describeReference(measure(), undefined, 'reference');
    const card = d.files['REFERENCE.md'] ?? '';
    expect(card).toContain('## Not recovered');
    expect(card).not.toContain('## Open questions');
    expect(card).toContain('- the change into shot 03 (5.70-6.33 s): how shot 03 begins: the kind of the change and the path of what moves in it. Why: no standard transition explains the frames');
    expect(card).toContain('- shot 01 (0.00-2.00 s): the camera of shot 01. Why: the frames could not be laid onto each other');
    expect(card).toContain('- the whole video: what is said. Why: no transcriber was available.');
    expect(d.unrecovered).toHaveLength(4);
    expect(unrecoveredFile(d.unrecovered)).toMatchObject({ version: 1, unrecovered: [{ where: { transition: 3 } }, {}, {}, {}] });
    expect(unrecoveredLine(OWN)).toBe('- shot 03: what the small label under the title says. Why: too small to read in the frames. Assumed instead: left out of the re-make.');
  });
});

describe('what the reader adds in elements.json', () => {
  it('keeps well-formed entries as the reader\'s, refuses one without what, where or why, and asks what is assumed instead', () => {
    const read = readElements(elements({ unrecovered: [OWN, { what: 'the easing of the tiles', where: { transition: 3 }, why: 'between two frames' }, { what: 'no place', why: 'x' }] }));
    expect(read.elements.unrecovered).toEqual([{ ...OWN, by: 'reader' }, { what: 'the easing of the tiles', where: { transition: 3 }, why: 'between two frames', by: 'reader' }]);
    expect(read.problems.map((p) => p.level + ' ' + p.at)).toEqual(['warning unrecovered[1].assumed', 'error unrecovered[2]']);
    expect(readElements(elements()).elements.unrecovered).toBeUndefined();
    expect(readElements(elements({ unrecovered: 'none' })).problems.map((p) => p.at)).toEqual(['unrecovered']);
  });

  it('warns when a field is labelled unknown and the list has no entry for its shot', () => {
    const unknown = { layers: [{ ...layers[0], status: { look: 'unknown' } }] };
    const bare = checkElements(readElements(elements({}, unknown)), measure()).problems;
    expect(bare.map((p) => p.level + ' ' + p.at)).toEqual(['warning shots[2].status']);
    expect(bare[0]?.message).toBe('"look" of layer "ground" of shot 3 is labelled "unknown", and "unrecovered" has no entry for shot 3.');
    expect(checkElements(readElements(elements({ unrecovered: [OWN] }, unknown)), measure()).problems).toEqual([]);
  });
});

describe('the list is carried to the template, the project and compare', () => {
  it('template save keeps describe\'s list and the reader\'s, template show prints it, the project\'s record holds it', async () => {
    const m = measure();
    await put('ref/measure.json', m);
    await put('ref/unrecovered.json', unrecoveredFile(unrecoveredOf(m)));
    await put('ref/elements.json', elements({ unrecovered: [OWN] }));
    expect((await runCli(rt, ['video', 'elements', 'check', 'ref'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, notRecovered: { reading: 4, added: 1 } });
    const saved = await runCli(rt, ['video', 'template', 'save', 'ref', '--out', 'tpl', '--name', 'cards']);
    expect(saved.code, saved.stdout).toBe(0);
    const pkg = await loadTemplate(rt, at('tpl'));
    expect(pkg.template.unrecovered?.map((u) => u.by)).toEqual(['measurement', 'measurement', 'measurement', 'measurement', 'reader']);
    expect((await runCli(rt, ['video', 'template', 'show', 'tpl'])).code).toBe(0);
    expect((rt.json() as { notRecovered: Unrecovered[] }).notRecovered[4]).toMatchObject({ what: OWN.what, assumed: OWN.assumed });
    const facts = factsOf(rt, pkg, { version: 1, canvas: pkg.template.canvas, materials: [], segments: [], tracks: [] }, at('project'));
    expect(facts.unrecovered).toHaveLength(5);
    // A reference without a list leaves the key out of the template.
    await put('bare/measure.json', m);
    expect((await runCli(rt, ['video', 'template', 'save', 'bare', '--out', 'tpl-bare', '--name', 'cards'])).code).toBe(0);
    expect(JSON.parse(await readFile(at('tpl-bare/template.json'), 'utf8'))).not.toHaveProperty('unrecovered');
  });

  it('compare prints the list of a reference given as the measure.json describe wrote, for the delivery notes', async () => {
    const r = await runCli(rt, ['video', 'compare', 'ref/measure.json', 'ref/measure.json']);
    expect(r.code, r.stdout).toBe(0);
    const out = rt.json() as { notRecovered: { entries: Unrecovered[]; note: string } };
    expect(out.notRecovered.entries.map((u) => u.by)).toEqual(['measurement', 'measurement', 'measurement', 'measurement', 'reader']);
    expect(out.notRecovered.note).toContain('The delivery notes list every entry');
    expect((await runCli(rt, ['video', 'compare', 'bare/measure.json', 'bare/measure.json'])).code).toBe(0);
    expect(rt.json()).not.toHaveProperty('notRecovered');
  });
});
