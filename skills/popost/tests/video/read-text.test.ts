import { describe, expect, it } from 'vitest';
import { buildCues, editDistance } from '../../src/video/text/cues';
import { captionBandOf, mergeBandSamples, readableBand } from '../../src/video/text/index';
import type { TextLine, TextSample } from '../../src/video/text/types';

const line = (text: string, y: number, h = 0.07, x = 0.3, w = 0.4, confidence = 0.95): TextLine => ({ text, confidence, box: [x, y, w, h] });

/** 30 fps, a sample every 6 frames. Each entry: [first sample, last sample, line]. */
const samplesOf = (count: number, spans: [number, number, TextLine][]): TextSample[] =>
  Array.from({ length: count }, (_, k) => ({ frame: k * 6, lines: spans.filter(([a, b]) => k >= a && k <= b).map(([, , l]) => l) }));

const opts = (count: number) => ({ step: 6, total: count * 6, fps: 30 });

describe('text cues', () => {
  it('measures the edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('一个库就能搞定', '一个库就能搞定')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('joins a line seen in consecutive samples into one cue, with edges half a step out', () => {
    const track = buildCues(samplesOf(20, [[2, 9, line('这种丝滑的网页动效', 0.9)]]), opts(20));
    expect(track.cues).toHaveLength(1);
    expect(track.cues[0]).toMatchObject({ text: '这种丝滑的网页动效', start: 9, end: 57, samples: 8, size: 0.07 });
  });

  it('keeps a cue whole when the reader misreads a character or misses one sample', () => {
    const spans: [number, number, TextLine][] = [[0, 3, line('GitHub斩获七万多星标', 0.9)], [5, 5, line('GitHub获七万多星标', 0.9)], [6, 9, line('GitHub斩获七万多星标', 0.9)]];
    const track = buildCues(samplesOf(12, spans), opts(12));
    expect(track.cues).toHaveLength(1);
    expect(track.cues[0]?.text).toBe('GitHub斩获七万多星标');
    expect(track.cues[0]?.samples).toBe(9);
  });

  it('drops a low-confidence reading seen once', () => {
    const track = buildCues(samplesOf(10, [[4, 4, line('oasings', 0.5, 0.02, 0.1, 0.1, 0.7)]]), opts(10));
    expect(track.cues).toHaveLength(0);
  });

  it('tells captions, a watermark that jumps, a title, and text of the footage apart', () => {
    const captions = ['这种丝滑的网页动效', '一个库就能搞定', '今天带来的是', 'SVG变形', '路径运动', '全都能做'];
    const spans: [number, number, TextLine][] = [
      ...captions.map((t, i): [number, number, TextLine] => [i * 10, i * 10 + 9, line(t, 0.9, 0.075, 0.5 - t.length * 0.03, t.length * 0.06)]),
      // the same watermark at the top in the first half and at the bottom in the second
      [0, 29, line('抖音号：someone', 0.13, 0.036, 0.05, 0.2)], [30, 59, line('抖音号：someone', 0.87, 0.036, 0.75, 0.2)],
      // a page's own headline, left-aligned, changing while the footage plays
      [8, 12, line('A lightweight', 0.19, 0.035, 0.06, 0.2)], [13, 17, line('and modular API', 0.19, 0.035, 0.06, 0.2)], [18, 22, line('All-in-one engine', 0.19, 0.035, 0.06, 0.2)],
      // small interface text of a recorded page
      [20, 40, line('Sign in', 0.07, 0.02, 0.9, 0.05)],
      // a large line on the end card
      [50, 59, line('发现更多创作者', 0.5, 0.09)],
    ];
    const roles = Object.fromEntries(buildCues(samplesOf(60, spans), opts(60)).cues.map((c) => [c.text + '@' + c.box[1], c.role]));
    for (const t of captions) expect(roles[t + '@0.9'], t).toBe('caption');
    expect(roles['抖音号：someone@0.13']).toBe('watermark');
    expect(roles['抖音号：someone@0.87']).toBe('watermark');
    expect(roles['A lightweight@0.19']).not.toBe('caption');
    expect(roles['Sign in@0.07']).toBe('in-picture');
    expect(roles['发现更多创作者@0.5']).toBe('title');
  });

  it('finds the caption band, keeps a strip readable, and merges strips with whole frames', () => {
    // Lines that differ enough: two lines one character apart at the same place would count as one misread line.
    const captions = ['这种丝滑的网页动效', '一个库就能搞定', '今天带来的是', '全都能做'];
    const whole = samplesOf(8, captions.map((t, i): [number, number, TextLine] => [i * 2, i * 2 + 1, line(t, 0.86, 0.08)])).map((s, k) => ({ ...s, frame: k * 30, lines: [...s.lines, line('Sign in', 0.05, 0.02, 0.9, 0.05)] }));
    const band = captionBandOf(buildCues(whole, { step: 30, total: 240, fps: 30 }));
    expect(band?.top).toBeCloseTo(0.86 - 0.056, 3);
    expect(band?.bottom).toBeCloseTo(0.94 + 0.056, 3);
    // A 1280x720 frame: the strip must be at least 1280 / 6 pixels high, about 30% of the height, and stay inside the frame.
    const readable = readableBand(band ?? { top: 0, bottom: 1 }, 1280, 720);
    expect(readable.bottom - readable.top).toBeCloseTo(1280 / 720 / 6, 2);
    expect(readable.bottom).toBeLessThanOrEqual(1);
    // A portrait frame needs no growing.
    expect(readableBand({ top: 0.8, bottom: 0.96 }, 1080, 1920)).toEqual({ top: 0.8, bottom: 0.96 });
    // A strip read at frame 36: its line, given in fractions of the strip, lands in frame coordinates; the small text of
    // the whole frame before it (frame 30) is held; the caption of that whole frame is not.
    const merged = mergeBandSamples(whole, [{ frame: 36, lines: [{ text: '这种丝滑的网页动效', confidence: 0.9, box: [0.3, 0.5, 0.4, 0.25] }] }], { top: 0.7, bottom: 1 });
    const at36 = merged.find((s) => s.frame === 36);
    expect(at36?.lines.map((l) => [l.text, l.box[1], l.box[3], l.partial ?? false])).toEqual([['Sign in', 0.05, 0.02, false], ['这种丝滑的网页动效', 0.85, 0.075, true]]);
    expect(merged.map((s) => s.frame)).toEqual([0, 30, 36, 60, 90, 120, 150, 180, 210]);
  });

  it('takes the place and size of a cue from whole-frame readings when it has any', () => {
    const samples: TextSample[] = [
      { frame: 0, lines: [line('一个库就能搞定', 0.9, 0.075)] },
      { frame: 6, lines: [{ ...line('一个库就能搞定', 0.88, 0.11), partial: true }] },
      { frame: 12, lines: [{ ...line('一个库就能搞定', 0.88, 0.11), partial: true }] },
    ];
    const cue = buildCues(samples, { step: 6, total: 60, fps: 30 }).cues[0];
    expect(cue?.size).toBe(0.075);
    expect(cue?.box[1]).toBe(0.9);
    expect(cue?.samples).toBe(3);
  });

  it('is deterministic', () => {
    const s = samplesOf(12, [[1, 8, line('一个库就能搞定', 0.9)], [3, 11, line('watermark', 0.1, 0.04)]]);
    expect(JSON.stringify(buildCues(s, opts(12)))).toBe(JSON.stringify(buildCues(s, opts(12))));
  });
});
