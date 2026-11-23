import { describe, expect, it } from 'vitest';
import { alignScript, countPhrase, findPhrase, tokenize } from '../../src/video/align/index';
import type { SpokenWord } from '../../src/video/speech/types';

const w = (text: string, start: number, end: number, confidence = 0.95): SpokenWord => ({ text, start, end, confidence });

describe('forgiving alignment', () => {
  it('splits a text into timed units: one per CJK character, one per Latin word or number', () => {
    expect(tokenize('今天带来的是 Popost 提示词库，12800+ 条！')).toEqual(['今', '天', '带', '来', '的', '是', 'popost', '提', '示', '词', '库', '12800', '条']);
    expect(tokenize(' ，。 ')).toEqual([]);
  });

  it('gives every token the time it was heard at when the words agree', () => {
    const a = alignScript('一个库就能搞定', [w('一个', 64, 69), w('库', 69, 76), w('就', 76, 80), w('能', 80, 85), w('搞', 85, 89), w('定,', 89, 95)]);
    expect(a.tokens.map((t) => [t.text, t.start, t.end])).toEqual([['一', 64, 67], ['个', 67, 69], ['库', 69, 76], ['就', 76, 80], ['能', 80, 85], ['搞', 85, 89], ['定', 89, 95]]);
    expect(a.matchedShare).toBe(1);
    expect(a.confidence).toBeCloseTo(0.95, 2);
  });

  it('survives a misheard name: the name takes the time of what was heard instead, with half the confidence', () => {
    // Written "Popost 提示词库", heard "GlibGa提示此库": the name is one unit, one character is wrong.
    const a = alignScript('Popost 提示词库', [w('GlibGa', 149, 170, 0.4), w('提', 170, 176), w('示', 176, 181), w('此', 181, 187, 0.5), w('库', 187, 195)]);
    expect(a.tokens.map((t) => [t.text, t.start, t.end, t.matched])).toEqual([['popost', 149, 170, false], ['提', 170, 176, true], ['示', 176, 181, true], ['词', 181, 187, false], ['库', 187, 195, true]]);
    expect(a.tokens[0]?.confidence).toBe(0.2);
    expect(a.tokens[3]?.confidence).toBe(0.25);
    expect(a.matchedShare).toBe(0.6);
  });

  it('places a dropped word between its neighbours and ignores an added one', () => {
    // "十五个国家" with "个" not heard, and a filler "嗯" heard before it.
    const a = alignScript('十五个国家', [w('嗯', 250, 258), w('十', 260, 268), w('五', 268, 276), w('国', 290, 298), w('家', 298, 306)]);
    expect(a.tokens.map((t) => [t.text, t.start, t.end, t.matched])).toEqual([['十', 260, 268, true], ['五', 268, 276, true], ['个', 276, 290, false], ['国', 290, 298, true], ['家', 298, 306, true]]);
    expect(a.tokens[2]?.confidence).toBe(0.2);
  });

  it('never fails: with nothing heard every token still has a place, in order, at low confidence', () => {
    const a = alignScript('快去试试吧', []);
    expect(a.tokens).toHaveLength(5);
    expect(a.tokens.every((t, k) => t.end > t.start && (k === 0 || t.start >= (a.tokens[k - 1]?.end ?? 0)))).toBe(true);
    expect(a.matchedShare).toBe(0);
    expect(a.confidence).toBe(0.2);
    expect(alignScript('', [w('x', 0, 5)]).tokens).toEqual([]);
  });

  it('extends from the nearest heard word when the start or the end was not heard', () => {
    const a = alignScript('今天带来的是', [w('带', 100, 106), w('来', 106, 112)]);
    expect(a.tokens.map((t) => [t.text, t.start, t.end])).toEqual([['今', 88, 94], ['天', 94, 100], ['带', 100, 106], ['来', 106, 112], ['的', 112, 118], ['是', 118, 124]]);
  });

  it('finds where a phrase is spoken, by occurrence, and counts how often it occurs', () => {
    const script = '提示词一键复制，同款一键复刻';
    const words = Array.from(tokenize(script)).map((ch, k) => w(ch, 300 + k * 6, 306 + k * 6));
    const a = alignScript(script, words);
    expect(findPhrase(a, '一键复制')).toMatchObject({ start: 318, end: 342, confidence: 0.95 });
    expect(findPhrase(a, '一键')).toMatchObject({ start: 318, end: 330 });
    expect(findPhrase(a, '一键', 2)).toMatchObject({ start: 354, end: 366 });
    expect(findPhrase(a, '一键', 3)).toBeUndefined();
    expect(findPhrase(a, '没有这句')).toBeUndefined();
    expect(countPhrase(script, '一键')).toBe(2);
    expect(countPhrase(script, 'Popost')).toBe(0);
  });
});
