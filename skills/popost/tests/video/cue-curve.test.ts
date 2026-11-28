/**
 * The rules of the maintainer's cue check (tools/video/check-cues.ts): where a picture's change starts and peaks on its
 * change curve, how far a sound cue sits from it, and what the check proposes for a misplaced cue.
 */
import { describe, expect, it } from 'vitest';
import { changesOf, curvesOfGrey, judgeCues, proposeCues } from '../../tools/video/cue-curve';

/** A curve of n frames, quiet but for the values given at their frames. */
const curve = (n: number, at: Record<number, number>): number[] => Array.from({ length: n }, (_v, f) => at[f] ?? 0);

describe('the change curve', () => {
  it('starts a change where the curve leaves quiet, and where it jumps inside a running change', () => {
    const d = curve(40, { 10: 0.01, 11: 0.02, 12: 0.01, 13: 0.01, 14: 0.08, 15: 0.06, 30: 0.0001 });
    const changes = changesOf(d);
    expect(changes.map((c) => [c.onset, c.by])).toEqual([[10, 'start'], [14, 'jump']]);
    expect(changes[1]?.peak).toBe(14);
  });

  it('counts pixels that start to change where nothing moved before, as a new element does inside a running move', () => {
    const w = 20, h = 10, frames = 6, raw = new Uint8Array(w * h * frames);
    for (let f = 0; f < frames; f++) {
      raw[f * w * h + f] = 255; // a dot that moves one pixel a frame along the top row
      if (f >= 4) raw.fill(255, f * w * h + 5 * w + 10, f * w * h + 5 * w + 16); // a bar that appears on frame 4
    }
    const { d, fresh } = curvesOfGrey(raw, w, h);
    expect(d[4]).toBeGreaterThan(d[3] as number);
    expect(fresh[4]).toBeCloseTo(6 / (w * h), 5);
    expect(fresh[3]).toBe(0);
  });
});

describe('judging cues', () => {
  it('measures each cue against its change: the onset, a peak for pop, a peak or the landing for impact', () => {
    const d = curve(70, { 10: 0.01, 11: 0.02, 12: 0.025, 13: 0.004, 55: 0.01, 56: 0.01 });
    const [whoosh, late, impact, pop, lost] = judgeCues(d, [
      { at: 9 / 30, cue: 'whoosh' }, { at: 16 / 30, cue: 'whoosh' }, { at: 13 / 30, cue: 'impact' }, { at: 12 / 30, cue: 'pop' }, { at: 32 / 30, cue: 'tick' },
    ], 30);
    expect(whoosh).toMatchObject({ verdict: 'ok', offsetFrames: -1, change: 10 });
    expect(late).toMatchObject({ verdict: 'late', offsetFrames: 6 });
    expect(impact).toMatchObject({ verdict: 'ok', by: 'landing' });
    expect(pop).toMatchObject({ verdict: 'ok', offsetFrames: 0 });
    expect(lost).toMatchObject({ verdict: 'nothing' });
  });

  it('leaves a cue of a row inside a running change for the eye instead of calling it misplaced', () => {
    const d = curve(40, Object.fromEntries(Array.from({ length: 20 }, (_v, i) => [10 + i, 0.01])));
    const cues = [0, 1, 2].map((i) => ({ at: (10 + 6 * i) / 30, cue: 'tick' }));
    expect(judgeCues(d, cues, 30).map((v) => v.verdict)).toEqual(['ok', 'inside', 'inside']);
  });
});

describe('proposals', () => {
  it('moves early and late cues to their change, removes cues on nothing, and keeps one sound for an entry that moves', () => {
    const d = curve(80, { 20: 0.01, 21: 0.01, 50: 0.01 });
    const cues = [{ at: 12 / 30, cue: 'whoosh', gain: 0.5 }, { at: 51 / 30, cue: 'tick', gain: 0.3 }, { at: 70 / 30, cue: 'draw', gain: 0.4 }];
    const p = proposeCues(d, cues, judgeCues(d, cues, 30), 30);
    expect(p).toEqual({ cues: [{ at: 0.667, cue: 'whoosh', gain: 0.5 }, { at: 51 / 30, cue: 'tick', gain: 0.3 }], moved: 1, removed: 1 });
    const alone = [{ at: 0, cue: 'whoosh', gain: 0.5 }];
    expect(proposeCues(d, alone, judgeCues(d, alone, 30), 30)?.cues).toEqual([{ at: 0.667, cue: 'whoosh', gain: 0.5 }]);
  });

  it('proposes nothing for a picture that never changes, and keeps a cue on a faintly moving picture', () => {
    const still = curve(40, {});
    const cues = [{ at: 0, cue: 'whoosh', gain: 0.5 }];
    expect(proposeCues(still, cues, judgeCues(still, cues, 30), 30)).toBeUndefined();
    const faint = curve(60, { 5: 0.01, 40: 0.00005, 41: 0.00005 });
    expect(judgeCues(faint, [{ at: 40 / 30, cue: 'type' }], 30)[0]).toMatchObject({ verdict: 'ok', by: 'faint', change: 40 });
    const away = curve(60, { 5: 0.01, 40: 0.00005, 41: 0.00005, 42: 0.00005, 43: 0.00005, 44: 0.00005 });
    expect(judgeCues(away, [{ at: 43 / 30, cue: 'type' }], 30)[0]?.verdict).toBe('inside');
  });

  it('proposes nothing when every cue is on its change', () => {
    const d = curve(30, { 10: 0.01 });
    const cues = [{ at: 10 / 30, cue: 'swish', gain: 0.4 }];
    expect(proposeCues(d, cues, judgeCues(d, cues, 30), 30)).toBeUndefined();
  });
});
