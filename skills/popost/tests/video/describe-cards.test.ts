/**
 * Short designed title cards between screen recordings (b1/b2: an agent dropped them). describe lists each card as its
 * own shot with its title and a designed-picture line, and its title stays out of the recording before it: a cue's
 * edges are put half a reading step out, so a title that appears at a cut reached 3 frames into the shot before. The
 * template card names each card's title at every level of detail that lists the shots one by one.
 */
import { describe, expect, it } from 'vitest';
import { describeReference } from '../../src/video/describe/index';
import { shotLooks, shownIn } from '../../src/video/describe/kind';
import { templateCard } from '../../src/video/template/card';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Box, Measure, ShotMeasure } from '../../src/video/types';

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const scroll = { kind: 'move' as const, zoomPerS: 0, panPerS: [0, 0.021] as [number, number], confidence: 0.9 };
const TITLES = ['第一步', '第二步', '第三步', '第四步', '第五步', '最后一步'];

/** Six recordings of 120 frames (a scrolling light page) and after each but the last a card of 45 frames (a flat colour). */
const shots: ShotMeasure[] = [];
for (let k = 0, at = 0; k < 11; k++) {
  const card = k % 2 === 1, end = at + (card ? 45 : 120);
  shots.push(card
    ? { index: k, start: at, end, camera: still, background: '#fd5835', palette: [{ hex: '#fd5835', share: 0.99 }], events: [{ kind: 'appear', start: at + 1, end: at + 9, box: [0.3, 0.4, 0.4, 0.2], confidence: 0.8 }] } as ShotMeasure
    : { index: k, start: at, end, camera: scroll, background: '#fafafa', palette: [{ hex: '#fafafa', share: 0.88 }, { hex: '#3c4043', share: 0.06 }], events: [] } as ShotMeasure);
  at = end;
}
const total = shots[shots.length - 1]?.end ?? 0;
const measure: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: total, duration: total / 30, hasAudio: false },
  boundaries: shots.slice(1).map((s) => ({ frame: s.start, kind: 'cut' as const, start: s.start - 1, end: s.start, confidence: 1 })),
  shots,
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, role: TextCue['role'], start: number, end: number, box: Box, size: number): TextCue => ({ text, role, start, end, box, size, samples: 6, confidence: 0.95 });
// Each card's title read from its first frame, so its cue starts 3 frames (half a step of 6) before the cut; each page shows ten lines.
const text: TextTrack = {
  step: 6, sampled: 140,
  cues: shots.flatMap((s, k) => (k % 2 === 1
    ? [cue(TITLES[(k - 1) / 2] as string, 'title', s.start - 3, s.end, [0.38, 0.42, 0.24, 0.08], 0.08)]
    : Array.from({ length: 10 }, (_, j) => cue('设置选项 ' + (j + 1) + '：调整默认行为', 'in-picture', s.start, s.end, [0.12, 0.12 + 0.07 * j, 0.6, 0.03], 0.03)))),
};

describe('title cards between screen recordings', () => {
  it('counts a cue in a shot only when it overlaps it by more than half a reading step', () => {
    expect(shownIn({ start: 117, end: 165 }, { start: 0, end: 120 }, 6)).toBe(false);
    expect(shownIn({ start: 117, end: 165 }, { start: 120, end: 165 }, 6)).toBe(true);
    expect(shownIn({ start: 100, end: 140 }, { start: 0, end: 120 }, 6)).toBe(true);
    expect(shownIn({ start: 117, end: 165 }, { start: 0, end: 120 })).toBe(true);
  });

  it('lists each card as its own shot with its title, and keeps the title off the recording before it', () => {
    const { files } = describeReference(measure, text, 'cards');
    const lines = (files['timeline.md'] ?? '').split('\n').filter((l) => l.startsWith('#'));
    expect(lines.filter((l) => /^#\d/.test(l))).toHaveLength(11);
    const shotLine = (k: number): string => lines.find((l) => l.startsWith('#' + String(k + 1).padStart(2, '0') + ' ')) ?? '';
    expect(shotLine(1)).toContain('text "第一步"');
    expect(shotLine(0)).not.toContain('第一步');
    expect(shotLine(2)).not.toContain('第一步');
    expect(files['shots/01.md']).not.toContain('第一步');
    expect(files['shots/02.md']).toContain('title "第一步"');
    expect(files['shots/02.md']).toContain('Most likely: a designed picture');
    expect(shotLooks(shots[0] as ShotMeasure, text.cues, text.step)?.kind).toBe('page');
  });

  it('names every card\'s title in the template card, on the card\'s own shot', () => {
    const tpl = templateFrom({ measure, text, name: 'cards', label: 'cards', hash: 'x' });
    const card = templateCard(tpl, slotsOf(tpl, undefined), { text, sourceFps: 30 }).text;
    const shotLines = card.split('\n').filter((l) => /shots\[\d+\]/.test(l) && !l.startsWith('- shots[k]'));
    expect(shotLines).toHaveLength(11);
    TITLES.slice(0, 5).forEach((t, i) => {
      expect(shotLines[2 * i + 1]).toContain('words "' + t + '"');
      expect(shotLines[2 * i]).not.toContain(t);
    });
  });
});
