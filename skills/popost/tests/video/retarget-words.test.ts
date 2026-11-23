/**
 * Words the reference laid over its shots (titles: sticker words, a heading over a recorded page) are places a fill
 * gives new words to, shots[k].words[j], drawn where the reference had them, at its size and on its frames of the shot.
 * The template keeps the places (not the words) and its slots say how long a line may be.
 */
import { describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { reflow, retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { barPlaces, titlePlaces } from '../../src/video/retarget/titles';
import { templateCard } from '../../src/video/template/card';
import { checkFill } from '../../src/video/template/check';
import { slotsOf } from '../../src/video/template/slots';
import { retargetInputs, templateFrom } from '../../src/video/template/structure';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Box, Measure, Track } from '../../src/video/types';

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const measure: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }, { frame: 200, kind: 'cut', start: 199, end: 200, confidence: 1 }],
  shots: [
    { index: 0, start: 0, end: 90, camera: still, background: '', palette: [], events: [] },
    { index: 1, start: 90, end: 200, camera: still, background: '', palette: [], events: [] },
    { index: 2, start: 200, end: 300, camera: still, background: '', palette: [], events: [] },
  ],
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number, role: TextCue['role'], box: Box, size: number): TextCue => ({ text, start, end, box, role, size, samples: 5, confidence: 0.95 });
const caption = (text: string, start: number, end: number): TextCue => cue(text, start, end, 'caption', [0.3, 0.86, 0.4, 0.08], 0.08);
const text: TextTrack = {
  step: 6, sampled: 50,
  cues: [
    caption('one', 0, 60), caption('two', 60, 150), caption('three', 150, 280),
    // shot 1 (frames 90-200): a heading on the left, and a line in the middle that the reader saw 3 frames early
    cue('Step one', 100, 160, 'title', [0.06, 0.2, 0.3, 0.08], 0.08),
    cue('spill', 87, 120, 'title', [0.4, 0.6, 0.2, 0.06], 0.06),
    // shot 2 (200-300): a large word in the middle; a small label is no place
    cue('Done', 210, 300, 'title', [0.4, 0.4, 0.2, 0.1], 0.1),
    cue('small print', 210, 300, 'label', [0.7, 0.9, 0.2, 0.03], 0.03),
  ],
};
const shots = (words: (string[] | undefined)[]): RetargetPlan['shots'] =>
  [{ color: '#101010' }, { color: '#f0f0f0' }, { color: '#202080' }].map((s, k) => ({ ...s, ...(words[k] ? { words: words[k] } : {}) }));
const plan = (words: (string[] | undefined)[]): RetargetPlan => ({ captions: ['a', 'b', 'c'], shots: shots(words) });
const wordItems = (tracks: Track[] | undefined): Track[] => (tracks ?? []).filter((t) => t.id.includes('-words-'));

describe('words laid over a shot', () => {
  it('finds the places by shot, each in the shot that shows most of it, in the order they appear', () => {
    const places = titlePlaces(measure, text);
    expect(places.map((xs) => xs.map((x) => [x.text, x.place.from, x.place.to]))).toEqual([[], [['spill', 0, 30], ['Step one', 10, 70]], [['Done', 10, 100]]]);
  });

  it('draws a fill\'s words in the places, at the reference\'s size and times, with marked words highlighted', () => {
    const r = retarget({ measure, text, plan: plan([undefined, ['Look *here*', 'New step'], ['Fin']]) });
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    const items = wordItems(r.project?.tracks) as Extract<Track, { type: 'text' }>[];
    expect(items.map((t) => [t.id, t.text, t.during])).toEqual([
      ['shot-02-words-1', 'Look here', { segment: 'shot-02', from: 0, to: 30 }],
      ['shot-02-words-2', 'New step', { segment: 'shot-02', from: 10, to: 70 }],
      ['shot-03-words-1', 'Fin', { segment: 'shot-03', from: 10, to: 100 }],
    ]);
    const [middle, left] = items.map((t) => ({ box: t.box, style: t.style as { size: number; align: string; spans?: { from: number; to: number }[] } }));
    // A line about the middle grows both ways; one on the left keeps its left edge.
    expect(middle?.style.align).toBe('center');
    expect((middle?.box[0] ?? 0) + (middle?.box[2] ?? 0) / 2).toBeCloseTo(0.5, 3);
    expect(middle?.style.spans?.map((s) => [s.from, s.to])).toEqual([[5, 9]]);
    expect(left?.style.align).toBe('left');
    expect(left?.box[0]).toBe(0.06);
    expect(left?.style.size).toBeCloseTo(0.0736, 4);
    expect(r.notes.join(' ')).not.toContain('gives them no line');
  });

  it('moves the words with their shot when time is re-flowed to speech', () => {
    const spoken = [56, 120, 126];
    const r = retarget({ measure, text, plan: plan([undefined, ['', 'New step']]), spoken: { frames: spoken } });
    const flow = reflow([{ start: 0, end: 60 }, { start: 60, end: 150 }, { start: 150, end: 280 }], spoken, 300);
    const item = wordItems(r.project?.tracks)[0] as Extract<Track, { type: 'text' }>;
    expect(item.id).toBe('shot-02-words-2');
    expect(item.during).toEqual({ segment: 'shot-02', from: flow.map(100) - flow.map(90), to: flow.map(160) - flow.map(90) });
  });

  it('refuses more lines than places, words on kept footage, and words that are not a list of lines', () => {
    const at = (p: RetargetPlan): string[] => retarget({ measure, text, plan: p }).problems.filter((x) => x.level === 'error').map((x) => x.at);
    expect(at(plan([['x']]))).toEqual(['shots[0].words']);
    expect(at(plan([undefined, ['a', 'b', 'c']]))).toEqual(['shots[1].words']);
    expect(at({ captions: ['a', 'b', 'c'], shots: [{ color: '#101010' }, { keep: true, words: ['a'] }, { color: '#202080', words: 'Fin' as unknown as string[] }] })).toEqual(['shots[1].words', 'shots[2].words']);
  });

  it('names the places a plan leaves without a line, except where a card or a scene draws its own text', () => {
    const r = retarget({ measure, text, plan: plan([undefined, ['only one']]) });
    const note = r.notes.find((n) => n.includes('gives them no line')) ?? '';
    expect(note).toContain('shots[1].words (1 of 2)');
    expect(note).toContain('shots[2].words (1 of 1)');
    const card = retarget({ measure, text, plan: { captions: ['a', 'b', 'c'], shots: [{ color: '#101010' }, { card: { title: 'Card' } }, { scene: 'scenes/s.html' }] } });
    expect(card.notes.join(' ')).not.toContain('gives them no line');
  });
});

describe('words in a template', () => {
  const tpl = templateFrom({ measure, text, name: 'words', label: 'words', hash: 'x' });
  const slots = slotsOf(tpl, undefined, { words: titlePlaces(measure, text).map((xs) => xs.map((x) => x.text)) });

  it('keeps the places without their words, and the slots say what was there and how long a line may be', () => {
    expect(tpl.shots.map((s) => (s.words ?? []).map((w) => [w.from, w.to]))).toEqual([[], [[0, 30], [10, 70]], [[10, 100]]]);
    expect(JSON.stringify(tpl)).not.toContain('Step one');
    const w = slots.shots[1]?.words?.[1];
    expect(w).toMatchObject({ at: 'shots[1].words[1]', seconds: 2, example: { text: 'Step one', chars: 8 } });
    expect(w?.max.cjk).toBeGreaterThanOrEqual(15);
    expect(w?.max.latin).toBeGreaterThanOrEqual(25);
    expect(slots.shots[0]?.words).toBeUndefined();
  });

  it('fills the same places as a retarget of the reference', () => {
    const p = plan([undefined, ['Look *here*', 'New step'], ['Fin']]);
    const inputs = retargetInputs(tpl);
    const filled = wordItems(retarget({ ...inputs, plan: p }).project?.tracks);
    expect(filled).toEqual(wordItems(retarget({ measure, text, plan: p }).project?.tracks));
  });

  it('checks a fill\'s words against the slots, and TEMPLATE.md names them', async () => {
    const rt = await createDiskRuntime();
    try {
      const pkg = { template: tpl, slots };
      const too = await checkFill(rt, pkg, plan([undefined, ['a', 'b', 'c']]));
      expect(too.filter((x) => x.level === 'error').map((x) => x.at)).toEqual(['shots[1].words']);
      const long = await checkFill(rt, pkg, plan([undefined, ['ok', 'A line far too long for the place the reference gave its heading on the left']]));
      expect(long.filter((x) => x.at.includes('words')).map((x) => [x.level, x.at])).toEqual([['warning', 'shots[1].words[1]']]);
    } finally {
      await rt.cleanup();
    }
    const card = templateCard(tpl, slots, { text, sourceFps: 30 }).text;
    expect(card).toContain('shots[1] ');
    expect(card).toContain('words "spill" (5), "Step one" (8)');
    expect(card).toContain('shots[k].words');
  });
});

describe('a bar of words through the video', () => {
  const word = (text: string, at: number, highlighted: [number, number][]): TextCue =>
    ({ ...cue(text, 0, 300, 'label', [0.2 + 0.22 * at, 0.04, 0.08, 0.05], 0.05), bar: { row: 0, at, of: 3, highlighted } });
  // the bar marks "Intro" over shot 0, "Setup" over shot 1 and nothing over shot 2 (a mark over less than half of it)
  const barText: TextTrack = { ...text, cues: [...text.cues, word('Intro', 0, [[0, 90]]), word('Setup', 1, [[90, 200], [200, 230]]), word('Results', 2, [])] };
  const withBar = (bar?: unknown): RetargetPlan => ({ ...plan([undefined, ['a', 'b'], ['c']]), ...(bar === undefined ? {} : { bar: bar as string[] }) });

  it('draws the bar\'s words through the video and the word each shot marks over it', () => {
    expect(barPlaces(measure, barText)).toMatchObject({ marked: [0, 1, -1], texts: ['Intro', 'Setup', 'Results'] });
    const r = retarget({ measure, text: barText, plan: withBar(['Plan', 'Build', 'Ship']) });
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    const items = (r.project?.tracks ?? []).filter((t) => t.id.startsWith('bar-')) as Extract<Track, { type: 'text' }>[];
    expect(items.map((t) => [t.id, t.text, t.during])).toEqual([
      ['bar-1', 'Plan', { segment: 'shot-01', from: 0, to: 300 }], ['bar-1-shot-01', 'Plan', { segment: 'shot-01' }],
      ['bar-2', 'Build', { segment: 'shot-01', from: 0, to: 300 }], ['bar-2-shot-02', 'Build', { segment: 'shot-02' }],
      ['bar-3', 'Ship', { segment: 'shot-01', from: 0, to: 300 }],
    ]);
    // each word has the room up to halfway to its neighbours, around its own place
    const [first, , second] = items;
    expect((first?.box[0] ?? 0) + (first?.box[2] ?? 0)).toBeCloseTo((0.28 + 0.42) / 2, 3);
    expect(second?.box[0]).toBeCloseTo((0.28 + 0.42) / 2, 3);
    expect(r.notes.join(' ')).not.toContain('has a bar');
  });

  it('refuses a bar the reference does not have, more words than it has, and a bar that is not a list', () => {
    const errors = (t: TextTrack, bar: unknown): string[] => retarget({ measure, text: t, plan: withBar(bar) }).problems.filter((p) => p.level === 'error').map((p) => p.at + ': ' + p.message);
    expect(errors(text, ['x'])).toEqual(['bar: The reference has no bar of words to re-make.']);
    expect(errors(barText, ['a', 'b', 'c', 'd'])).toEqual(['bar: The reference\'s bar has 3 words; "bar" has 4.']);
    expect(errors(barText, 'Plan')).toHaveLength(1);
    expect(retarget({ measure, text: barText, plan: withBar() }).notes.join(' ')).toContain('The reference has a bar of 3 words laid on through the video ("Intro" "Setup" "Results")');
  });

  it('is kept by a template as places and marks, filled the same way, and named in TEMPLATE.md', async () => {
    const tpl = templateFrom({ measure, text: barText, name: 'bar', label: 'bar', hash: 'x' });
    expect(tpl.bar?.marked).toEqual([0, 1, -1]);
    expect(JSON.stringify(tpl)).not.toContain('Intro');
    // the bar's words are not places of a shot
    expect(tpl.shots.map((s) => s.words?.length ?? 0)).toEqual([0, 2, 1]);
    const p = withBar(['Plan', 'Build', 'Ship']);
    const bars = (t: Track[] | undefined): Track[] => (t ?? []).filter((x) => x.id.startsWith('bar-'));
    expect(bars(retarget({ ...retargetInputs(tpl), plan: p }).project?.tracks)).toEqual(bars(retarget({ measure, text: barText, plan: p }).project?.tracks));
    const s = slotsOf(tpl, undefined, { bar: ['Intro', 'Setup', 'Results'] });
    expect(s.bar?.words.map((w) => w.example?.text)).toEqual(['Intro', 'Setup', 'Results']);
    expect(s.bar?.words.every((w) => w.max.latin >= 5)).toBe(true);
    const rt = await createDiskRuntime();
    try {
      const problems = await checkFill(rt, { template: tpl, slots: s }, { ...p, bar: ['Plan', 'A much longer word than fits', 'Ship', 'Extra'] });
      expect(problems.filter((x) => x.at.startsWith('bar')).map((x) => [x.level, x.at])).toEqual([['error', 'bar']]);
      const long = await checkFill(rt, { template: tpl, slots: s }, { ...p, bar: ['Plan', 'A much longer word than fits', 'Ship'] });
      expect(long.filter((x) => x.at.startsWith('bar')).map((x) => [x.level, x.at])).toEqual([['warning', 'bar[1]']]);
    } finally {
      await rt.cleanup();
    }
    const card = templateCard(tpl, s, { text: barText, sourceFps: 30 }).text;
    expect(card).toContain('A bar of 3 words laid on through the video ("Intro" "Setup" "Results"), not a watermark; the marked word follows the shots: "Intro" shots[0], "Setup" shots[1]');
    expect(card).toContain('- bar: ["..."], 3 words');
  });
});
