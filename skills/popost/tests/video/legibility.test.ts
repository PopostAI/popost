import { describe, expect, it } from 'vitest';
import { readback } from '../../src/video/eval/readback';
import { lineSize, shotTextSizes, SMALL_TEXT } from '../../src/video/eval/legibility';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Resolved } from '../../src/video/types';

/** 1280x720 at 30 fps: three shots of 3 s, 3 s and 2 s. */
const resolved: Resolved = {
  canvas: { width: 1280, height: 720, fps: 30 }, frames: 240,
  segments: [
    { id: 'page', index: 0, start: 0, end: 90, base: { kind: 'color', color: '#ffffff' } },
    { id: 'title', index: 1, start: 90, end: 180, base: { kind: 'color', color: '#ffffff' } },
    { id: 'flash', index: 2, start: 180, end: 240, base: { kind: 'color', color: '#ffffff' } },
  ],
  items: [], audio: [],
};
/** A line read at font size px: its box as wide as that size gives its characters (an em each, 0.48 for Latin), 16 px tall at least. */
const line = (text: string, px: number, start: number, end: number, role: TextCue['role'] = 'in-picture'): TextCue => {
  const ems = Array.from(text).reduce((n, c) => n + (/[\u{4e00}-\u{9fff}]/u.test(c) ? 1 : 0.48), 0);
  return { text, start, end, box: [0.1, 0.4, (ems * px) / 1280, Math.max(16, px * 1.3) / 720], role, size: Math.max(16, px * 1.3) / 720, samples: 5, confidence: 0.9 };
};
const track = (cues: TextCue[]): TextTrack => ({ step: 6, sampled: 40, cues });

describe('text size in a render', () => {
  it('takes a line\'s size from its width, never above its box, and leaves short lines alone', () => {
    expect(lineSize(line('每月只要九十九元', 9, 0, 90), 1280, 720)).toBeCloseTo(9 / 720, 4);
    expect(lineSize(line('Billed yearly at 99', 13, 0, 90), 1280, 720)).toBeCloseTo(13 / 720, 4);
    // A reader that joined two columns: the width says more than the box does, and the box wins.
    expect(lineSize({ text: '价格 九十九元', box: [0, 0, 0.9, 0.03], size: 0.03 }, 1280, 720)).toBe(0.03);
    expect(lineSize(line('OK', 6, 0, 90), 1280, 720)).toBeUndefined();
  });

  it('gives each shot its smallest and median size, and warns where lasting text is under the floor', () => {
    const r = shotTextSizes(resolved, track([
      line('每月只要九十九元', 9, 0, 90), line('三分钟学会全部功能', 11, 10, 80), line('Free for fourteen days', 20, 0, 90),
      line('专业版包含高级报表', 40, 90, 180),
      // Small, but on screen half a second: not reported.
      line('客服全天在线回复', 8, 190, 205),
      // A brand mark through the whole video is a watermark, small on purpose.
      line('brand.example', 8, 0, 240, 'watermark'),
    ]));
    expect(r.shots).toEqual([
      { at: 'segments[0]', id: 'page', seconds: [0, 3], lines: 3, smallest: 0.0125, median: 0.0153 },
      { at: 'segments[1]', id: 'title', seconds: [3, 6], lines: 1, smallest: 0.0556, median: 0.0556 },
      { at: 'segments[2]', id: 'flash', seconds: [6, 8], lines: 0 },
    ]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ level: 'warning', at: 'segments[0]' });
    expect(r.problems[0]?.message).toBe('Shot page (0-3 s): 2 line(s) of text that stay a second or more are smaller than the 1.8% of the height a phone needs, the smallest 1.3% (9 px of 720): "每月只要九十九元", "三分钟学会全部功能".');
    expect(r.problems[0]?.fix).toContain('--scale 2');
    expect(SMALL_TEXT).toBe(0.018);
  });

  it('is part of readback: readback.json has the shots, and the warning is among its problems', () => {
    const r = readback(resolved, track([line('每月只要九十九元', 9, 0, 90)]));
    expect(r.shots.map((s) => s.lines)).toEqual([1, 0, 0]);
    expect(r.problems.map((p) => p.at)).toEqual(['segments[0]']);
    expect(r.legibleShare).toBe(1);
  });
});
