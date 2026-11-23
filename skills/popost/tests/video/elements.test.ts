/**
 * The reading of the frames (elements.json): its shape and its findings against the measurement, the questions for any
 * reader, the template that carries it (layers kept, replaced and dropped, an effect of its own as custom, the end card
 * left out), a fill that holds the effect without a script, and the checks of a fill and of a project that use it.
 * Synthetic measurements and hand-written readings only: no real video's words.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { roughTokens } from '../../src/video/describe/index';
import { cardBudget } from '../../src/video/template/card';
import { checkElements } from '../../src/video/elements/check';
import { withReading } from '../../src/video/elements/carry';
import { fillReadingProblems, projectReadingProblems, type ReadingFacts } from '../../src/video/elements/findings';
import { readElements } from '../../src/video/elements/read';
import type { Elements, Layer, ShotReading } from '../../src/video/elements/types';
import type { Template } from '../../src/video/template/types';
import { templateFrom } from '../../src/video/template/structure';
import type { TextTrack } from '../../src/video/text/types';
import { TRANSITION_KINDS, type Box, type Measure, type Problem, type Project } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);
const put = async (file: string, text: string): Promise<void> => { await mkdir(path.dirname(at(file)), { recursive: true }); await writeFile(at(file), text); };
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(at(file), 'utf8')) as T;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#1d2b53', palette: [{ hex: '#1d2b53', share: 0.6 }], events: [] });

/**
 * A reference of four shots at 30 fps, 1280x720: a title card, a recording, a second recording, an end card. The change
 * into shot 2 is labelled a slide whose model leaves much unexplained (it does not fit), the one into shot 3 a dissolve
 * that fits, the one into shot 4 a cut.
 */
const MEASURE: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [
    { frame: 60, kind: 'slide', mode: 'cover', direction: 'right', start: 52, end: 68, confidence: 0.8, residual: 0.35, bend: 0.16 },
    { frame: 150, kind: 'dissolve', start: 145, end: 155, confidence: 0.9, residual: 0.05 },
    { frame: 240, kind: 'cut', start: 239, end: 240, confidence: 1 },
  ],
  shots: [shot(0, 0, 60), shot(1, 60, 150), shot(2, 150, 240), shot(3, 240, 300)],
  rhythm: { step: 3, change: Array.from({ length: 100 }, () => 0.01) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};

const BAND: Box = [0.2, 0.85, 0.6, 0.06];
const MARK: Box = [0.76, 0.03, 0.2, 0.04];
const cue = (text: string, start: number, end: number, role: 'caption' | 'watermark' | 'label' = 'caption', box: Box = BAND) => ({ text, start, end, box, role, size: box[3], samples: 4, confidence: 0.95 });
/** Captions in the first three shots, a watermark through the video, an account line on the end card. */
const TEXT: TextTrack = {
  step: 6, sampled: 50,
  cues: [cue('Notes get lost', 0, 55), cue('One switch keeps them', 62, 140), cue('Everywhere you work', 156, 232),
    cue('@acme.notes', 0, 300, 'watermark', MARK), cue('Follow @acme.notes for more', 246, 300, 'label', [0.3, 0.6, 0.4, 0.05])],
};

const layer = (id: string, kind: Layer['kind'], box: Box, role: Layer['role'], extra: Partial<Layer> = {}): Layer => ({ id, kind, box, look: 'a look for ' + id, content: 'what ' + id + ' shows', role, ...extra });
const ground = layer('ground', 'ground', [0, 0, 1, 1], 'design');
const mark = layer('mark', 'platform', [0.75, 0.02, 0.22, 0.06], 'platform');
const captions = layer('captions', 'caption', [0.18, 0.83, 0.64, 0.1], 'design');

/** A reading of the four shots that the check finds nothing in. */
const GOOD: Elements = {
  shots: [
    { shot: 1, time: [0, 2], job: 'hook', layout: 'a title card on a flat ground', sameEffectAsNext: true, layers: [ground, layer('title', 'title', [0.1, 0.3, 0.8, 0.2], 'content'), layer('plane', 'object', [0.02, 0.6, 0.12, 0.1], 'design'), mark, captions], captions: { base: 'white bold on a black plate' }, rebuild: 'A card with a title; a paper plane flies in.' },
    { shot: 2, time: [2, 5], job: 'demo', layout: 'a full-frame screen recording', transitionIn: { kind: 'custom', seconds: 0.5, description: 'The plane flies on up and to the right, a curved edge trails it and reveals the recording.' }, layers: [layer('page', 'screen', [0, 0, 1, 1], 'content'), mark, captions], captions: { base: 'white bold on a black plate', highlight: 'the setting in yellow' } },
    { shot: 3, time: [5, 8], job: 'proof', layout: 'a window on a designed ground', transitionIn: { kind: 'dissolve', seconds: 0.3 }, layers: [ground, layer('window', 'screen', [0.15, 0.12, 0.7, 0.6], 'content'), layer('box', 'highlight', [0.5, 0.4, 0.2, 0.08], 'design'), mark, captions], emphasis: [{ what: 'box', on: 'the sync switch', why: 'the line says one switch keeps them' }] },
    { shot: 4, time: [8, 10], job: 'end card', layout: 'an end card', transitionIn: { kind: 'cut' }, layers: [layer('black', 'ground', [0, 0, 1, 1], 'design'), layer('avatar', 'person', [0.42, 0.25, 0.16, 0.28], 'creator'), layer('follow', 'platform', [0.28, 0.58, 0.44, 0.09], 'platform'), mark], drop: 'the platform\'s end card; the re-make ends with its own closing' },
  ],
};

const check = (e: unknown, text: TextTrack | undefined = TEXT) => checkElements(readElements(e), MEASURE, text);
const only = (problems: Problem[], level: Problem['level']): string[] => problems.filter((p) => p.level === level).map((p) => p.at + ': ' + p.message);
const variant = (change: (e: Elements) => void): Elements => { const e = clone(GOOD); change(e); return e; };
const shotOf = (e: Elements, n: number): ShotReading => e.shots.find((s) => s.shot === n) as ShotReading;

describe('elements check: the reading against the measurement', () => {
  it('finds nothing in a good reading and writes one line per shot', () => {
    const r = check(GOOD);
    expect(r.problems).toEqual([]);
    expect(r.summary).toEqual([
      '#01 0.00-2.00 a title card on a flat ground | start, runs on into #02 | design 3, content 1, platform 1 | captions white bold on a black plate',
      '#02 2.00-5.00 a full-frame screen recording | in custom: The plane flies on up and to the right, a curved … | design 1, content 1, platform 1 | captions white bold on a black plate, highlight the setting in yellow',
      '#03 5.00-8.00 a window on a designed ground | in dissolve | design 3, content 1, platform 1 | box on the sync switch',
      '#04 8.00-10.00 | dropped: the platform\'s end card; the re-make ends with its own closing',
    ]);
  });

  it('says which shot has no entry, and an entry for a shot that does not exist', () => {
    const r = check(variant((e) => { e.shots = e.shots.filter((s) => s.shot !== 3); e.shots.push({ ...clone(shotOf(GOOD, 3)), shot: 7 }); }));
    expect(only(r.problems, 'error')).toEqual(['shots: Shot 3 (5.00-8.00 s) has no entry.', 'shots[3].shot: There is no shot 7: the measurement has 4.']);
    expect(r.problems.find((p) => p.at === 'shots')?.fix).toContain('shots/03-frames.jpg');
    expect(r.summary[2]).toBe('#03 5.00-8.00 | no entry');
  });

  it('refuses a box outside the frame, and says when it looks like pixels', () => {
    const r = check(variant((e) => { (shotOf(e, 1).layers[1] as Layer).box = [0.1, 0.3, 0.95, 0.2]; (shotOf(e, 3).layers[1] as Layer).box = [190, 86, 896, 432]; }));
    expect(only(r.problems, 'error')).toEqual([
      'shots[0].layers[1].box: The box [0.1,0.3,0.95,0.2] lies outside the frame: x and y are at least 0, x + width and y + height at most 1.',
      'shots[2].layers[1].box: The box [190,86,896,432] lies outside the frame: x and y are at least 0, x + width and y + height at most 1. It looks like pixels: divide x and width by the frame\'s width, y and height by its height.',
    ]);
  });

  it('refuses a custom change without a description', () => {
    const r = check(variant((e) => { shotOf(e, 2).transitionIn = { kind: 'custom', seconds: 0.5 }; }));
    expect(only(r.problems, 'error')).toEqual(['shots[1].transitionIn.description: The change into shot 2 is "custom" and has no "description".']);
    expect(r.problems[0]?.fix).toContain('transitions/02.jpg');
  });

  it('warns when a change the measurement says its label does not fit is called standard without saying why', () => {
    const plain = check(variant((e) => { shotOf(e, 2).transitionIn = { kind: 'slide', seconds: 0.5 }; }));
    expect(only(plain.problems, 'warning')).toEqual(['shots[1].transitionIn: The measurement says its label for the change into shot 2 (slide cover right) does not fit the frames, and the reading calls it "slide" without saying why.']);
    expect(plain.problems[0]?.fix).toContain('Look at transitions/02.jpg frame by frame');
    expect(check(variant((e) => { shotOf(e, 2).transitionIn = { kind: 'slide', seconds: 0.5, description: 'the new picture slides over from the left, a straight edge' }; })).problems).toEqual([]);
    // A label that fits needs no reason.
    expect(check(variant((e) => { shotOf(e, 3).transitionIn = { kind: 'dissolve' }; })).problems).toEqual([]);
  });

  it('warns about a watermark no platform layer covers, naming the shots', () => {
    const r = check(variant((e) => { for (const n of [2, 3]) shotOf(e, n).layers = shotOf(e, n).layers.filter((l) => l.id !== 'mark'); }));
    expect(only(r.problems, 'warning')).toEqual(['shots[1].layers: The measurement read "@acme.notes" as a watermark at [0.76, 0.03, 0.2, 0.04] in shots 1-4; no platform layer covers it in shots 2-3.']);
    expect(r.problems[0]?.fix).toContain('"kind": "platform", "role": "platform", "box": [0.76, 0.03, 0.2, 0.04]');
    // A design layer over it is not the platform's.
    const design = check(variant((e) => { const m = shotOf(e, 2).layers.find((l) => l.id === 'mark') as Layer; m.role = 'design'; }));
    expect(only(design.problems, 'warning')).toHaveLength(1);
  });

  it('warns when captions were read in a shot and the reading has no caption layer', () => {
    const r = check(variant((e) => { shotOf(e, 3).layers = shotOf(e, 3).layers.filter((l) => l.kind !== 'caption'); }));
    expect(only(r.problems, 'warning')).toEqual(['shots[2].layers: The measurement read 1 caption line in shot 3 ("Everywhere you work"), and the reading has no layer of kind "caption".']);
    expect(r.problems[0]?.fix).toContain('"box": [0.2, 0.85, 0.6, 0.06]');
    // Without a text reader nothing is known of the captions.
    expect(checkElements(readElements(variant((e) => { shotOf(e, 3).layers = shotOf(e, 3).layers.filter((l) => l.kind !== 'caption'); })), MEASURE).problems).toEqual([]);
  });

  it('warns about a mark that does not say why, and a highlight with no mark at all', () => {
    const noWhy = check(variant((e) => { shotOf(e, 3).emphasis = [{ what: 'box', on: 'the sync switch' }]; }));
    expect(only(noWhy.problems, 'warning')).toEqual(['shots[2].emphasis[0].why: The box on "the sync switch" in shot 3 does not say why it is there.']);
    const none = check(variant((e) => { delete shotOf(e, 3).emphasis; shotOf(e, 2).layers.push(layer('cursor', 'pointer', [0.5, 0.5, 0.03, 0.05], 'design')); }));
    expect(only(none.problems, 'warning')).toEqual([
      'shots[1].layers: Layer "cursor" of shot 2 is a pointer, and the shot has no "emphasis" that says what it marks and why.',
      'shots[2].layers: Layer "box" of shot 3 is a highlight, and the shot has no "emphasis" that says what it marks and why.',
    ]);
  });

  it('warns when the last shot is made mostly of the platform\'s and the author\'s layers, and drops only shots at the end', () => {
    const kept = check(variant((e) => { delete shotOf(e, 4).drop; }));
    expect(only(kept.problems, 'warning')).toEqual(['shots[3]: The last shot (4) is made mostly of the platform\'s or the author\'s layers (avatar, follow, mark): an end card, which a re-make never copies.']);
    expect(kept.problems[0]?.fix).toContain('"drop"');
    const middle = check(variant((e) => { shotOf(e, 2).drop = 'not wanted'; }));
    expect(only(middle.problems, 'error')).toEqual(['shots[1].drop: Shot 2 is dropped whole, and shot 3 after it is not: only shots at the end can be dropped (the platform\'s end card, the author\'s sign-off).']);
    // A run of shots at the end may be dropped together.
    expect(only(check(variant((e) => { shotOf(e, 3).drop = 'the author\'s sign-off'; })).problems, 'error')).toEqual([]);
  });

  it('says what is wrong with the shape, as JSON paths', () => {
    const r = check({ shots: [{ shot: 1, time: [0, 2], layout: '', layers: [{ id: 'a', kind: 'banner', box: [0, 0, 1, 1], look: 'x', role: 'keep' }] }, 'x'] });
    expect(only(r.problems, 'error')).toEqual([
      'shots[0].layout: A shot needs a "layout": the kind of picture in generic words.',
      'shots[1]: A shot is an object with "shot", "time", "layout", "layers" and the other keys of video-elements.md.',
      'shots: Shot 2 (2.00-5.00 s) has no entry.',
      'shots: Shot 3 (5.00-8.00 s) has no entry.',
      'shots: Shot 4 (8.00-10.00 s) has no entry.',
    ]);
  });
});

describe('the page and the questions say the same', () => {
  it('the example of video-elements.md is a reading the check accepts', async () => {
    const page = await readFile(path.join(rt.skillRoot, 'references', 'video-elements.md'), 'utf8');
    const json = page.slice(page.indexOf('```json') + 7, page.indexOf('```', page.indexOf('```json') + 7));
    const m: Measure = { ...MEASURE, source: { ...MEASURE.source, frames: 225, duration: 7.5 }, shots: [shot(0, 0, 66), shot(1, 66, 180), shot(2, 180, 225)], boundaries: [{ ...MEASURE.boundaries[0] as Measure['boundaries'][number], frame: 66, start: 58, end: 74 }, { frame: 180, kind: 'cut', start: 179, end: 180, confidence: 1 }] };
    const r = checkElements(readElements(JSON.parse(json)), m);
    expect(r.problems).toEqual([]);
    expect(r.summary[2]).toContain('dropped');
  });

  it('the reader is told how the engine draws every standard transition, in the part questions prints', async () => {
    const page = await readFile(path.join(rt.skillRoot, 'references', 'video-elements.md'), 'utf8');
    const reader = page.slice(page.indexOf('## For the reader'));
    expect(TRANSITION_KINDS.filter((k) => !reader.includes('- `' + k + '`: '))).toEqual([]);
  });

  it('video.md writes and checks the reading before the template, keeps each layout, draws an effect in one scene, and marks the strongest point', async () => {
    const page = (await readFile(path.join(rt.skillRoot, 'references', 'video.md'), 'utf8')).replace(/\s+/g, ' ');
    const step = (n: number): string => page.split('## ' + n + '.')[1]?.split('## ' + (n + 1) + '.')[0] ?? '';
    expect(step(1)).toContain('Write `ref/elements.json`');
    expect(step(1)).toContain('popost video elements check ref');
    expect(step(1)).not.toContain('ref/notes.md');
    expect(step(2)).toContain('`template save` reads `ref/elements.json`');
    expect(step(3)).toContain('find its closest real material for that layout (another page, another recording, another photo), never another layout');
    expect(step(4)).toContain('its content is the new subject\'s strongest material for that job, from the request first and the sources second');
    expect(step(4)).toContain('goes on what the new line says, that strongest point');
    expect(step(5)).toContain('never patch `video.json` with a script after `template fill`');
    expect(page).not.toContain('ref/notes.md');
    const reader = await readFile(path.join(rt.skillRoot, 'references', 'video-elements.md'), 'utf8');
    expect(reader.replace(/\s+/g, ' ')).toContain('the new subject\'s strongest point for that job, taken from the request first and the sources second');
  });

  it('questions prints the reader\'s part of the page, the pictures in order and the shots with their measured changes', async () => {
    await put('ref/measure.json', JSON.stringify(MEASURE));
    await put('ref/text.json', JSON.stringify(TEXT));
    for (const f of ['opening.jpg', 'shots/01-frames.jpg', 'shots/02-frames.jpg', 'shots/03-frames.jpg', 'shots/04-frames.jpg', 'transitions/02.jpg', 'transitions/03.jpg']) await put('ref/' + f, 'not a picture: only its name is read');
    const r = await runCli(rt, ['video', 'elements', 'questions', 'ref']);
    expect(r.code, r.stdout).toBe(0);
    const q = rt.json() as { pictures: string[]; shots: { shot: number; time: number[]; in: string }[]; prompt: string; write: string };
    expect(q.pictures.map((p) => path.relative(at('ref'), p))).toEqual(['opening.jpg', 'shots/01-frames.jpg', 'transitions/02.jpg', 'shots/02-frames.jpg', 'transitions/03.jpg', 'shots/03-frames.jpg', 'shots/04-frames.jpg']);
    expect(q.write).toBe(at('ref', 'elements.json'));
    expect(q.prompt.startsWith('## For the reader')).toBe(true);
    for (const words of ['`sameEffectAsNext`', '`drop`', 'Never re-made', 'Not from any real video', '## This video']) expect(q.prompt).toContain(words);
    expect(q.prompt).toContain('- shot 1, time [0, 2]: opens the video; frames shots/01-frames.jpg');
    expect(q.prompt).toContain('- shot 2, time [2, 5]: in slide cover right 15f, does not fit the frames well (transitions/02.jpg); frames shots/02-frames.jpg');
    expect(q.prompt).toContain('- shot 4, time [8, 10]: in a cut; frames shots/04-frames.jpg');
    expect(q.prompt).toContain('a watermark "@acme.notes" at [0.76, 0.03, 0.2, 0.04] in shots 1-4; caption lines in shots 1-3.');
  });

  it('check prints the summary, and exits 2 with the errors of a wrong file', async () => {
    await put('ref/elements.json', JSON.stringify(GOOD));
    expect((await runCli(rt, ['video', 'elements', 'check', 'ref'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, shots: 4, errors: 0, warnings: 0 });
    expect((rt.json() as { summary: string[] }).summary).toHaveLength(4);
    await put('bad/measure.json', JSON.stringify(MEASURE));
    await put('bad/elements.json', JSON.stringify(variant((e) => { shotOf(e, 2).transitionIn = { kind: 'custom' }; })));
    expect((await runCli(rt, ['video', 'elements', 'check', 'bad'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, errors: 1 });
    await put('bad/elements.json', '{"shots": [');
    expect((await runCli(rt, ['video', 'elements', 'check', 'bad'])).code).toBe(2);
    expect((rt.json() as { error: string }).error).toContain('is not valid JSON');
  });
});

const SCENE = (body: string): string => '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#1d2b53}</style></head><body>' + body + '</body></html>';

let t: Template;
describe('the template carries the reading', () => {
  let card = '';
  beforeAll(async () => {
    await put('ref/elements.json', JSON.stringify(GOOD));
    const r = await runCli(rt, ['video', 'template', 'save', 'ref', '--out', 'tpl', '--name', 'notes']);
    expect(r.code, r.stdout).toBe(0);
    expect(rt.json()).toMatchObject({ reading: { shots: 3, custom: ['shots[1]'], dropped: [4], closing: 'shots[2]' } });
    t = await readJson<Template>('tpl/template.json');
    card = await readFile(at('tpl/TEMPLATE.md'), 'utf8');
  });

  it('keeps each shot\'s layout, its layers by role, and an effect of its own as custom with its picture, never a preset', () => {
    expect(t.shots.map((s) => s.elements?.layout)).toEqual(['a title card on a flat ground', 'a full-frame screen recording', 'a window on a designed ground']);
    expect(t.shots.map((s) => s.elements?.frame)).toEqual(['designed', 'full', 'designed']);
    expect(t.shots[0]?.elements).toMatchObject({ design: [{ id: 'ground' }, { id: 'plane' }, { id: 'captions' }], content: [{ id: 'title', content: 'what title shows' }], dropped: [{ id: 'mark', role: 'platform' }], runsOn: true });
    expect(t.shots[1]?.in).toBeUndefined();
    expect(t.shots[1]?.effect).toEqual({ transition: 'custom', frames: 15, description: shotOf(GOOD, 2).transitionIn?.description, picture: '../ref/transitions/02.jpg', measured: 'slide cover right 15f', by: 'before' });
    expect(t.shots[2]?.in).toEqual({ transition: 'dissolve', frames: 9 });
    expect(t.shots[2]?.elements?.emphasis).toEqual([{ what: 'box', on: 'the sync switch', why: 'the line says one switch keeps them' }]);
  });

  it('leaves out the end card the reading dropped: the template ends where the re-make\'s own closing ends', async () => {
    expect(t.shots).toHaveLength(3);
    expect(t.frames).toBe(240);
    expect(t.dropped).toEqual([{ shot: 4, seconds: [8, 10], reason: 'the platform\'s end card; the re-make ends with its own closing' }]);
    expect(t.captions?.beats.every((b) => b.end <= 240)).toBe(true);
    const text = await readJson<{ shots: string[][]; dropped: string[] }>('tpl/reference-text.json');
    expect(text.shots).toHaveLength(3);
    expect(text.dropped).toEqual(['@acme.notes', 'Follow @acme.notes for more']);
    expect(JSON.stringify(t)).not.toContain('acme');
  });

  it('keeps a visual correction of a measured transition, including a hard cut and its duration', () => {
    const e = variant((r) => { shotOf(r, 2).transitionIn = { kind: 'cut' }; shotOf(r, 3).transitionIn = { kind: 'fade', seconds: 0.4 }; });
    const t = withReading(templateFrom({ measure: MEASURE, name: 'corrected', label: 'reference', hash: 'x' }), MEASURE, MEASURE, e, (p) => p);
    expect(t.shots[1]?.in).toBeUndefined();
    expect(t.shots[2]?.in).toEqual({ transition: 'fade', frames: 12 });
    expect(t.shots[2]?.effect).toBeUndefined();
  });

  it('TEMPLATE.md names every shot\'s layout, the effect and the closing, inside its budget', () => {
    console.log(card);
    expect(roughTokens(card)).toBeLessThanOrEqual(cardBudget(t));
    expect(cardBudget(t)).toBe(600 + 3 * 40);
    expect(card).toMatch(/shots\[1\] 2\.0-5\.0( s, in:)? custom 15f/);
    expect(card).toContain('custom in, drawn by the scene of the shot before, which runs on over this one: The plane flies on');
    expect(card).toContain('; keep ground, plane, captions; replace title; drop mark');
    expect(card).toContain('ref/transitions/02.jpg');
    for (const s of t.shots) expect(card).toContain(s.elements?.layout ?? '-');
    expect(card).toContain('The reference\'s shot 4 (8-10 s, the platform\'s end card; the re-make ends with its own closing) is left out: shots[2] is the re-make\'s own closing.');
    expect(card).not.toContain('2.0-5.0 slide');
    expect(card).toContain('A mark keeps its kind and look and goes on what the new line says: the new subject\'s strongest point for the beat\'s job');
  });

  it('refuses to save over a reading with errors, and says so without one', async () => {
    await put('ref2/measure.json', JSON.stringify(MEASURE));
    await put('ref2/elements.json', JSON.stringify(variant((e) => { e.shots.pop(); })));
    expect((await runCli(rt, ['video', 'template', 'save', 'ref2', '--out', 'tpl2', '--name', 'x'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, errors: 1 });
    expect(await readFile(at('tpl2/template.json'), 'utf8').catch(() => 'none')).toBe('none');
    await rm(at('ref2/elements.json'));
    expect((await runCli(rt, ['video', 'template', 'save', 'ref2', '--out', 'tpl2', '--name', 'x'])).code).toBe(0);
    expect((rt.json() as { note: string }).note).toContain('There is no elements.json');
  });
});

describe('a fill holds an effect of its own natively', () => {
  const scenes = (): Record<string, unknown>[] => [{ scene: 'scenes/open.html' }, { scene: 'scenes/open.html' }, { color: '#264653' }];
  const lines = async (): Promise<string[]> => (await readJson<{ captions?: { lines: unknown[] } }>('tpl/slots.json')).captions?.lines.map(() => 'A line of the new video') ?? [];
  const fill = async (shots: Record<string, unknown>[], captions?: string[]): Promise<{ code: number; json: { problems: Problem[] } }> => {
    await put('fill.json', JSON.stringify({ shots, captions: captions ?? (await lines()) }));
    const r = await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'fill.json', '--out', 'project']);
    return { code: r.code, json: rt.json() as { problems: Problem[] } };
  };
  beforeAll(async () => { await put('project/scenes/open.html', SCENE('<div>Your notes, in one place</div>')); });

  it('cuts where the scene that draws the effect covers it: at its end when the shot before runs on into it', async () => {
    const r = await fill(scenes());
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    const p = await readJson<Project>('project/video.json');
    expect(p.segments.map((s) => [s.frames, s.in?.transition ?? 'cut'])).toEqual([[68, 'cut'], [82, 'cut'], [90, 'dissolve']]);
    // (The made-up fill has no picture in its recording shots: the main-picture warnings are not what this test is about.)
    expect(r.json.problems.filter((x) => x.at.startsWith('shots[') && !x.message.includes('main picture')).map((x) => x.at)).toEqual([]);
  });

  it('template check with a project says each main-picture warning once, at the fill\'s place', async () => {
    expect((await fill(scenes())).code).toBe(0);
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'fill.json', '--assets', 'project'])).code).toBe(0);
    const found = (rt.json() as { problems: Problem[] }).problems.filter((x) => x.message.includes('main picture'));
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map((x) => x.message)).size).toBe(found.length);
    expect(found.every((x) => x.at.startsWith('shots['))).toBe(true);
  });

  it('cuts at the effect\'s start when the shot\'s own scene draws it, and warns when the shot that draws it is no scene', async () => {
    const own = clone(t);
    await put('tpl-own/template.json', JSON.stringify({ ...own, shots: own.shots.map((s, k) => (k === 1 && s.effect ? { ...s, effect: { ...s.effect, by: 'this' } } : s)) }));
    for (const f of ['slots.json', 'TEMPLATE.md']) await put('tpl-own/' + f, await readFile(at('tpl', f), 'utf8'));
    await put('fill.json', JSON.stringify({ shots: [{ color: '#111111' }, { scene: 'scenes/open.html' }, { color: '#264653' }], captions: await lines() }));
    expect((await runCli(rt, ['video', 'template', 'fill', 'tpl-own', '--fill', 'fill.json', '--out', 'project'])).code).toBe(0);
    expect((await readJson<Project>('project/video.json')).segments.map((s) => s.frames)).toEqual([53, 97, 90]);
    await put('fill.json', JSON.stringify({ shots: [{ color: '#111111' }, { color: '#e9ecef' }, { color: '#264653' }], captions: await lines() }));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl-own', '--fill', 'fill.json'])).code).toBe(0);
    const warned = (rt.json() as { problems: Problem[] }).problems.filter((x) => x.at === 'shots[1]' && x.message.includes('effect of its own'));
    expect(warned.map((x) => x.message)).toEqual(['Shot 2 begins with an effect of its own, as the reading saw it: "The plane flies on up and to the right, a curved edge trails it and reveals the recording." (its frames: ref/transitions/02.jpg). A color cannot draw it, and the engine cuts there.']);
    expect(warned[0]?.fix).toContain('from its first frame');
  });

  it('template check warns about a layout changed and the platform\'s words in a caption', async () => {
    const small = { scene: 'scenes/open.html', items: [{ video: 'assets/app.mp4', box: [0.6, 0.1, 0.25, 0.8] }] };
    await put('fill.json', JSON.stringify({ shots: [{ footage: 'assets/clip.mp4' }, small, { scene: 'scenes/open.html' }], captions: ['Follow @acme.notes', ...(await lines()).slice(1)] }));
    expect((await runCli(rt, ['video', 'template', 'check', 'tpl', '--fill', 'fill.json'])).code).toBe(0);
    const problems = (rt.json() as { problems: Problem[] }).problems;
    console.log(JSON.stringify(problems, null, 1));
    expect(problems.find((x) => x.at === 'shots[0]' && x.message.includes('designed'))?.message).toBe('Shot 1 was read as "a title card on a flat ground", a designed picture with smaller pictures on it; it is built as its material full frame.');
    expect(problems.find((x) => x.at === 'shots[1]' && x.message.includes('full frame'))?.message).toBe('Shot 2 was read as "a full-frame screen recording", full frame; it is built as a designed scene whose pictures cover 20% of the frame.');
    expect(problems.find((x) => x.at === 'shots[0]' && x.message.includes('effect of its own'))?.message).toContain('Shot 1 runs on into an effect of its own, as the reading saw the change into shot 2: ');
    expect(problems.find((x) => x.at === 'captions[0]')?.message).toBe('captions[0] "Follow @acme.notes" shows "@acme.notes", which the reference showed in its platform\'s or author\'s layers (a watermark, an account line): this is the reference\'s platform or author, which a re-make never shows.');
  });

  it('video check warns about a preset where the effect is, and the platform\'s words in a scene, only with the record', async () => {
    expect((await fill(scenes())).code).toBe(0);
    const p = await readJson<Project>('project/video.json');
    p.segments[1] = { ...(p.segments[1] as Project['segments'][number]), in: { transition: 'slide', frames: 15, direction: 'right', mode: 'cover' } };
    await put('project/video.json', JSON.stringify(p));
    await put('project/scenes/open.html', SCENE('<div>Follow @acme.notes for more</div>'));
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    const problems = (rt.json() as { problems: Problem[] }).problems;
    console.log(JSON.stringify(problems, null, 1));
    const preset = problems.find((x) => x.at === 'segments[1].in');
    expect(preset?.message).toBe('The change into segment "shot-02" is the preset "slide"; the reading saw an effect of its own there: "The plane flies on up and to the right, a curved edge trails it and reveals the recording." (its frames: ref/transitions/02.jpg). A preset does not make it.');
    expect(preset?.fix).toContain('Draw it at the end of the scene of segment "shot-01"');
    expect(problems.find((x) => x.at === 'segments[0].base.scene')?.message).toBe('The scene "scenes/open.html" of segment "shot-01" shows "Follow @acme.notes for more", which the reference showed in its platform\'s or author\'s layers (a watermark, an account line): this is the reference\'s platform or author, which a re-make never shows.');
    await rm(at('project/reference.facts.json'));
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    expect(JSON.stringify(rt.json())).not.toContain('reading');
    await put('project/scenes/open.html', SCENE('<div>Your notes, in one place</div>'));
  });
});

describe('the reading against a project (no files)', () => {
  const rf: ReadingFacts = { shots: [{ layout: 'a full-frame screen recording', frame: 'full' }, { layout: 'a card beside a picture', frame: 'designed' }], dropped: ['@acme.notes'] };
  const seg = (id: string, base: Project['segments'][number]['base']): Project['segments'][number] => ({ id, frames: 60, base });
  const project = (tracks: Project['tracks']): Project => ({ version: 1, canvas: { width: 1280, height: 720, fps: 30 }, materials: [{ id: 'm', kind: 'video', file: 'assets/m.mp4' }],
    segments: [seg('a', { scene: 'scenes/a.html' }), seg('b', { material: 'm' })], tracks });

  it('warns when a full-frame recording becomes small pictures in a scene, and a designed shot full-frame material', () => {
    const problems = projectReadingProblems(rf, project([{ id: 'phone', type: 'video', material: 'm', box: [0.6, 0.1, 0.25, 0.8], during: { segment: 'a' } }]), new Map());
    expect(problems.map((p) => p.at + ': ' + p.message)).toEqual([
      'segments[0].base: Shot 1 was read as "a full-frame screen recording", full frame; it is built as a designed picture whose pictures cover 20% of the frame.',
      'segments[1].base: Shot 2 was read as "a card beside a picture", a designed picture with smaller pictures on it; it is built as its material full frame.',
    ]);
    // A scene with the recording over most of the frame keeps the layout; one with no items is not known.
    expect(projectReadingProblems({ ...rf, shots: [rf.shots[0] as ReadingFacts['shots'][number]] }, project([{ id: 'full', type: 'video', material: 'm', box: [0, 0, 1, 0.9], during: { segment: 'a' } }]), new Map())).toEqual([]);
    expect(projectReadingProblems({ ...rf, shots: [rf.shots[0] as ReadingFacts['shots'][number]] }, project([]), new Map())).toEqual([]);
  });

  it('finds the platform\'s handle in a caption, but not a word of its own that only looks alike', () => {
    const caps = (text: string): Project['tracks'] => [{ id: 'subs', type: 'caption', box: [0.1, 0.85, 0.8, 0.1], cues: [{ text, during: { segment: 'a' } }] }];
    expect(projectReadingProblems({ ...rf, shots: [] }, project(caps('Say hi to @ACME.notes')), new Map()).map((p) => p.at)).toEqual(['tracks[0].cues[0].text']);
    expect(projectReadingProblems({ ...rf, shots: [] }, project(caps('Acme notes for teams')), new Map())).toEqual([]);
    expect(fillReadingProblems({ ...rf, shots: [] }, { shots: [{ scene: 'scenes/a.html', slots: { handle: '@acme.notes' } }] }).map((p) => p.at)).toEqual(['shots[0].slots.handle']);
  });
});
