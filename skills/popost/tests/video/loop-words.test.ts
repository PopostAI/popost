import { describe, expect, it } from 'vitest';
import { chunksOf, lineTokens, voiceWords } from '../../src/video/retarget/words';
import { toFrames } from '../../src/video/speech/index';

const say = [{ text: 'Popost', as: 'pop post' }, { text: 'AI', as: 'A I' }];

describe('words of a spoken track', () => {
  it('cuts a line where a spoken form applies', () => {
    expect(chunksOf('今天带来 Popost 提示词库', say)).toEqual([{ written: '今天带来 ', spoken: '今天带来 ' }, { written: 'Popost', spoken: 'pop post' }, { written: ' 提示词库', spoken: ' 提示词库' }]);
    expect(chunksOf('没有名字', say)).toEqual([{ written: '没有名字', spoken: '没有名字' }]);
    expect(chunksOf('AI 和 AI', say).map((c) => c.spoken)).toEqual(['A I', ' 和 ', 'A I']);
  });

  it('spreads a line evenly when nothing was transcribed, as written tokens', () => {
    // "Popost 提示词库": spoken as pop + post + 4 characters = 6 units over 60 frames; the name is ONE written token of 20 frames.
    const tokens = lineTokens('Popost 提示词库', say, 100, 160);
    expect(tokens.map((t) => [t.text, t.start, t.end])).toEqual([['popost', 100, 120], ['提', 120, 130], ['示', 130, 140], ['词', 140, 150], ['库', 150, 160]]);
    expect(tokens.every((t) => t.confidence === 0.3)).toBe(true);
  });

  it('takes times from what was heard, and gives a name the time of its spoken form', () => {
    const heard = toFrames({ language: 'zh', words: [
      { text: 'pop', start: 5.0, end: 5.3, confidence: 0.9 }, { text: ' post', start: 5.3, end: 5.7, confidence: 0.9 },
      { text: '提', start: 5.7, end: 5.9, confidence: 0.9 }, { text: '示', start: 5.9, end: 6.1, confidence: 0.9 }, { text: '词', start: 6.1, end: 6.3, confidence: 0.9 }, { text: '库', start: 6.3, end: 6.6, confidence: 0.9 },
    ] }, 30).words;
    const tokens = lineTokens('Popost 提示词库', say, 150, 200, heard);
    expect(tokens.map((t) => [t.text, t.start, t.end, t.matched])).toEqual([['popost', 150, 171, true], ['提', 171, 177, true], ['示', 177, 183, true], ['词', 183, 189, true], ['库', 189, 198, true]]);
  });

  it('puts the lines of a track on one clock and skips lines that are not spoken', () => {
    const transcript = toFrames({ language: 'zh', words: [
      { text: '一个', start: 0.1, end: 0.4, confidence: 0.9 }, { text: '库', start: 0.4, end: 0.7, confidence: 0.9 },
      { text: '快', start: 2.0, end: 2.2, confidence: 0.9 }, { text: '去', start: 2.2, end: 2.5, confidence: 0.9 },
    ] }, 30);
    const w = voiceWords({ lines: ['一个库', '', '快去'], starts: [0, 40, 58], frames: [24, 0, 18], fps: 30, transcript });
    expect(w.estimated).toBe(false);
    expect(w.tokens.map((t) => [t.text, t.start, t.end])).toEqual([['一', 3, 8], ['个', 8, 12], ['库', 12, 21], ['快', 60, 66], ['去', 66, 75]]);
    const guessed = voiceWords({ lines: ['一个库', '', '快去'], starts: [0, 40, 58], frames: [24, 0, 18], fps: 30 });
    expect(guessed.estimated).toBe(true);
    expect(guessed.tokens.map((t) => [t.text, t.start, t.end])).toEqual([['一', 0, 8], ['个', 8, 16], ['库', 16, 24], ['快', 58, 67], ['去', 67, 76]]);
  });
});
