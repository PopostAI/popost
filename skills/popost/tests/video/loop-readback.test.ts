import { describe, expect, it } from 'vitest';
import { closeness, readback } from '../../src/video/eval/readback';
import { toFrames } from '../../src/video/speech/index';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Resolved, ResolvedItem, ResolvedMotion } from '../../src/video/types';

const none: ResolvedMotion = { preset: 'none', frames: 0, ease: 'linear', overshoot: 0, direction: 'up', distance: 0 };
const item = (id: string, text: string, start: number, end: number, cueIndex?: number): ResolvedItem => ({
  id, type: 'text', start, end, box: [0.08, 0.82, 0.84, 0.16], z: 0, enter: none, exit: none, text,
  ...(cueIndex === undefined ? {} : { cue: { track: 'captions', index: cueIndex } }),
});
const resolved = (items: ResolvedItem[], voiced: boolean): Resolved => ({
  canvas: { width: 1280, height: 720, fps: 30 }, frames: 300,
  segments: [{ id: 's', index: 0, start: 0, end: 300, base: { kind: 'color', color: '#000000' } }],
  items, audio: voiced ? [{ id: 'sound', src: 'assets/voice.m4a', start: 0, gain: 0 }] : [],
});
const cue = (text: string, start: number, end: number, y = 0.86): TextCue => ({ text, start, end, box: [0.3, y, 0.4, 0.08], role: 'caption', size: 0.08, samples: 5, confidence: 0.95 });
const track = (cues: TextCue[]): TextTrack => ({ step: 6, sampled: 50, cues });

describe('readback', () => {
  it('measures how close a reading is to the words that should be there', () => {
    expect(closeness('提示词一键复制', '提示词一键复制')).toBe(1);
    expect(closeness('12800+ 爆款 · 15 国家', '12800+爆款·15国家')).toBe(1);
    expect(closeness('提示词一键复制', '提示词键复制')).toBeCloseTo(6 / 7, 2);
    expect(closeness('一个库就能找到', 'Sign in')).toBeLessThan(0.2);
    expect(closeness('快去试试吧', '')).toBe(0);
    // A reader that joined the line to its neighbour still found it.
    expect(closeness('十五个国家', '产品十五个国家首页')).toBe(1);
  });

  it('finds a legible caption, flags one that cannot be read, and one the reader read wrongly', () => {
    const r = readback(resolved([item('captions#0', '这种能卖爆的带货视频', 0, 60, 0), item('captions#1', '提示词一键复制', 60, 120, 1), item('captions#2', '快去试试吧', 120, 180, 2)], false),
      track([cue('这种能卖爆的带货视频', 0, 57), cue('键复制', 63, 117), cue('unrelated', 120, 180, 0.1)]));
    expect(r.lines.map((l) => l.legible)).toEqual([1, 0.43, 0]);
    expect(r.legibleShare).toBeCloseTo(0.33, 2);
    expect(r.problems.map((p) => [p.level, p.at])).toEqual([['warning', 'items.captions#1'], ['error', 'items.captions#2']]);
    expect(r.problems[1]?.message).toContain('the reader saw nothing there');
    expect(r.heardShare).toBeUndefined();
  });

  it('checks that spoken lines are heard and how captions and words line up', () => {
    const transcript = toFrames({ language: 'zh', words: [
      { text: '一个', start: 0.1, end: 0.4, confidence: 0.9 }, { text: '库', start: 0.4, end: 0.6, confidence: 0.9 }, { text: '就能找到,', start: 0.6, end: 1.2, confidence: 0.9 },
      // the second line starts 20 frames before its caption; the third line is silent
      { text: '克里普', start: 2.0 - 20 / 30, end: 2.4, confidence: 0.4 }, { text: '提示词库', start: 2.4, end: 3.2, confidence: 0.9 },
    ] }, 30);
    const r = readback(resolved([item('captions#0', '一个库就能找到', 3, 55, 0), item('captions#1', 'Popost 提示词库', 60, 115, 1), item('captions#2', '快去试试吧', 130, 180, 2)], true),
      track([cue('一个库就能找到', 3, 55), cue('Popost提示词库', 60, 115), cue('快去试试吧', 130, 180)]),
      { transcript, spokenTrack: 'captions', spokenForms: ['一个库就能找到', 'pop post 提示词库', '快去试试吧'] });
    expect(r.legibleShare).toBe(1);
    expect(r.lines[0]).toMatchObject({ heardScore: 1, lag: 0 });
    // The brand name was misheard, but about as much was heard as was written: the line counts as heard.
    expect(r.lines[1]?.heardScore).toBeGreaterThanOrEqual(0.5);
    expect(r.lines[1]?.lag).toBe(20);
    expect(r.lines[2]?.heardScore).toBe(0);
    expect(r.heardShare).toBeCloseTo(0.67, 2);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]?.message).toContain('The caption "Popost 提示词库" appears 20 frames after its first word');
    expect(r.problems[1]?.message).toContain('The line "快去试试吧" was not heard in the render');
  });
});
