import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { describeReference, roughTokens } from '../../src/video/describe/index';
import { readReference } from '../../src/video/describe/parts';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { watchProgress } from '../../src/video/progress';
import type { TextReader } from '../../src/video/text/index';
import type { Transcriber } from '../../src/video/speech/index';
import type { Measure } from '../../src/video/types';
import type { TextTrack } from '../../src/video/text/types';

const measure: Measure = {
  version: 1,
  source: { width: 1080, height: 1920, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [
    { frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 },
    { frame: 200, kind: 'slide', start: 195, end: 205, direction: 'left', mode: 'push', confidence: 0.3 },
  ],
  shots: [
    { index: 0, start: 0, end: 90, camera: { kind: 'move', zoomPerS: 0.04, panPerS: [0, 0], confidence: 0.9 }, background: '#101010', palette: [{ hex: '#101010', share: 0.8 }], events: [] },
    { index: 1, start: 90, end: 200, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 0.9 }, background: '#ffffff', palette: [],
      events: [{ start: 100, end: 108, box: [0.1, 0.1, 0.8, 0.14], kind: 'appear', how: 'scale', ease: 'out', overshoot: 0.12, colour: '#ff3355', confidence: 0.9 }] },
    { index: 2, start: 200, end: 300, camera: { kind: 'unknown', zoomPerS: 0, panPerS: [0, 0], confidence: 0 }, background: '', palette: [], events: [] },
  ],
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};

const text: TextTrack = {
  step: 6, sampled: 50,
  cues: [
    { text: '只要 19.9', start: 96, end: 150, box: [0.3, 0.86, 0.4, 0.06], role: 'caption', size: 0.06, samples: 9, confidence: 0.97 },
    { text: 'brand', start: 0, end: 300, box: [0.02, 0.02, 0.2, 0.04], role: 'watermark', size: 0.04, samples: 50, confidence: 0.9 },
    { text: 'Sign in', start: 210, end: 290, box: [0.9, 0.05, 0.05, 0.02], role: 'in-picture', size: 0.02, samples: 12, confidence: 0.9 },
  ],
};

describe('layered description', () => {
  const d = describeReference(measure, text, 'case A');

  it('writes a card, a timeline and one file per shot', () => {
    expect(Object.keys(d.files).sort()).toEqual(['REFERENCE.md', 'shots/01.md', 'shots/02.md', 'shots/03.md', 'timeline.md']);
    expect(d.tokens['REFERENCE.md']).toBeLessThan(700);
  });

  it('puts one line per shot in the timeline, with frames, the change into the shot, the camera and its beats', () => {
    const lines = (d.files['timeline.md'] ?? '').split('\n').filter((l) => l.startsWith('#0'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('#01 0.00-3.00 @0-90 | in start | camera push 4.0%/s | ground #101010');
    expect(lines[1]).toBe('#02 3.00-6.67 @90-200 | in cut | camera still | beat 0 | motion 1 event | ground #ffffff');
    expect(lines[2]).toBe('#03 6.67-10.00 @200-300 | in slide push left 9f (unsure) | camera unknown');
    // The caption's words and times are in the numbered beats the shot lines point to.
    expect(d.files['timeline.md']).toContain('\n0 3.20-5.00 "只要 19.9"\n');
  });

  it('says in the card what is uncertain and what a watermark is', () => {
    const card = d.files['REFERENCE.md'] ?? '';
    expect(card).toContain('Length 10.00 s (300 frames), 1080x1920 portrait, with sound');
    expect(card).toContain('1 changes between shots were measured with low confidence, and the camera of 1 shots could not be read');
    expect(card).toContain('Watermark text (not to be re-created): "brand"');
    expect(card).toContain('Captions: 1 lines');
  });

  it('gives a shot file the event with its box, kind, easing and overshoot', () => {
    expect(d.files['shots/02.md']).toContain('- @100-108 (3.33s) top [x 10%-90%, y 10%-24%] appear, scale, ease out, overshoot 0.12, #ff3355');
    expect(d.files['shots/02.md']).toContain('- caption "只要 19.9" @96-150, bottom [x 30%-70%, y 86%-92%], height 6%');
  });

  it('says so when no text was read', () => {
    expect(describeReference(measure, undefined, 'case A').files['REFERENCE.md']).toContain('On-screen text was not read');
  });

  it('counts CJK characters one token each', () => {
    expect(roughTokens('只要')).toBe(2);
    expect(roughTokens('abcdefgh')).toBe(2);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);

describe('progress of describe', () => {
  it('says in one line what every part is doing, how far, and since when', () => {
    let t = 0;
    const p = watchProgress(() => undefined, { label: 'describe', everyMs: 1e9, now: () => t });
    try {
      const measure = p.part('measure'), text = p.part('text');
      measure('measuring the shots', 2, 6);
      text('the reader is reading 150 frames');
      t = 15_000;
      measure('measuring the shots', 3, 6);
      expect(p.line()).toBe('describe, 15 s: measure: measuring the shots 3 of 6 (15 s); text: the reader is reading 150 frames (15 s)');
      p.end('measure');
      t = 31_000;
      expect(p.line()).toBe('describe, 31 s: measure: done in 15 s; text: the reader is reading 150 frames (31 s)');
    } finally {
      p.stop();
    }
  });

  it.skipIf(!ffmpeg)('reads the picture, the text and the speech side by side, and writes a progress line while they work', async () => {
    const video = rt.path.join(rt.dir, 'progress.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-shortest', '-pix_fmt', 'yuv420p', video]);
    const spans: Record<string, [number, number]> = {};
    const slow = async <T>(name: string, value: T): Promise<T> => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 600));
      spans[name] = [start, Date.now()];
      return value;
    };
    const reader: TextReader = { read: (frames) => slow('reader', frames.map((f) => ({ frame: f.frame, lines: [] }))) };
    const transcriber: Transcriber = { transcribe: () => slow('transcriber', { language: 'en', words: [] }) };
    const lines: string[] = [];
    // Side by side is what a budget of four or more processors gets; below four the parts run in turn (cpu-budget.test.ts).
    const rt4 = { ...rt, env: { ...rt.env, POPOST_CPUS: '4' } };
    const r = await readReference(rt4, video, { reader, transcriber, progress: { write: (l) => lines.push(l), everyMs: 150 } });
    expect(r.measure.source.frames).toBe(60);
    expect(r.text?.cues).toEqual([]);
    expect(r.transcript?.words).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.startsWith('describe, '))).toBe(true);
    expect(lines.some((l) => l.includes('text: the reader is reading 10 frames ('))).toBe(true);
    expect(lines.some((l) => l.includes('speech: the transcriber is listening to 2.0 s of sound ('))).toBe(true);
    // Side by side: the reader and the transcriber were at work at the same time.
    const [a, b] = [spans.reader, spans.transcriber];
    expect(a && b && a[0] < b[1] && b[0] < a[1]).toBe(true);
    const count = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lines.length, 'no line after the end').toBe(count);
  });
});
