import { describe, expect, it } from 'vitest';
import { describeReference } from '../../src/video/describe/index';
import { joinWords, phrasesOf, toFrames } from '../../src/video/speech/index';
import type { Measure } from '../../src/video/types';

const raw = {
  language: 'zh',
  words: [
    { text: '这', start: 0.0, end: 0.38, confidence: 0.45 }, { text: '种', start: 0.38, end: 0.56, confidence: 0.99 },
    { text: '动效,', start: 0.56, end: 1.0, confidence: 0.9 },
    // a pause of 0.5 s, then a name the recogniser split into pieces
    { text: ' An', start: 1.5, end: 1.7, confidence: 0.3 }, { text: 'ime', start: 1.7, end: 1.9, confidence: 0.5 }, { text: ' is', start: 1.9, end: 2.0, confidence: 0.9 },
    { text: ' good', start: 2.0, end: 2.3, confidence: 0.95 }, { text: '', start: 2.3, end: 2.3, confidence: 0 },
  ],
};

describe('speech', () => {
  const t = toFrames(raw, 30);

  it('turns seconds into frames and joins the pieces of a split word', () => {
    expect(t.words.map((w) => [w.text, w.start, w.end])).toEqual([['这', 0, 11], ['种', 11, 17], ['动效,', 17, 30], ['Anime', 45, 57], ['is', 57, 60], ['good', 60, 69]]);
    expect(t.words[3]?.confidence).toBe(0.3);
  });

  it('never lets a word start before the one before it ends, and gives every word a frame', () => {
    const tight = toFrames({ language: 'en', words: [{ text: ' a', start: 1, end: 1.001, confidence: 1 }, { text: ' b', start: 1.0, end: 1.002, confidence: 1 }] }, 30);
    expect(tight.words.map((w) => [w.start, w.end])).toEqual([[30, 31], [31, 32]]);
  });

  it('writes CJK without spaces and other words with them', () => {
    expect(joinWords(t.words.slice(0, 3))).toBe('这种动效,');
    expect(joinWords(t.words.slice(3))).toBe('Anime is good');
    expect(joinWords([{ text: 'SVG' }, { text: '变形' }, { text: 'now' }, { text: ',' }, { text: 'ok' }])).toBe('SVG变形now, ok');
  });

  it('splits phrases after a clause even without a pause', () => {
    const fluent = toFrames({ language: 'zh', words: [
      { text: '第一句，', start: 0, end: 0.5, confidence: 1 }, { text: '第二', start: 0.5, end: 0.8, confidence: 1 }, { text: '句。', start: 0.8, end: 1.0, confidence: 1 }, { text: '第三句', start: 1.0, end: 1.5, confidence: 1 },
    ] }, 30);
    expect(phrasesOf(fluent).map((p) => p.text)).toEqual(['第一句，', '第二句。', '第三句']);
  });

  it('splits phrases at pauses', () => {
    const phrases = phrasesOf(t);
    expect(phrases.map((p) => [p.text, p.start, p.end])).toEqual([['这种动效,', 0, 30], ['Anime is good', 45, 69]]);
    expect(phrases[1]?.confidence).toBeCloseTo((0.3 + 0.9 + 0.95) / 3, 2);
  });

  it('puts what is said into the timeline and marks unsure phrases', () => {
    const m: Measure = {
      version: 1, source: { width: 1280, height: 720, fps: 30, frames: 90, duration: 3, hasAudio: true },
      boundaries: [{ frame: 40, kind: 'cut', start: 39, end: 40, confidence: 1 }],
      shots: [
        { index: 0, start: 0, end: 40, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '', palette: [], events: [] },
        { index: 1, start: 40, end: 90, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '', palette: [], events: [] },
      ],
      rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
    };
    const d = describeReference(m, undefined, 'case', toFrames({ ...raw, words: raw.words.map((w) => (w.text === ' is' || w.text === ' good' ? { ...w, confidence: 0.4 } : w)) }, 30));
    const lines = (d.files['timeline.md'] ?? '').split('\n').filter((l) => l.startsWith('#0'));
    expect(lines[0]).toContain('beat 0');
    expect(lines[1]).toContain('beat 1');
    // No caption was read: every phrase is a beat that was only said.
    expect(d.files['timeline.md']).toContain('\n0 0.00-1.00 spoken only "这种动效,"\n1 1.50-2.30 spoken only "Anime is good" (unsure)\n');
    expect(d.files['REFERENCE.md']).toContain('Speech: language zh, 6 words in 2 phrases');
    expect(d.files['shots/02.md']).toContain('Anime@45 is@57 good@60');
  });
});
