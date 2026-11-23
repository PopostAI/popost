import { describe, expect, it } from 'vitest';
import { captionHintProblems, withCaptionRoles } from '../../src/video/elements/caption-roles';
import { readElements } from '../../src/video/elements/read';
import type { Elements } from '../../src/video/elements/types';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Measure } from '../../src/video/types';

const m = { source: { fps: 30 }, shots: [{ index: 0, start: 0, end: 60 }, { index: 1, start: 60, end: 120 }] } as Measure;
const reading = (): Elements => ({ shots: [0, 1].map((k) => ({ shot: k + 1, time: [k * 2, (k + 1) * 2], layout: 'a page with a subtitle', captions: { base: 'white outline', lines: k === 0 ? ['A clear caption line'] : [] }, layers: [{ id: 'caption', kind: 'caption', role: 'design', box: [0.2, 0.8, 0.6, 0.1], look: 'white outline' }] })) });
const cue = (text: string, role: TextCue['role'], box: TextCue['box'] = [0.3, 0.82, 0.4, 0.06]): TextCue => ({ text, role, box, size: box[3], start: 10, end: 50, confidence: 0.9, samples: 5 });
const track = (cues: TextCue[]): TextTrack => ({ step: 6, sampled: 20, cues, captionLook: { kind: 'plain', color: '#abcdef', confidence: 1, samples: 2 } });

describe('visually confirmed captions', () => {
  it('recovers a subtitle from page text and removes an incorrectly classified heading without changing its times', () => {
    const text = track([cue('A clear captlon line', 'in-picture'), cue('Website heading', 'caption', [0.1, 0.1, 0.8, 0.1])]);
    const r = withCaptionRoles(text, reading(), m);
    expect(r.cues).toMatchObject([{ text: 'A clear caption line', role: 'caption', start: 10, end: 50 }, { text: 'Website heading', role: 'in-picture', start: 10, end: 50 }]);
    expect(r.captionLook).toBeUndefined();
    expect(text.cues[0]?.role).toBe('in-picture');
    expect(captionHintProblems(reading(), m, text)).toEqual([]);
  });
  it('respects an empty caption list across a shot boundary and keeps unspecified readings unchanged', () => {
    const t = track([{ ...cue('A clear caption line', 'caption'), start: 30, end: 90 }]);
    expect(withCaptionRoles(t, reading(), m).cues).toMatchObject([{ start: 30, end: 60, role: 'caption' }, { start: 60, end: 90, role: 'in-picture' }]);
    const e = reading(); for (const s of e.shots) delete s.captions?.lines;
    expect(withCaptionRoles(t, e, m)).toBe(t);
  });
  it('does not promote a watermark or an equal line outside the band, or invent a timing for a missing line', () => {
    const e = reading();
    const t = track([cue('A clear caption line', 'watermark'), cue('A clear caption line', 'in-picture', [0.3, 0.1, 0.4, 0.06])]);
    expect(withCaptionRoles(t, e, m).cues.every((c) => c.role !== 'caption')).toBe(true);
    expect(captionHintProblems(e, m, t)).toHaveLength(1);
  });
  it('refuses a numeric mismatch and validates the correction format', () => {
    const e = reading(); e.shots[0]!.captions!.lines = ['There are 100 examples'];
    expect(captionHintProblems(e, m, track([cue('There are 1000 examples', 'in-picture')]))).toHaveLength(1);
    expect(readElements(e).problems).toEqual([]);
    (e.shots[0]!.captions!.lines as unknown[]).push(12);
    expect(readElements(e).problems.some((p) => p.level === 'error' && p.at.endsWith('.lines'))).toBe(true);
  });
  it('keeps whole numbers, decimals and non-Latin digits distinct, including at a suffix boundary', () => {
    const e = reading();
    for (const [confirmed, ocr] of [['100 examples', '1100 examples'], ['There are 1.5 million examples', 'There are 15 million examples'], ['There are ١٠٠ examples', 'There are ١١٠ examples']]) {
      e.shots[0]!.captions!.lines = [confirmed!];
      expect(captionHintProblems(e, m, track([cue(ocr!, 'in-picture')]))).toHaveLength(1);
    }
    e.shots[0]!.captions!.lines = ['100 examples'];
    expect(captionHintProblems(e, m, track([cue('Page 12 | 100 examples', 'in-picture')]))).toEqual([]);
  });
});
