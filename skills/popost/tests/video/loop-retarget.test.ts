import { describe, expect, it } from 'vitest';
import { projectFps } from '../../src/video/retarget/fps';
import { reflow, reflowMeasure, retarget, spokenForm, type RetargetPlan } from '../../src/video/retarget/index';
import type { Measure } from '../../src/video/types';
import type { TextTrack } from '../../src/video/text/types';

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const measure: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [
    { frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 },
    { frame: 200, kind: 'slide', start: 195, end: 205, direction: 'left', mode: 'push', confidence: 0.9 },
  ],
  shots: [
    { index: 0, start: 0, end: 90, camera: still, background: '', palette: [], events: [] },
    { index: 1, start: 90, end: 200, camera: still, background: '', palette: [], events: [] },
    { index: 2, start: 200, end: 300, camera: still, background: '', palette: [], events: [] },
  ],
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number, role: 'caption' | 'watermark' = 'caption') =>
  ({ text, start, end, box: [0.3, 0.86, 0.4, 0.08] as [number, number, number, number], role, size: 0.08, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('第一句', 0, 60), cue('第二句', 60, 150), cue('第三句', 150, 280), { ...cue('brand', 0, 300, 'watermark'), box: [0.02, 0.02, 0.2, 0.04], size: 0.04 }] };

const plan: RetargetPlan = {
  captions: ['新的第一句', '新的第二句', '新的第三句'],
  shots: [{ footage: 'assets/a.mp4', in: 30 }, { picture: 'assets/b.png', zoom: 0.04 }, { color: '#101010' }],
  sound: 'assets/voice.m4a',
};

describe('retarget', () => {
  it('takes every length, transition and caption time from the reference and every content from the plan', () => {
    const r = retarget({ measure, text, plan });
    expect(r.problems).toEqual([]);
    const p = r.project;
    expect(p?.canvas).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(p?.segments.map((s) => s.frames)).toEqual([90, 110, 100]);
    expect(p?.segments[0]?.base).toEqual({ material: 'video-1', fit: 'cover', in: 30 });
    expect(p?.segments[1]?.base).toEqual({ material: 'image-1', fit: 'cover', camera: { zoom: 0.04 } });
    expect(p?.segments[1]?.in).toBeUndefined();
    expect(p?.segments[2]?.in).toEqual({ transition: 'slide', frames: 9, direction: 'left', mode: 'push' });
    expect(p?.materials.map((m) => [m.id, m.kind, m.file])).toEqual([['video-1', 'video', 'assets/a.mp4'], ['image-1', 'image', 'assets/b.png'], ['audio-1', 'audio', 'assets/voice.m4a']]);
    const captions = p?.tracks.find((t) => t.id === 'captions') as unknown as { box: number[]; style: { size: number }; cues: { text: string; during: { from: number; to: number } }[] };
    expect(captions.cues.map((c) => [c.text, c.during.from, c.during.to])).toEqual([['新的第一句', 0, 60], ['新的第二句', 60, 150], ['新的第三句', 150, 280]]);
    // The band is centred where the reference's captions are (90% of the height), and stays inside the frame.
    const [, top = 0, , height = 0] = captions.box;
    expect(top + height / 2).toBeCloseTo(0.9, 3);
    expect(top + height).toBeLessThanOrEqual(0.99);
    expect(captions.style.size).toBeCloseTo(0.0736, 3);
    expect(r.notes.join(' ')).toContain('watermark (brand) is not re-created');
  });

  it('matches by position and says exactly what does not line up', () => {
    const short = retarget({ measure, text, plan: { ...plan, shots: plan.shots.slice(0, 2) } });
    expect(short.project).toBeUndefined();
    expect(short.problems[0]).toMatchObject({ level: 'error', at: 'shots' });
    expect(short.problems[0]?.message).toContain('The plan has 2 shots; the reference has 3');
    expect(short.problems[0]?.fix).toContain('Add 1 more');
    const fewer = retarget({ measure, text, plan: { ...plan, captions: ['只有一句'] } });
    expect(fewer.project).toBeDefined();
    expect(fewer.problems[0]).toMatchObject({ level: 'warning', at: 'captions' });
    const more = retarget({ measure, text, plan: { ...plan, captions: ['a', 'b', 'c', 'd'] } });
    expect(more.project).toBeUndefined();
    const both = retarget({ measure, text, plan: { ...plan, shots: [{ footage: 'a.mp4', color: '#000' } as never, plan.shots[1]!, plan.shots[2]!] } });
    expect(both.problems[0]?.message).toContain('exactly one of footage, picture, color, card, keep');
  });

  it('keeps the footage of a shot when asked, without doubling the transition the footage already carries', () => {
    const r = retarget({ measure, text, plan: { shots: [{ keep: true }, { keep: true }, { keep: true }] } });
    expect(r.project?.segments.map((s) => s.base)).toEqual([
      { material: 'video-1', fit: 'cover', in: 0 }, { material: 'video-1', fit: 'cover', in: 90 }, { material: 'video-1', fit: 'cover', in: 200 },
    ]);
    expect(r.project?.segments.every((s) => s.in === undefined)).toBe(true);
    expect(r.project?.tracks).toEqual([]);
    const mixed = retarget({ measure, text, plan: { shots: [{ keep: true }, { keep: true }, { color: '#000000' }] } });
    expect(mixed.project?.segments[2]?.in?.transition).toBe('slide');
  });

  it('re-flows time to the spoken lines: beats take the spoken length, pauses stay, boundaries move with their beat', () => {
    // Reference beats: 0-60, 60-150, 150-280 of 300 frames. Spoken: 80, 40 and 130 frames (plus 4 frames of tail each).
    const f = reflow([{ start: 0, end: 60 }, { start: 60, end: 150 }, { start: 150, end: 280 }], [80, 40, 130], 300);
    expect(f.starts).toEqual([0, 84, 128]);
    expect(f.ends).toEqual([84, 128, 262]);
    expect(f.total).toBe(282);
    // The start of a beat maps to its new start; the middle of a beat to the middle of its new span; the tail keeps its length.
    expect([0, 60, 150, 280, 300].map(f.map)).toEqual([0, 84, 128, 262, 282]);
    expect(f.map(30)).toBe(42);
    expect(f.map(105)).toBe(106);
    const r = retarget({ measure, text, plan, spoken: { frames: [80, 40, 130] } });
    // Shots started at 0, 90 and 200 in the reference: 90 lies a third into beat 2, 200 lies 50/130 into beat 3.
    expect(r.project?.segments.map((s) => s.frames)).toEqual([f.map(90), f.map(200) - f.map(90), 282 - f.map(200)]);
    expect(r.timing?.total).toBe(282);
    const captions = r.project?.tracks.find((t) => t.id === 'captions') as unknown as { cues: { during: { from: number; to: number } }[] };
    expect(captions.cues.map((c) => [c.during.from, c.during.to])).toEqual([[0, 84], [84, 128], [128, 262]]);
    const moved = reflowMeasure(measure, f.map, f.total);
    expect(moved.boundaries.map((b) => [b.start, b.frame, b.end])).toEqual([[f.map(90) - 1, f.map(90), f.map(90)], [f.map(200) - 5, f.map(200), f.map(200) + 5]]);
    expect(moved.source.frames).toBe(282);
  });

  it('with hold, a beat keeps its reference length when its line is shorter, and only an overrun moves the rest', () => {
    // Beats of 60, 90 and 130 frames; spoken 80, 40 and 130 (plus 4 frames of tail each).
    const beats = [{ start: 0, end: 60 }, { start: 60, end: 150 }, { start: 150, end: 280 }];
    const f = reflow(beats, [80, 40, 130], 300, true);
    expect(f.starts).toEqual([0, 84, 174]);
    expect(f.ends).toEqual([84, 174, 308]);
    expect(f.total).toBe(328);
    // Every line fits: nothing moves at all.
    const fits = reflow(beats, [50, 60, 100], 300, true);
    expect([fits.starts, fits.ends, fits.total]).toEqual([[0, 60, 150], [60, 150, 280], 300]);
    expect([0, 45, 90, 200, 300].map(fits.map)).toEqual([0, 45, 90, 200, 300]);
    const held = retarget({ measure, text, plan, spoken: { frames: [50, 60, 100], hold: true } });
    expect(held.project?.segments.map((s) => s.frames)).toEqual([90, 110, 100]);
    expect(held.timing?.total).toBe(300);
  });

  it('keeps the reference timing for a line that is not spoken', () => {
    const f = reflow([{ start: 10, end: 60 }, { start: 70, end: 150 }], [0, 100], 200);
    expect(f.starts).toEqual([10, 70]);
    expect(f.total).toBe(224);
  });

  it('builds a card of text on a ground: a title and lines that enter one after another', () => {
    const r = retarget({ measure, text, plan: { shots: [{ keep: true }, { keep: true }, { card: { title: 'Popost.ai', lines: ['第一行', '第二行'] } }] } });
    expect(r.problems).toEqual([]);
    expect(r.project?.segments[2]?.base).toEqual({ color: { type: 'linear', angle: 160, stops: [{ at: 0, color: '#141a2e' }, { at: 1, color: '#0b0d17' }] } });
    const items = r.project?.tracks.filter((t) => t.id.startsWith('shot-03-')) ?? [];
    expect(items.map((t) => [t.id, t.type === 'text' ? t.text : '', t.type === 'text' ? t.during.from : -1])).toEqual([['shot-03-title', 'Popost.ai', 6], ['shot-03-line1', '第一行', 11], ['shot-03-line2', '第二行', 16]]);
    const empty = retarget({ measure, text, plan: { shots: [{ keep: true }, { keep: true }, { card: { title: ' ' } }] } });
    expect(empty.problems[0]).toMatchObject({ level: 'error', at: 'shots[2].card.title' });
  });

  it('lets captions follow the spoken word only when the words of the voice are known', () => {
    const spokenPlan: RetargetPlan = { ...plan, captionSpoken: { color: '#00ff88', pastColor: '#cccccc' }, captionReveal: 'words' };
    const without = retarget({ measure, text, plan: spokenPlan });
    const captionsOf = (p: typeof without.project) => p?.tracks.find((t) => t.id === 'captions') as unknown as { words?: boolean; reveal?: string; style: { spoken?: unknown } };
    expect(captionsOf(without.project).words).toBeUndefined();
    expect(without.notes.join(' ')).toContain('captionSpoken and captionReveal need a voice with words');
    const withWords = retarget({ measure, text, plan: spokenPlan, spoken: { frames: [80, 40, 130] }, wordsFile: 'assets/voice.words.json' });
    expect(captionsOf(withWords.project)).toMatchObject({ words: true, reveal: 'words', style: { spoken: { color: '#00ff88', past: { color: '#cccccc' } } } });
    expect(withWords.project?.materials.find((m) => m.kind === 'audio')).toMatchObject({ file: 'assets/voice.m4a', words: 'assets/voice.words.json' });
    const yellow = retarget({ measure, text, plan: { ...plan, captionSpoken: true }, wordsFile: 'assets/voice.words.json' });
    expect(captionsOf(yellow.project).style.spoken).toEqual({ color: '#ffd84a' });
  });

  it('says that zoom is a rate, and shows a whole picture on a ground when asked', () => {
    const scale = retarget({ measure, text, plan: { ...plan, shots: [plan.shots[0]!, { picture: 'assets/b.png', zoom: 1.06 }, plan.shots[2]!] } });
    expect(scale.project).toBeUndefined();
    expect(scale.problems[0]).toMatchObject({ level: 'error', at: 'shots[1].zoom' });
    expect(scale.problems[0]?.message).toContain('how much the picture grows per second (0.04 = 4% a second), not a scale; it is 1.06');
    const whole = retarget({ measure, text, plan: { ...plan, shots: [{ footage: 'assets/a.mp4', fit: 'contain', ground: '#0b1020' }, { picture: 'assets/b.png', fit: 'contain' }, plan.shots[2]!] } });
    expect(whole.problems).toEqual([]);
    expect(whole.project?.segments[0]?.base).toEqual({ material: 'video-1', fit: 'contain', ground: '#0b1020' });
    expect(whole.project?.segments[1]?.base).toEqual({ material: 'image-1', fit: 'contain' });
    const bad = retarget({ measure, text, plan: { ...plan, shots: [{ footage: 'assets/a.mp4', fit: 'stretch' as never }, plan.shots[1]!, plan.shots[2]!] } });
    expect(bad.problems[0]).toMatchObject({ at: 'shots[0].fit', allowed: ['cover', 'contain'] });
  });

  it('makes a reference at 50 or 60 frames a second at half its rate, and keeps where things are in time', () => {
    expect([24, 25, 29.97, 30, 50, 58.65, 59.94, 60].map(projectFps)).toEqual([24, 25, 30, 30, 25, 29, 30, 30]);
    const double = (n: number): number => n * 2;
    const fast: Measure = {
      ...measure, source: { ...measure.source, fps: 60, frames: 600 },
      boundaries: measure.boundaries.map((b) => ({ ...b, frame: double(b.frame), start: double(b.start), end: double(b.end) })),
      shots: measure.shots.map((s) => ({ ...s, start: double(s.start), end: double(s.end) })),
    };
    const fastText: TextTrack = { ...text, cues: text.cues.map((c) => ({ ...c, start: double(c.start), end: double(c.end) })) };
    const r = retarget({ measure: fast, text: fastText, plan });
    expect(r.project?.canvas.fps).toBe(30);
    expect(r.project?.segments.map((s) => s.frames)).toEqual([90, 110, 100]);
    expect(r.notes.join(' ')).toContain('The reference runs at 60 frames a second; the project is made at 30');
    expect(retarget({ measure, text, plan }).notes.join(' ')).not.toContain('frames a second');
  });

  it('gives a line its spoken form', () => {
    expect(spokenForm('Popost 提示词库，AI 带货', [{ text: 'Popost', as: 'pop post' }, { text: 'AI', as: 'A I' }])).toBe('pop post 提示词库，A I 带货');
    expect(spokenForm('原样', undefined)).toBe('原样');
  });

  it('leaves a beat without a caption when its line is empty, and never lets a cue run into the next', () => {
    const overlapping: TextTrack = { ...text, cues: [cue('a', 0, 70), cue('b', 60, 150), cue('c', 150, 280)] };
    const r = retarget({ measure, text: overlapping, plan: { ...plan, captions: ['一', '', '三'] } });
    const captions = r.project?.tracks.find((t) => t.id === 'captions') as unknown as { cues: { text: string; during: { from: number; to: number } }[] };
    expect(captions.cues.map((c) => [c.text, c.during.from, c.during.to])).toEqual([['一', 0, 60], ['三', 150, 280]]);
  });
});
