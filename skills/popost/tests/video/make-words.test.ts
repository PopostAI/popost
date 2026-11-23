import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { CaptionTrack, Problem, Project, Span, TextTrack, Track, WordsFile, WordsInfo } from '../../src/video/types';
import { tokenize } from '../../src/video/align/index';
import { checkProject, checkProjectOnDisk } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { parseWordsFile } from '../../src/video/project/words';
import { loadWords } from '../../src/video/compile/words';
import { resolve } from '../../src/video/timeline/resolve';
import { unitRanges } from '../../src/video/timeline/cue-words';
import { toProjectFrames } from '../../src/video/timeline/words';
import { charsShown, revealedChars, tokenLook, tokenPhase } from '../../src/video/presets/spoken';
import { IDENTITY_ELEMENT } from '../../src/video/presets/motion';

/** The script, spoken one unit every per frames from frame first of the audio file (fps 30 unless given). */
const SCRIPT = '提示词一键复制，同款一键复刻';
const spoken = (text: string, first: number, per: number, fps = 30, sure = 1): WordsFile => ({
  fps, tokens: tokenize(text).map((t, k) => ({ text: t, start: first + k * per, end: first + (k + 1) * per, confidence: sure, matched: sure === 1 })),
});
const WORDS = spoken(SCRIPT, 10, 6);

const text = (id: string, during: Span, more: Partial<TextTrack> = {}): TextTrack => ({ id, type: 'text', text: id, box: [0.1, 0.1, 0.8, 0.1], during, ...more });

/**
 * Two 60-frame segments. The voice starts at frame 5, so its unit k is on frames 15 + 6k .. 20 + 6k: "一键复制" on
 * 33..56, the second "一键" on 69..80. Items: one on "一键复制" (lead 3, hold 6), one on the second "一键", one by frames.
 */
const project = (more: Track[] = []): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'voice', kind: 'audio', file: 'assets/voice.wav', words: 'assets/voice.words.json' }],
  segments: [{ id: 'a', frames: 60, base: { color: '#101820' } }, { id: 'b', frames: 60, base: { color: '#201018' } }],
  tracks: [
    { id: 'vo', type: 'audio', material: 'voice', during: { segment: 'a', from: 5, to: 120 } },
    text('copy', { phrase: '一键复制', lead: 3, hold: 6 }),
    text('again', { phrase: '一键', occurrence: 2 }),
    { id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.8, 0.8, 0.05], during: { segment: 'b', from: 10, to: 30 } },
    ...more,
  ],
});
const table = (w: WordsInfo = WORDS): Record<string, WordsInfo> => ({ voice: w });

const complete = (p: Problem): void => {
  expect(p.at.length, JSON.stringify(p)).toBeGreaterThan(0);
  expect(p.message.length, JSON.stringify(p)).toBeGreaterThan(0);
  expect(p.fix?.length ?? 0, JSON.stringify(p)).toBeGreaterThan(0);
};
const problemsOf = (p: Project, words: Record<string, WordsInfo> = table()): Problem[] => {
  const all = [...parseProject(p).problems, ...checkProject(p, { words })];
  all.forEach(complete);
  return all;
};
const find = (problems: Problem[], at: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === at && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + at + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};
const withSpan = (during: Span): Project => {
  const p = project();
  (p.tracks[1] as TextTrack).during = during;
  return p;
};
const item = (p: Project, id: string, words: Record<string, WordsInfo> = table()) => resolve(p, {}, words).items.find((i) => i.id === id);

describe('words: format and check', () => {
  it('accepts words on an audio material, phrase spans, and a caption track that follows the words', () => {
    const subs: CaptionTrack = { id: 'subs', type: 'caption', box: [0, 0.8, 1, 0.1], words: true, reveal: 'words', enter: { preset: 'type' },
      style: { size: 0.05, spoken: { color: '#ffd000', weight: 900, scale: 1.2, background: { color: '#000000' }, past: { opacity: 0.6 } } }, cues: [{ text: '提示词，一键复制', during: { phrase: '提示词一键复制' } }] };
    const p = project([subs]);
    expect(parseProject(p).problems).toEqual([]);
    expect(checkProject(p, { words: table() })).toEqual([]);
  });

  it('checks the words file: on an audio material, readable, one unit per token, in order', () => {
    const order = parseWordsFile({ fps: 30, tokens: [{ text: '一', start: 0, end: 6 }, { text: '键', start: 4, end: 9 }] }, 'v.json');
    expect(order).toMatchObject({ error: expect.stringContaining('token 1 ("键", frames 4..8) starts before token 0 ("一") ends (frame 6)') as unknown });
    expect(parseWordsFile({ fps: 30, tokens: [{ text: '一键', start: 0, end: 6 }] }, 'v.json')).toMatchObject({ fix: expect.stringContaining('Split it into 2 tokens') as unknown });
    expect(parseWordsFile({ fps: 30, tokens: [{ text: '，', start: 0, end: 6 }] }, 'v.json')).toMatchObject({ fix: expect.stringContaining('Remove it') as unknown });
    expect(parseWordsFile({ tokens: [] }, 'v.json')).toMatchObject({ error: expect.stringContaining('fps is missing') as unknown });
    expect(parseWordsFile({ fps: 30, tokens: [{ text: 'Go', start: 0, end: 3 }] }, 'v.json')).toEqual({ fps: 30, tokens: [{ text: 'Go', start: 0, end: 3, confidence: 1, matched: true }] });
    const bad = parseWordsFile({ fps: 30, tokens: [{ text: '一', start: 5, end: 5 }] }, 'v.json');
    expect(find(problemsOf(project(), table(bad)), 'materials[0].words').message).toContain('ends (end 5) where or before it starts');
    const onImage = project();
    onImage.materials.push({ id: 'pic', kind: 'image', file: 'assets/a.webp', words: 'assets/a.json' });
    expect(find(problemsOf(onImage), 'materials[1].words').message).toContain('"words" belongs to an audio material');
  });

  it('needs a sound with a words file for a phrase anchor, and says which sound when there are several', () => {
    const none = project();
    delete none.materials[0]?.words;
    const p = find(problemsOf(none, {}), 'tracks[1].during.phrase');
    expect(p.message).toContain('phrase anchors need a sound with a words file');
    expect(p.fix).toContain('"words"');
    const two = project([{ id: 'vo2', type: 'audio', material: 'voice', during: { segment: 'b' } }]);
    expect(find(problemsOf(two), 'tracks[1].during.of').allowed).toEqual(['vo', 'vo2']);
    expect(find(problemsOf(withSpan({ phrase: '一键复制', of: 'music' })), 'tracks[1].during.of').message).toContain('there is no audio track "music"');
    expect(problemsOf(withSpan({ phrase: '一键复制', of: 'vo' })).filter((x) => x.level === 'error')).toEqual([]);
    const placed = project();
    placed.tracks[0] = { id: 'vo', type: 'audio', material: 'voice', during: { phrase: '一键' } };
    expect(find(problemsOf(placed), 'tracks[0].during.phrase').fix).toContain('"segment" and "from"');
  });

  it('lists the nearest phrases that are in the words when a phrase is not, at most three', () => {
    const p = find(problemsOf(withSpan({ phrase: '一键复印' })), 'tracks[1].during.phrase');
    expect(p.message).toContain('which is not in the words of audio track "vo"');
    expect(p.allowed?.length).toBeLessThanOrEqual(3);
    expect(p.allowed?.[0]).toBe('一键复制');
    expect(p.message).toContain('"一键复制" (at 1.10 s)');
    expect(p.fix).toContain('"phrase": "一键复制"');
  });

  it('asks which occurrence when a phrase is spoken more than once, with where, and refuses one out of range', () => {
    const p = find(problemsOf(withSpan({ phrase: '一键' })), 'tracks[1].during.occurrence');
    expect(p.message).toContain('is spoken 2 times in the words of "vo": at 1.10 s, 2.30 s');
    expect(p.fix).toContain('"occurrence": 1 to 2');
    expect(p.allowed).toEqual(['1', '2']);
    expect(find(problemsOf(withSpan({ phrase: '一键', occurrence: 3 })), 'tracks[1].during.occurrence').message).toContain('spoken only 2 times');
  });

  it('warns that the time of a phrase is a guess below confidence 0.4, with the frames it will use', () => {
    const unsure: WordsFile = { ...WORDS, tokens: WORDS.tokens.map((t, k) => (k === 4 ? { ...t, confidence: 0.2, matched: false } : t)) };
    const w = find(problemsOf(project(), table(unsure)), 'tracks[1].during.phrase', 'warning');
    expect(w.message).toContain('is a guess');
    expect(w.message).toContain('frames 30..62');
  });

  it('refuses from / to on a phrase span with the way to write it, and warns about fields that do nothing', () => {
    const p = find(problemsOf(withSpan({ phrase: '一键复制', from: 3 })), 'tracks[1].during.from');
    expect(p.message).toContain('"from" and "to" cannot be combined with "phrase"');
    expect(p.fix).toContain('"lead"');
    find(problemsOf(withSpan({ phrase: '一键复制', segment: 'a' })), 'tracks[1].during.segment', 'warning');
    find(problemsOf(withSpan({ segment: 'a', lead: 4 })), 'tracks[1].during.lead', 'warning');
    expect(find(problemsOf(withSpan({ phrase: '一键复制', lead: -20, hold: -10 })), 'tracks[1].during').message).toContain('leave no frame');
    expect(parseProject(withSpan({ from: 3 })).problems.map((x) => x.at)).toEqual(['tracks[1].during']);
  });

  it('checks a caption track that follows the words: the sound, reveal and spoken without words, and cues off their words', () => {
    const caption = (more: Partial<CaptionTrack>, cue = { text: '提示词', during: { phrase: '提示词' } as Span }): CaptionTrack =>
      ({ id: 'subs', type: 'caption', box: [0, 0.8, 1, 0.1], cues: [cue], ...more });
    const none = project([caption({ words: true })]);
    delete none.materials[0]?.words;
    none.tracks = none.tracks.filter((t) => t.id !== 'copy' && t.id !== 'again');
    expect(find(problemsOf(none, {}), 'tracks[2].words').message).toContain('captions that follow the words need a sound with a words file');
    expect(find(problemsOf(project([caption({ reveal: 'words' })])), 'tracks[4].reveal').fix).toContain('"words": true');
    expect(find(problemsOf(project([caption({ style: { spoken: { color: '#ff0' } } })])), 'tracks[4].style.spoken', 'warning').message).toContain('has no effect');
    const off = find(problemsOf(project([caption({ words: 'vo' }, { text: '同款一键复刻', during: { segment: 'a', from: 0, to: 30 } })])), 'tracks[4].cues[0].text', 'warning');
    expect(off.message).toContain('matches only 0% of the words spoken during it (frames 0..29: "提示词")');
    expect(off.fix).toContain('"phrase": "同款一键复刻"');
    find(problemsOf(project([caption({ words: true }, { text: '提示词', during: { segment: 'b', from: 40 } })])), 'tracks[4].cues[0].during', 'warning');
    find(problemsOf(project([text('t', { segment: 'a' }, { style: { spoken: { color: '#ff0' } } })])), 'tracks[4].style.spoken', 'warning');
  });

  it('warns about unknown fields of spoken and refuses a scale above 1.3', () => {
    const subs = { id: 'subs', type: 'caption', box: [0, 0.8, 1, 0.1], words: true, cues: [{ text: '提示词', during: { phrase: '提示词' } }], style: { spoken: { colour: '#fff', scale: 1.5, past: { opacty: 0.5 } } } };
    const problems = parseProject({ ...project(), tracks: [...project().tracks, subs] }).problems;
    expect(problems.map((x) => [x.level, x.at])).toEqual([['error', 'tracks[4].style.spoken.scale'], ['warning', 'tracks[4].style.spoken.colour'], ['warning', 'tracks[4].style.spoken.past.opacty']]);
  });

  describe('with a project directory', () => {
    let dir = '';
    let rt: DiskRuntime;
    beforeAll(async () => {
      rt = await createDiskRuntime();
      dir = await mkdtemp(path.join(tmpdir(), 'make-words-'));
      await mkdir(path.join(dir, 'assets'));
      await writeFile(path.join(dir, 'assets', 'voice.wav'), 'x');
    });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); await rt.cleanup(); });

    it('reads words files, reports one that is missing or not JSON, and leaves out one that does not exist', async () => {
      expect(await loadWords(rt, project(), dir)).toEqual({});
      expect(find(await checkProjectOnDisk(rt, project(), dir), 'materials[0].words').message).toContain('does not exist');
      await writeFile(path.join(dir, 'assets', 'voice.words.json'), '{ "fps": 30, ');
      const broken = await loadWords(rt, project(), dir);
      expect(find(await checkProjectOnDisk(rt, project(), dir, { words: broken }), 'materials[0].words').message).toContain('is not valid JSON');
      await writeFile(path.join(dir, 'assets', 'voice.words.json'), JSON.stringify(WORDS));
      const words = await loadWords(rt, project(), dir);
      expect(words.voice).toEqual(WORDS);
      expect(await checkProjectOnDisk(rt, project(), dir, { words })).toEqual([]);
    });
  });
});

describe('words: resolve', () => {
  it('puts a phrase-anchored item on its words, with lead and hold, and the asked occurrence', () => {
    expect([item(project(), 'copy')?.start, item(project(), 'copy')?.end]).toEqual([30, 63]);
    expect([item(project(), 'again')?.start, item(project(), 'again')?.end]).toEqual([69, 81]);
    expect([item(project(), 'bar')?.start, item(project(), 'bar')?.end]).toEqual([70, 90]);
    const r = resolve(project(), {}, table());
    expect(r.words?.[0]?.track).toBe('vo');
    expect(r.words?.[0]?.tokens.slice(3, 5)).toEqual([{ text: '一', start: 33, end: 39, confidence: 1 }, { text: '键', start: 39, end: 45, confidence: 1 }]);
    expect(() => resolve(project())).toThrow(/anchored to the phrase "一键复制", but the words it is in were not read/);
  });

  it('converts the words file\'s frames to the project\'s rate (25 -> 30 fps)', () => {
    expect(toProjectFrames([{ text: '一', start: 25, end: 30, confidence: 1, matched: true }, { text: '键', start: 30, end: 31, confidence: 1, matched: true }], 25, 30)).toEqual([{ start: 30, end: 36 }, { start: 36, end: 37 }]);
    // At 25 fps, unit k of the script is on 25 + 5k .. 29 + 5k: "一键复制" on 40..59 there, 48..71 at 30 fps, plus 5.
    const at25 = spoken(SCRIPT, 25, 5, 25);
    expect([item(project(), 'copy', table(at25))?.start, item(project(), 'copy', table(at25))?.end]).toEqual([53 - 3, 77 + 6]);
  });

  it('moves every phrase-anchored item with its words when the words change, and keeps every frame-anchored item', () => {
    const subs: CaptionTrack = { id: 'subs', type: 'caption', box: [0, 0.8, 1, 0.1], words: true, cues: [{ text: '提示词一键复制', during: { phrase: '提示词一键复制', lead: 4 } }, { text: '同款一键复刻', during: { phrase: '同款一键复刻' } }] };
    const p = project([subs, text('late', { segment: 'b', from: 40 })]);
    const fast = resolve(p, {}, table(spoken(SCRIPT, 4, 4)));
    const slow = resolve(p, {}, table(spoken(SCRIPT, 10, 8)));
    const at = (r: typeof fast, id: string): [number, number] => {
      const it = r.items.find((x) => x.id === id);
      return [it?.start ?? -1, it?.end ?? -1];
    };
    // Unit k of the script: fast on 9 + 4k .. 12 + 4k, slow on 15 + 8k .. 22 + 8k (the voice starts at frame 5).
    const unit = (r: 'fast' | 'slow', k: number, edge: 'start' | 'end'): number => (r === 'fast' ? 9 + 4 * k : 15 + 8 * k) + (edge === 'end' ? (r === 'fast' ? 4 : 8) : 0);
    for (const [name, r] of [['fast', fast], ['slow', slow]] as const) {
      expect(at(r, 'copy'), name).toEqual([unit(name, 3, 'start') - 3, unit(name, 6, 'end') + 6]);
      expect(at(r, 'again'), name).toEqual([unit(name, 9, 'start'), unit(name, 10, 'end')]);
      expect(at(r, 'subs#0'), name).toEqual([unit(name, 0, 'start') - 4, unit(name, 6, 'end')]);
      expect(at(r, 'subs#1'), name).toEqual([unit(name, 7, 'start'), unit(name, 12, 'end')]);
      expect(r.items.find((x) => x.id === 'subs#1')?.words?.map((w) => w.start), name).toEqual([7, 8, 9, 10, 11, 12].map((k) => unit(name, k, 'start')));
    }
    const moved = ['copy', 'again', 'subs#0', 'subs#1'].filter((id) => at(fast, id)[0] !== at(slow, id)[0] && at(fast, id)[1] !== at(slow, id)[1]);
    expect(moved).toEqual(['copy', 'again', 'subs#0', 'subs#1']);
    for (const id of ['bar', 'late']) expect(at(fast, id), id).toEqual(at(slow, id));
    expect(fast.segments).toEqual(slow.segments);
    expect(fast.audio).toEqual(slow.audio);
  });

  it('gives each token of a cue that follows the words its characters and frames; reveal replaces a type entrance', () => {
    const subs: CaptionTrack = { id: 'subs', type: 'caption', box: [0, 0.8, 1, 0.1], words: 'vo', reveal: 'words', enter: { preset: 'type' }, exit: { preset: 'fade', frames: 4 },
      style: { spoken: { color: '#ffd000' } }, cues: [{ text: '「提示词，一键复制」', during: { phrase: '提示词一键复制', lead: 2 } }] };
    const cue = resolve(project([subs]), {}, table()).items.find((x) => x.id === 'subs#0');
    expect(cue?.words?.map((w) => [w.from, w.to, w.start, w.end])).toEqual([[1, 2, 15, 21], [2, 3, 21, 27], [3, 4, 27, 33], [5, 6, 33, 39], [6, 7, 39, 45], [7, 8, 45, 51], [8, 9, 51, 57]]);
    expect(cue).toMatchObject({ start: 13, end: 57, reveal: 'words', enter: { preset: 'none', frames: 0 }, exit: { preset: 'fade', frames: 4 }, style: { spoken: { color: '#ffd000' } } });
    const plain = resolve(project([{ ...subs, words: false, reveal: undefined, style: { spoken: { color: '#ffd000' } } }]), {}, table()).items.find((x) => x.id === 'subs#0');
    expect(plain?.words).toBeUndefined();
    expect(plain?.style?.spoken).toBeUndefined();
    expect(plain?.enter.preset).toBe('type');
  });

  it('cuts text into units by code point the way the aligner counts them', () => {
    for (const s of ['今天带来的是 Popost 提示词库，12800+ 条！', '「Go!」 a😀b 一', ' ，。 ']) expect(unitRanges(s).map((r) => Array.from(s).slice(r.from, r.to).join('').toLowerCase()), s).toEqual(tokenize(s));
    expect(unitRanges('a😀bc 一')).toEqual([{ from: 0, to: 1 }, { from: 2, to: 4 }, { from: 5, to: 6 }]);
  });
});

describe('words: the look of a token as a pure function of the frame', () => {
  const words = [{ from: 1, to: 2, start: 10, end: 16 }, { from: 3, to: 5, start: 16, end: 20 }, { from: 6, to: 7, start: 24, end: 30 }];
  it('is before, spoken, then past; spoken and past looks come from the style, with the base before', () => {
    expect([9, 10, 15, 16].map((n) => tokenPhase(words[0] as (typeof words)[0], n))).toEqual(['before', 'spoken', 'spoken', 'past']);
    const style = { color: '#f00', weight: 900, scale: 1.2, background: { color: '#000' }, past: { color: '#0f0', opacity: 0.5 } };
    expect(tokenLook(style, 'before')).toEqual({ scale: 1, background: false });
    expect(tokenLook(style, 'spoken')).toEqual({ color: '#f00', weight: 900, scale: 1.2, background: true });
    expect(tokenLook(style, 'past')).toEqual({ color: '#0f0', opacity: 0.5, scale: 1, background: false });
    expect(tokenLook({ color: '#f00' }, 'past')).toEqual({ scale: 1, background: false });
  });

  it('reveals each token when it is spoken, with the characters after it up to the next token', () => {
    // "「a，bc d" by code point: 「 a ， b c space d.
    expect([9, 10, 16, 20, 23, 24, 40].map((n) => revealedChars(words, 7, n))).toEqual([0, 3, 6, 6, 6, 7, 7]);
    const reveal = { words, reveal: 'words' as const };
    expect(charsShown(reveal, IDENTITY_ELEMENT, 7, 17)).toBe(6);
    expect(charsShown(reveal, { ...IDENTITY_ELEMENT, chars: 0.5 }, 7, 30)).toBe(4);
    expect(charsShown({ words }, IDENTITY_ELEMENT, 7, 0)).toBe(7);
  });
});
