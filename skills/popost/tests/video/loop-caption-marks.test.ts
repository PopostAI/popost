/**
 * Words a fill marks in a caption line, *like this* (retarget/marks.ts): the marks come off the text that is drawn,
 * timed and spoken, and the marked characters are drawn in the highlight colour, the reference's when describe found
 * one, else one that stands out from the letters. Also which words of a read line a highlight covered
 * (text/highlight.ts), the form those marks take. Pure, except one fill spoken by a fake speaker (ffmpeg tones).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { highlightColour, unmark } from '../../src/video/retarget/marks';
import { speakRetarget } from '../../src/video/retarget/speak';
import { budgetProblems } from '../../src/video/plan/ask';
import type { TemplatePackage } from '../../src/video/template/types';
import { litChars } from '../../src/video/text/highlight';
import type { CaptionLook, TextTrack } from '../../src/video/text/types';
import type { CaptionTrack, Measure } from '../../src/video/types';
import type { Speaker } from '../../src/video/voice/index';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
afterAll(async () => { await rt.cleanup(); });

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const measure: Measure = {
  version: 1, source: { width: 720, height: 1280, fps: 30, frames: 180, duration: 6, hasAudio: false }, boundaries: [],
  shots: [{ index: 0, start: 0, end: 180, camera: still, background: '#203040', palette: [], events: [] }],
  rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) => ({ text, start, end, box: [0.2, 0.8, 0.6, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const look: CaptionLook = { kind: 'outline', color: '#ffffff', confidence: 1, outline: { color: '#000000', confidence: 0.9 }, highlight: { color: '#22cc44', confidence: 1, lines: 2 }, samples: 3 };
const text = (l?: CaptionLook): TextTrack => ({ step: 6, sampled: 30, cues: [cue('one', 0, 60), cue('two', 60, 120), cue('three', 120, 180)], ...(l ? { captionLook: l } : {}) });
const captionsOf = (plan: RetargetPlan, l?: CaptionLook): CaptionTrack | undefined =>
  retarget({ measure, text: text(l), plan }).project?.tracks.find((t): t is CaptionTrack => t.type === 'caption');

describe('marked words in caption lines', () => {
  it('takes the marks off and says which characters they held', () => {
    expect(unmark('Save *50%* today')).toEqual({ text: 'Save 50% today', marks: [[5, 8]] });
    expect(unmark('**Big** news and *more*')).toEqual({ text: 'Big news and more', marks: [[0, 3], [13, 17]] });
    expect(unmark('今天*视频*很好')).toEqual({ text: '今天视频很好', marks: [[2, 4]] });
    expect(unmark('  * spaced *  ')).toEqual({ text: 'spaced', marks: [[0, 6]] });
    // An asterisk without a pair is an ordinary character.
    expect(unmark('5*3 = 15')).toEqual({ text: '5*3 = 15', marks: [] });
    expect(unmark('*one* and 2*3')).toEqual({ text: 'one and 2*3', marks: [[0, 3]] });
    expect(unmark('no marks here')).toEqual({ text: 'no marks here', marks: [] });
  });

  it('tells which words of a line a highlight covered, from the columns of its ink', () => {
    const cols = (a: number, b: number): number[] => Array.from({ length: b - a }, (_v, j) => a + j);
    const lit = (flags: boolean[], text: string): string => Array.from(text).map((c, i) => (flags[i] ? c.toUpperCase() : c)).join('');
    // Three words with gaps between them: the second is lit.
    expect(lit(litChars('one two six', [...cols(0, 30), ...cols(40, 70), ...cols(80, 110)], cols(40, 70), 5), 'one two six')).toBe('one TWO six');
    // Gaps that do not match the words (letters touching): the characters by their usual widths, a Latin word whole.
    expect(lit(litChars('one two six', cols(0, 110), cols(42, 72), 5), 'one two six')).toBe('one TWO six');
    // Full-width characters, one em each: the third and fourth of six are lit.
    expect(litChars('今天视频很好', cols(0, 120), cols(40, 80), 5)).toEqual([false, false, true, true, false, false]);
  });

  it('draws marked words in the reference\'s highlight colour, else in one that stands out from the letters', () => {
    const plan: RetargetPlan = { shots: [{ color: '#101014' }], captions: ['A *big* one', 'two', 'and *three*'] };
    const t = captionsOf(plan, look);
    expect(t?.cues.map((c) => c.text)).toEqual(['A big one', 'two', 'and three']);
    expect(t?.cues.map((c) => c.spans)).toEqual([[{ from: 2, to: 5, color: '#22cc44' }], undefined, [{ from: 4, to: 9, color: '#22cc44' }]]);
    expect(captionsOf(plan)?.cues[0]?.spans).toEqual([{ from: 2, to: 5, color: '#ffd84a' }]);
    // On yellow letters the yellow would not show: white instead.
    expect(highlightColour({ ...look, highlight: undefined, color: '#ffd400' }, '#ffd400')).toBe('#ffffff');
    expect(captionsOf({ ...plan, captionColor: '#ffd84a' })?.cues[0]?.spans?.[0]?.color).toBe('#ffffff');
    // A measured highlight whose colour was unsure gives none, and the marks stand out as without one.
    expect(highlightColour({ ...look, highlight: { confidence: 0.4, lines: 2 } }, '#ffffff')).toBe('#ffd84a');
  });

  it.skipIf(!ffmpeg)('speaks and times a line without its marks', async () => {
    const heard: string[] = [];
    const speaker: Speaker = {
      speak: async (line, out) => {
        heard.push(line);
        await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.2 * Math.max(1, Array.from(line).length)).toFixed(2), '-ac', '1', out]);
      },
    };
    const out = path.join(rt.dir, 'spoken');
    const r = await speakRetarget(rt, { input: { measure, text: text(look), plan: { shots: [{ color: '#101014' }], captions: ['A *big* one', 'two', '**three**'] } }, outDir: out, speaker });
    expect(heard).toEqual(['A big one', 'two', 'three']);
    const words = JSON.parse(await readFile(path.join(out, 'assets', 'voice.words.json'), 'utf8')) as { tokens: { text: string }[] };
    expect(words.tokens.map((t) => t.text).join(' ')).not.toContain('*');
    const cues = r.result.project?.tracks.find((t): t is CaptionTrack => t.type === 'caption')?.cues;
    expect(cues?.map((c) => [c.text, c.spans?.[0]?.from, c.spans?.[0]?.to])).toEqual([['A big one', 2, 5], ['two', undefined, undefined], ['three', 0, 5]]);
  });
});

describe('marks and the length of a line', () => {
  it('counts a marked line by what is spoken, without its asterisks', () => {
    const pkg = { slots: { captions: { lines: [{ seconds: 1 }] } } } as unknown as TemplatePackage;
    const budgets = { max: [4], pace: 4 };
    const plain = budgetProblems(pkg, { shots: [], captions: ['一二三四五六七八九十'] } as unknown as RetargetPlan, budgets);
    const marked = budgetProblems(pkg, { shots: [], captions: ['一二*三四*五六七八九十'] } as unknown as RetargetPlan, budgets);
    expect(plain[0]?.message).toContain('has 10 characters');
    expect(marked[0]?.message).toContain('has 10 characters');
    expect(budgetProblems(pkg, { shots: [], captions: ['*一二三四*'] } as unknown as RetargetPlan, budgets)).toEqual([]);
  });
});
