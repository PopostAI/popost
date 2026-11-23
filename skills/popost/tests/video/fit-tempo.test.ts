/**
 * --fit-tempo: a spoken line that would run over its beat is sped up a little (ffmpeg atempo, pitch kept), never past
 * the cap, and its word times with it; the rest re-flows as before. A fake speaker writes tones of known lengths.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { checkFill, fillTemplate, loadTemplate, saveTemplate } from '../../src/video/template/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { budgetProblems, paceBudgets } from '../../src/video/plan/ask';
import { LINE_TAIL, retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { speakRetarget } from '../../src/video/retarget/speak';
import { tempoCapProblem, tempoFor, tempoNotes } from '../../src/video/retarget/tempo';
import type { TemplatePackage } from '../../src/video/template/types';
import type { TextTrack } from '../../src/video/text/types';
import type { Measure } from '../../src/video/types';
import type { Speaker } from '../../src/video/voice/index';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);
afterAll(() => rt.cleanup());

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share: 0.5 }], events: [] });
/** 720x1280 at 30 fps, two shots of 150 frames, five caption beats. */
const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 150, kind: 'cut', start: 149, end: 150, confidence: 1 }],
  shots: [shot(0, 0, 150), shot(1, 150, 300)],
  rhythm: { step: 3, change: Array.from({ length: 99 }, () => 0.01) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) =>
  ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('先说结论再说原因', 0, 60), cue('这个方法真的很有用', 60, 150), cue('第三句话也很重要', 150, 210), cue('第四句话', 215, 270), cue('关注我', 270, 300)] };
const captions = ['甲乙', '丙丁', '戊己', '', '庚辛'];
const plan: RetargetPlan = { shots: [{ color: '#1d3557' }, { color: '#f4a261' }], captions };
/** The beats' frames, as the re-flow sees them. */
const slots = retarget({ measure, text, plan, spoken: { frames: [1, 1, 1, 0, 1] } }).timing?.slots ?? [];

describe('the tempo of a line', () => {
  it('is 1 when the line fits its beat, just enough when it is a little over, and the cap when it is far over', () => {
    expect(tempoFor(50, 60, 1.12)).toBe(1);
    expect(tempoFor(60 - LINE_TAIL, 60, 1.12)).toBe(1);
    expect(tempoFor(59, 60, 1.12)).toBe(Math.ceil((59 / 56) * 1000) / 1000);
    expect(tempoFor(90, 60, 1.12)).toBe(1.12);
    expect(tempoFor(10, 3, 1.12)).toBe(1.12);
    expect(tempoFor(90, 60, 1)).toBe(1);
    expect(tempoFor(0, 60, 1.12)).toBe(1);
  });

  it('takes a cap from 1 to 1.5', () => {
    expect(tempoCapProblem(1)).toBeUndefined();
    expect(tempoCapProblem(1.12)).toBeUndefined();
    expect(tempoCapProblem(0.9)).toContain('from 1 (never) to 1.5');
    expect(tempoCapProblem(2)).toContain('1.12 is hardly heard');
  });

  it('says per line what was done, and sums it up', () => {
    const notes = tempoNotes({ captions: ['a', 'b', 'c', 'd', '这一句说得太长了一点点再长一些'], slots: [60, 60, 60, 60, 102], before: [40, 0, 59, 70, 117], after: [40, 0, 56, 63, 101], tempos: [1, 1, 1.054, 1.12, 1.12], max: 1.12, fps: 30 });
    expect(notes).toEqual([
      'captions[2] "c": spoken 2.0 s in a 2.0 s beat, sped up 1.05, fits.',
      'captions[3] "d": spoken 2.3 s in a 2.0 s beat, sped up 1.12, 0.2 s over.',
      'captions[4] "这一句说得太长了一点点再长一…": spoken 3.9 s in a 3.4 s beat, sped up 1.12, 0.1 s over.',
      'fit-tempo 1.12: 3 line(s) sped up, 2 still over its beat (time re-flows there; move words to a neighbouring beat to keep the length).',
    ]);
    expect(tempoNotes({ captions: ['a'], slots: [60], before: [40], after: [40], tempos: [1], max: 1.12, fps: 30 })).toEqual(['fit-tempo 1.12: every line fits its beat at its own tempo; none was sped up.']);
  });
});

describe('budgets with a tempo cap', () => {
  const pkg = { slots: { captions: { lines: [{ seconds: 2 }, { seconds: 1 }] } } } as unknown as TemplatePackage;

  it('grow by the cap, and the refusal says why a line holds that many', () => {
    expect(paceBudgets(pkg, 4.5)).toEqual({ max: [9, 4], pace: 4.5 });
    expect(paceBudgets(pkg, 4.5, 1.12)).toEqual({ max: [10, 5], pace: 4.5, tempo: 1.12 });
    expect(paceBudgets(pkg, 4.5, 1)).toEqual({ max: [9, 4], pace: 4.5 });
    const [p] = budgetProblems(pkg, { shots: [], captions: ['一二三四五六七八九十十一十二'] }, paceBudgets(pkg, 4.5, 1.12));
    expect(p?.message).toBe('The line has 14 characters; beat 0 lasts 2 s and the voice says about 4.5 a second, sped up at most 1.12 times, so it holds 10.');
  });
});

describe('the --fit-tempo option', () => {
  it('needs --speak and a cap from 1 to 1.5', async () => {
    const mem = createTestRuntime();
    const alone = await runCli(mem, ['video', 'retarget', 'ref', '--plan', 'plan.json', '--out', 'out', '--fit-tempo', '1.12']);
    expect(alone.code).toBe(2);
    expect(alone.stdout).toContain('give --speak too');
    const fast = await runCli(mem, ['video', 'retarget', 'ref', '--plan', 'plan.json', '--out', 'out', '--speak', '--fit-tempo', '2']);
    expect(fast.code).toBe(2);
    expect(fast.stdout).toContain('from 1 (never) to 1.5');
  });
});

describe.skipIf(!ffmpeg)('a spoken retarget with --fit-tempo (ffmpeg)', () => {
  // Seconds of each line: 3 frames over the room of beat 0, well inside beat 1, half again as long as beat 2, and
  // exactly the room of beat 4. Line 2 reports its two words, each half of the line.
  const room = (i: number) => (slots[i] ?? 0) - LINE_TAIL;
  const length: Record<string, number> = { 甲乙: (room(0) + 3) / 30, 丙丁: (room(1) - 20) / 30, 戊己: ((slots[2] ?? 0) * 1.5) / 30, 庚辛: room(4) / 30 };
  const speaker: Speaker = {
    speak: async (line, out) => {
      const s = length[line] ?? 1;
      await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + s.toFixed(3), '-ac', '1', out]);
      if (line === '戊己') await writeFile(out + '.words.json', JSON.stringify({ words: [{ text: '戊', start: 0, end: s / 2 }, { text: '己', start: s / 2, end: s }] }));
    },
  };
  const run = (name: string, fitTempo?: number) =>
    speakRetarget(rt, { input: { measure, text, plan }, outDir: path.join(rt.dir, name), speaker, ...(fitTempo ? { fitTempo } : {}) });

  it('speeds up only the lines over their beats, by no more than the cap, and says so', async () => {
    const plain = await run('plain');
    const fit = await run('fit', 1.12);
    const before = plain.lines.map((l) => l.frames), after = fit.lines.map((l) => l.frames);
    expect(before[0]).toBeGreaterThan(room(0));
    // Line 0 now fits its beat (one frame of rounding allowed); lines 1 and 4 are untouched; line 2 is 1.12 times faster.
    expect(after[0]).toBeLessThanOrEqual(room(0) + 1);
    expect([after[1], after[3], after[4]]).toEqual([before[1], 0, before[4]]);
    expect(Math.abs((after[2] ?? 0) - (before[2] ?? 0) / 1.12)).toBeLessThanOrEqual(1.5);
    const tempoNotesOf = fit.notes.filter((n) => /sped up|fit-tempo/.test(n));
    expect(tempoNotesOf).toHaveLength(3);
    expect(tempoNotesOf[0]).toMatch(/^captions\[0\] "甲乙": spoken [\d.]+ s in a 2\.0 s beat, sped up 1\.\d\d, /);
    expect(tempoNotesOf[1]).toMatch(/^captions\[2\] "戊己": spoken 3\.0 s in a 2\.0 s beat, sped up 1\.12, [\d.]+ s over\.$/);
    expect(tempoNotesOf[2]).toMatch(/^fit-tempo 1\.12: 2 line\(s\) sped up, (1|2) still over its beat/);
    expect(plain.notes.some((n) => /sped up|fit-tempo/.test(n))).toBe(false);
    // The video gets less longer than without the cap.
    expect(fit.result.timing?.total ?? 0).toBeLessThan(plain.result.timing?.total ?? 0);
    expect((await readdir(path.join(rt.dir, 'fit', 'assets', 'voice'))).filter((f) => f.includes('tempo'))).toEqual([]);
    expect(existsSync(path.join(rt.dir, 'fit', 'assets', 'voice.m4a'))).toBe(true);
  });

  it('scales the word times the speaker gave with the tempo', async () => {
    const fit = await run('fit-words', 1.12);
    const s = length['戊己'] ?? 0;
    const words = fit.lines[2]?.words ?? [];
    expect(words.map((w) => w.text)).toEqual(['戊', '己']);
    expect(words[1]?.start).toBeCloseTo(s / 2 / 1.12, 3);
    expect(words[1]?.end).toBeCloseTo(s / 1.12, 3);
  });
});

describe('a template: whole lines, and budgets and speech with --fit-tempo', () => {
  const tdir = path.join(rt.dir, 'template');
  const fillFile = path.join(rt.dir, 'fill.json');
  const fillOf = (lines: string[]): RetargetPlan => ({ shots: [{ color: '#1d3557' }, { color: '#f4a261' }], captions: lines });
  beforeAll(async () => {
    const saved = await saveTemplate(rt, { measure, text, name: 'fit', label: 'synthetic reference', outDir: tdir });
    expect(saved.problems.filter((p) => p.level === 'error')).toEqual([]);
  });

  it('warns when a line is far shorter than the reference text of its beat, in the same script', async () => {
    const pkg = await loadTemplate(rt, tdir);
    const problems = await checkFill(rt, pkg, fillOf(['先说结论再说原因', '有用', '第三句话也很重要', '', '关注']));
    const cut = problems.filter((p) => p.message.includes('cut to fit'));
    expect(cut.map((p) => [p.level, p.at])).toEqual([['warning', 'captions[1]']]);
    expect(cut[0]?.message).toBe('The line has 2 characters; the reference has 9 in this beat ("这个方法真的很有用"). A line this much shorter is usually cut to fit, and no longer says anything whole.');
    expect(cut[0]?.fix).toContain('split one sentence over two beats');
    // A line in another script is not compared: a letter and a character are not said in the same time.
    const latin = await checkFill(rt, pkg, fillOf(['先说结论再说原因', 'Yes', '第三句话也很重要', '', '关注']));
    expect(latin.filter((p) => p.message.includes('cut to fit'))).toEqual([]);
  });

  it('template check holds a line to the budget the capped tempo gives it', async () => {
    // Beat 1 is 3 s: 13 characters at 4.5 a second (refused above 14.3), 15 sped up at most 1.12 times.
    await writeFile(fillFile, JSON.stringify(fillOf(['先说结论再说原因', '一二三四五六七八九十一二三四五', '第三句话也很重要', '', '关注我'])));
    const plain = await runCli(rt, ['video', 'template', 'check', tdir, '--fill', fillFile, '--pace', '4.5']);
    expect(plain.code).toBe(2);
    expect(plain.stdout).toContain('so it holds 13');
    const faster = await runCli(rt, ['video', 'template', 'check', tdir, '--fill', fillFile, '--pace', '4.5', '--fit-tempo', '1.12']);
    expect(faster.code).toBe(0);
    const alone = await runCli(rt, ['video', 'template', 'fill', tdir, '--fill', fillFile, '--out', path.join(rt.dir, 'no-speech'), '--fit-tempo', '1.12']);
    expect(alone.code).toBe(2);
    expect(alone.stdout).toContain('give --speak too');
  });

  it.skipIf(!ffmpeg)('template fill --speak passes the cap on to the voice', async () => {
    const speaker: Speaker = { speak: async (line, out) => { await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.25 * Array.from(line).length).toFixed(2), '-ac', '1', out]); } };
    const out = path.join(rt.dir, 'filled');
    const r = await fillTemplate(rt, { templateDir: tdir, fill: fillOf(['先说结论再说原因', '这个方法真的很有用', '第三句话也很重要', '', '关注我']), outDir: out, speak: true, speaker, fitTempo: 1.12 });
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(r.notes.some((n) => n.startsWith('fit-tempo 1.12: '))).toBe(true);
    expect(r.notes.filter((n) => / sped up 1\.\d\d, /.test(n)).map((n) => n.slice(0, 12))).toEqual(['captions[0] ', 'captions[2] ']);
    expect((await readFile(path.join(out, 'video.json'), 'utf8')).length).toBeGreaterThan(0);
  });
});
