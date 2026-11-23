import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeReference } from '../../src/video/describe/index';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { overrunNotes, paceWarnings } from '../../src/video/retarget/pace';
import type { SpokenWord, Transcript } from '../../src/video/speech/types';
import { fillTemplate, loadTemplate, saveTemplate, type TemplatePackage } from '../../src/video/template/index';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { CaptionTrack, Measure } from '../../src/video/types';
import type { Speaker } from '../../src/video/voice/index';

const rt = await createDiskRuntime();
const ffmpeg = await hasFfmpeg(rt);

/**
 * A hand-written reference: 300 frames at 30 fps in three shots of 100, two caption lines that are said, and between
 * them a stretch of speech with no caption on screen. Its beats: 0-60 shown, 110-150 spoken only, 200-260 shown.
 */
const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share: 0.5 }], events: [] });
const measure: Measure = {
  version: 1,
  source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 100, kind: 'cut', start: 99, end: 100, confidence: 1 }, { frame: 200, kind: 'cut', start: 199, end: 200, confidence: 1 }],
  shots: [shot(0, 0, 100), shot(1, 100, 200), shot(2, 200, 300)],
  rhythm: { step: 3, change: Array.from({ length: 99 }, () => 0.1) },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number): TextCue => ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05], role: 'caption', size: 0.05, samples: 8, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('先说结论', 0, 60), cue('最后一句', 200, 260)] };
const said = (line: string, from: number, frames = 5): SpokenWord[] => Array.from(line).map((ch, k) => ({ text: ch, start: from + k * frames, end: from + (k + 1) * frames, confidence: 0.9 }));
const transcript: Transcript = { language: 'zh', fps: 30, words: [...said('先说结论', 2), ...said('中间这段没有字幕', 110), ...said('最后一句', 205)] };
const colours = { shots: [{ color: '#1d3557' }, { color: '#f4a261' }, { color: '#2a9d8f' }] };
const plan: RetargetPlan = { ...colours, captions: ['新的开头', '这一句只说不显示', '新的结尾'] };
const captionsOf = (r: ReturnType<typeof retarget>): { text: string; during: { from: number; to: number } }[] =>
  (r.project?.tracks.find((t): t is CaptionTrack => t.type === 'caption')?.cues ?? []) as { text: string; during: { from: number; to: number } }[];

let root = '';
let dir = '';
let pkg: TemplatePackage;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loop-beats-plan-'));
  dir = path.join(root, 'template');
  await saveTemplate(rt, { measure, text, transcript, name: 'beats', label: 'hand-written reference', outDir: dir });
  pkg = await loadTemplate(rt, dir);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); await rt.cleanup(); });

describe('a plan against beats with one that was only said', () => {
  it('draws the lines of shown beats and not the line of a beat the reference only said', () => {
    const r = retarget({ measure, text, transcript, plan });
    expect(r.problems).toEqual([]);
    expect(captionsOf(r).map((c) => [c.text, c.during.from, c.during.to])).toEqual([['新的开头', 0, 60], ['新的结尾', 200, 260]]);
    expect(r.notes.join(' ')).toContain('1 line(s) belong to beats the reference only said (captions[1]): without a voice (--speak) they are neither shown nor heard.');
  });

  it('gives the spoken-only line its time when the lines are spoken, and keeps it off the screen', () => {
    const r = retarget({ measure, text, transcript, plan: { ...plan, sound: 'assets/voice.m4a' }, spoken: { frames: [30, 50, 30] }, wordsFile: 'assets/voice.words.json' });
    // Beats 0-60, 110-150, 200-260 take 34, 54 and 34 frames (the spoken length and 4 frames of air); the gaps stay.
    expect(r.timing?.starts).toEqual([0, 84, 188]);
    expect(r.timing?.slots).toEqual([60, 40, 60]);
    expect(r.timing?.reference).toBe(300);
    expect(captionsOf(r).map((c) => [c.text, c.during.from, c.during.to])).toEqual([['新的开头', 0, 34], ['新的结尾', 188, 222]]);
    expect(r.notes.join(' ')).toContain('they are spoken and not drawn');
  });

  it('refuses a plan written for the captions alone, and says how to fix it', () => {
    const r = retarget({ measure, text, transcript, plan: { ...colours, captions: ['新的开头', '新的结尾'] } });
    expect(r.project).toBeUndefined();
    expect(r.problems[0]).toMatchObject({ level: 'error', at: 'captions' });
    expect(r.problems[0]?.message).toBe('The plan has 2 caption lines; the reference has 3 beats (2 shown, 1 spoken only; timeline.md numbers them). They are matched by position. A line is needed for the spoken-only beats too.');
    expect(r.problems[0]?.fix).toContain('captions[i] is beat i');
  });

  it('warns about a line longer than the reference\'s speaker said in a beat that long', () => {
    // The reference said 16 characters in 80 frames: 6 a second, so about 12 in the 2 s of beat 2.
    const r = retarget({ measure, text, transcript, plan: { ...plan, captions: ['新的开头', '这一句只说不显示', '这一句写得实在太长了说不完还要再说几个字'] } });
    expect(r.problems.map((p) => [p.level, p.at])).toEqual([['warning', 'captions[2]']]);
    expect(r.problems[0]?.message).toBe('Beat 2 is 2.0 s; the reference said about 12 characters in it, this line has 20. Spoken, it makes the video longer here.');
    expect(r.problems[0]?.fix).toBe('Shorten it to about 12 characters.');
  });
});

describe('the numbered beats in the description and the card', () => {
  it('lists the beats once each in timeline.md, and a shot names the beats it holds', () => {
    const d = describeReference(measure, text, 'case', transcript);
    const timeline = d.files['timeline.md'] ?? '';
    expect(timeline).toContain('\n0 0.00-2.00 "先说结论"\n1 3.67-5.00 spoken only "中间这段没有字幕"\n2 6.67-8.67 "最后一句"\n');
    const shots = timeline.split('\n').filter((l) => l.startsWith('#0'));
    expect(shots.map((l) => l.split(' | ')[3])).toEqual(['beat 0', 'beat 1', 'beat 2']);
    expect(timeline).not.toContain('caption "');
    expect(d.files['REFERENCE.md']).toContain("- Beats: 3 (timeline.md numbers them as the plan's captions), 2 shown and said, 1 spoken only");
  });

  it('keeps which beats were only said in the template, and lists them in TEMPLATE.md', async () => {
    expect(pkg.template.captions?.beats).toEqual([{ start: 0, end: 60 }, { start: 110, end: 150, shown: false }, { start: 200, end: 260 }]);
    expect(await readFile(path.join(dir, 'template.json'), 'utf8')).not.toContain('中间');
    expect(pkg.slots.captions?.lines[1]).toMatchObject({ at: 'captions[1]', shown: false, example: { text: '中间这段没有字幕', chars: 8 } });
    const card = await readFile(path.join(dir, 'TEMPLATE.md'), 'utf8');
    expect(card).toContain('3 beats: 2 shown as captions in one band, 1 spoken only (heard, not drawn).');
    expect(card).toContain('- captions[1] 3.7-5.0 s, spoken only: "中间这段没有字幕" (8)');
    expect(card).toContain('1. shots[0] 0.0-3.3 s, in: start. Source: footage (footage needs 3.33 s); captions[0]');
  });

  it('fills a template as retarget does, and fills one saved before beats had the flag as all shown', async () => {
    const r = await fillTemplate(rt, { templateDir: dir, fill: plan, outDir: path.join(root, 'fill') });
    expect(r.project).toEqual(retarget({ measure, text, transcript, plan }).project);
    const old = path.join(root, 'old');
    await saveTemplate(rt, { measure, text, transcript, name: 'old', outDir: old });
    const json = JSON.parse(await readFile(path.join(old, 'template.json'), 'utf8')) as { captions: { beats: Record<string, unknown>[] } };
    json.captions.beats = json.captions.beats.map((b) => ({ start: b.start, end: b.end }));
    await writeFile(path.join(old, 'template.json'), JSON.stringify(json));
    const o = await fillTemplate(rt, { templateDir: old, fill: plan, outDir: path.join(root, 'old-fill') });
    expect(o.project?.tracks.find((t): t is CaptionTrack => t.type === 'caption')?.cues).toHaveLength(3);
  });
});

describe('what the voice did to the time', () => {
  it('notes a line spoken more than 25% over its beat with one fix, and sums up the length', () => {
    const notes = overrunNotes({ lines: ['一二三', '一二三四五六七八九十', '好'], slots: [30, 30, 30], spoken: [30, 90, 0], reference: 300, total: 360, fps: 30 });
    expect(notes).toEqual([
      'captions[1] "一二三四五六七八九十": spoken in 90 frames, its beat has 30 (+200%). Fix: a line of about 3 characters.',
      'Length: the reference 300 frames (10.0 s), now 360 (12.0 s), +20%. 1 line(s) above run long.',
    ]);
    const mild = overrunNotes({ lines: ['一二三四', '一二三四五'], slots: [30, 30], spoken: [33, 42], reference: 300, total: 340, fps: 30 });
    expect(mild).toEqual(['captions[1] "一二三四五": spoken in 42 frames, its beat has 30 (+40%). Fix: a line of about 3 characters.', 'Length: the reference 300 frames (10.0 s), now 340 (11.3 s), +13%. 1 line(s) above run long. Or set "speed": 1.25.']);
  });

  it('judges a line by the pace of its own script only', () => {
    const pace = { charactersPerSecond: 4, language: 'zh' };
    expect(paceWarnings(['这一行有点长但是还可以', 'An English line that is far longer than four characters a second'], [60, 60], 30, pace).map((p) => p.at)).toEqual(['captions[0]']);
    expect(paceWarnings(['短句'], [60], 30, pace)).toEqual([]);
  });

  it.skipIf(!ffmpeg)('says after speaking which line ran long and what it did to the length', async () => {
    // A fake speaker: a tone of 0.25 s per character, made by ffmpeg; no model.
    const speaker: Speaker = { speak: async (line, out) => { await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + (0.25 * Array.from(line).length).toFixed(2), '-ac', '1', out]); } };
    const fill: RetargetPlan = { ...colours, captions: ['开头', '这一句只说不显示但是写得很长很长很长', '结尾'] };
    const r = await fillTemplate(rt, { templateDir: dir, fill, outDir: path.join(root, 'spoken'), speak: true, speaker });
    expect(r.spoken?.[1]).toBeGreaterThan(1.25 * 40);
    const notes = r.notes.join('\n');
    expect(notes).toMatch(/captions\[1\] "这一句只说不显示但是写得很长…": spoken in \d+ frames, its beat has 40 \(\+\d+%\)\. Fix: a line of about \d+ characters\./);
    expect(notes).toMatch(/Length: the reference 300 frames \(10\.0 s\), now \d+ \(\d+\.\d s\), \+\d+%/);
    expect(captionsOf({ ...r, problems: [], notes: [] })).toHaveLength(2);
  });
});
