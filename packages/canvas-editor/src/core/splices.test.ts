import { describe, expect, it } from 'vitest';
import type { Splice } from '../contracts';
import {
  SpliceError,
  applySplices,
  assertValidSplices,
  composeSplices,
  diffSplices,
  invertSplices,
  isInReplaced,
  mapOffset,
} from './splices';

const sp = (start: number, end: number, text: string): Splice => ({ start, end, text });

/** Deterministic pseudo-random generator for property-style tests. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomSplices(rand: () => number, length: number): Splice[] {
  const out: Splice[] = [];
  let pos = 0;
  while (pos <= length && out.length < 4) {
    const start = pos + Math.floor(rand() * 5);
    if (start > length) break;
    const end = Math.min(length, start + Math.floor(rand() * 4));
    const text = 'abcdefgh'.slice(0, Math.floor(rand() * 4)).toUpperCase();
    out.push(sp(start, end, text));
    pos = end + Math.floor(rand() * 3) + (end === start ? 1 : 0);
  }
  return out;
}

describe('applySplices / invertSplices', () => {
  it('applies replacements, insertions and deletions', () => {
    expect(applySplices('0123456789', [sp(0, 0, 'A'), sp(2, 4, 'xyz'), sp(6, 7, ''), sp(10, 10, 'Z')])).toBe('A01xyz45789Z');
    expect(applySplices('abc', [])).toBe('abc');
  });
  it('rejects unsorted, overlapping or out-of-range splices', () => {
    expect(() => applySplices('abc', [sp(2, 3, ''), sp(0, 1, '')])).toThrow(SpliceError);
    expect(() => applySplices('abcdef', [sp(0, 3, ''), sp(2, 4, '')])).toThrow(SpliceError);
    expect(() => applySplices('abc', [sp(2, 9, '')])).toThrow(SpliceError);
    expect(() => assertValidSplices([sp(3, 2, '')])).toThrow(SpliceError);
  });
  it('allows an insertion right before a replacement at the same offset', () => {
    expect(applySplices('abc', [sp(1, 1, 'X'), sp(1, 2, 'Y')])).toBe('aXYc');
  });
  it('inverts so the original is restored (randomised)', () => {
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const source = 'the quick brown fox jumps over'.slice(0, 5 + Math.floor(rand() * 25));
      const splices = randomSplices(rand, source.length);
      const edited = applySplices(source, splices);
      expect(applySplices(edited, invertSplices(source, splices))).toBe(source);
    }
  });
});

describe('mapOffset', () => {
  const splices = [sp(2, 2, 'XX'), sp(5, 8, 'Y')];
  it('shifts positions after splices', () => {
    expect(mapOffset(splices, 0, 1)).toBe(0);
    expect(mapOffset(splices, 3, 1)).toBe(5);
    expect(mapOffset(splices, 8, 1)).toBe(8 + 2 - 2);
    expect(mapOffset(splices, 10, 1)).toBe(10);
  });
  it('resolves insertion boundaries by association', () => {
    expect(mapOffset(splices, 2, -1)).toBe(2);
    expect(mapOffset(splices, 2, 1)).toBe(4);
  });
  it('collapses positions inside replaced ranges to either side', () => {
    expect(mapOffset(splices, 6, -1)).toBe(7);
    expect(mapOffset(splices, 6, 1)).toBe(8);
    expect(mapOffset(splices, 5, -1)).toBe(7);
    expect(mapOffset(splices, 5, 1)).toBe(8);
  });
  it('knows which positions are replaced', () => {
    expect(isInReplaced(splices, 2)).toBe(false);
    expect(isInReplaced(splices, 5)).toBe(true);
    expect(isInReplaced(splices, 7)).toBe(true);
    expect(isInReplaced(splices, 8)).toBe(false);
  });
});

describe('diffSplices', () => {
  it('returns nothing for equal text and one trimmed splice otherwise', () => {
    expect(diffSplices('abc', 'abc')).toEqual([]);
    expect(diffSplices('hello world', 'hello brave world')).toEqual([sp(6, 6, 'brave ')]);
    expect(diffSplices('abc', 'xyz')).toEqual([sp(0, 3, 'xyz')]);
    expect(diffSplices('', 'a')).toEqual([sp(0, 0, 'a')]);
    expect(diffSplices('a', '')).toEqual([sp(0, 1, '')]);
  });
  it('round-trips and never cuts a surrogate pair', () => {
    const cases: Array<[string, string]> = [
      ['a😀b', 'a😁b'],
      ['😀', '😁'],
      ['x😀😀y', 'x😀y'],
      ['aaa', 'aaaa'],
    ];
    for (const [a, b] of cases) {
      const d = diffSplices(a, b);
      expect(applySplices(a, d)).toBe(b);
      for (const s of d) {
        const code = a.charCodeAt(s.start);
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });
});

describe('composeSplices', () => {
  it('equals applying both lists in sequence (randomised)', () => {
    const rand = rng(42);
    for (let i = 0; i < 400; i++) {
      const source = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 6 + Math.floor(rand() * 20));
      const first = randomSplices(rand, source.length);
      const mid = applySplices(source, first);
      const second = randomSplices(rand, mid.length);
      const end = applySplices(mid, second);
      const composed = composeSplices(first, second);
      expect(applySplices(source, composed)).toBe(end);
      // and the inverse composes the other way round
      const back = composeSplices(invertSplices(mid, second), invertSplices(source, first));
      expect(applySplices(end, back)).toBe(source);
    }
  });
  it('cancels an insertion that is deleted again', () => {
    expect(composeSplices([sp(1, 1, 'XYZ')], [sp(1, 4, '')])).toEqual([]);
  });
  it('merges successive edits of the same spot', () => {
    expect(composeSplices([sp(0, 1, 'a')], [sp(0, 1, 'b')])).toEqual([sp(0, 1, 'b')]);
  });
  it('handles empty inputs', () => {
    expect(composeSplices([], [])).toEqual([]);
    expect(composeSplices([sp(0, 0, 'a')], [])).toEqual([sp(0, 0, 'a')]);
    expect(composeSplices([], [sp(0, 0, 'a')])).toEqual([sp(0, 0, 'a')]);
  });
});
