/**
 * Readback reads a render fast enough to wait for (eval/readback-run.ts): the reader sees each text item and each shot
 * where it stands whole (eval/readback-frames.ts), at most two frames a second; the transcript is kept beside readback.json and used again while the
 * render's sound is the same; a first line says what will be done and about how long it takes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { readbackFrames } from '../../src/video/eval/readback-frames';
import { lookingFirst, readbackEstimate, runReadback, textFactor, TRANSCRIPT_CACHE } from '../../src/video/eval/readback-run';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Transcriber } from '../../src/video/speech/types';
import type { TextReader } from '../../src/video/text/types';
import type { Resolved, ResolvedItem, ResolvedMotion } from '../../src/video/types';
import { ffmpegReady } from './read-clips';

const none: ResolvedMotion = { preset: 'none', frames: 0, ease: 'linear', overshoot: 0, direction: 'up', distance: 0 };
const text = (id: string, words: string, start: number, end: number): ResolvedItem => ({
  id, type: 'text', start, end, box: [0.08, 0.82, 0.84, 0.16], z: 0, enter: none, exit: none, text: words,
});
const resolved = (items: ResolvedItem[], fps = 30, frames = 60, shots = 1): Resolved => ({
  canvas: { width: 160, height: 284, fps }, frames,
  segments: Array.from({ length: shots }, (_, k) => ({ id: 's' + k, index: k, start: Math.round((k * frames) / shots), end: Math.round(((k + 1) * frames) / shots), base: { kind: 'color', color: '#000000' } as const })),
  items, audio: [],
});
const fade = (frames: number): ResolvedMotion => ({ ...none, preset: 'fade', frames });

describe('which frames readback reads', () => {
  it('reads a text item just after its entrance and just before its exit, and its shot with the same frames', () => {
    expect(readbackFrames(resolved([text('a', '第一句', 0, 60)]), 60)).toEqual([3, 56]);
    // A fade of 6 frames in and out: past it; the shot takes the item's frames.
    expect(readbackFrames(resolved([{ ...text('a', '第一句', 0, 60), enter: fade(6), exit: fade(6) }]), 60)).toEqual([9, 50]);
    // Words that appear as they are said: after the last one.
    const words = [{ from: 0, to: 1, start: 0, end: 20 }, { from: 1, to: 2, start: 40, end: 60 }];
    expect(readbackFrames(resolved([{ ...text('a', '第一句', 0, 60), reveal: 'words', words }]), 60)).toEqual([3, 43, 56]);
    // Blank text is not read for; a shot alone still is.
    expect(readbackFrames(resolved([text('blank', ' ', 0, 4)]), 60)).toEqual([3, 56]);
  });

  it('reads a short item twice too, once in each half, and every shot clear of the transitions', () => {
    expect(readbackFrames(resolved([text('a', '快', 100, 110)], 30, 300), 300)).toEqual([3, 103, 106, 296]);
    // Four frames: the margin shrinks so that it is still read twice; one frame is read once.
    expect(readbackFrames(resolved([text('a', '快', 100, 104)], 30, 300), 300)).toEqual([3, 101, 102, 296]);
    expect(readbackFrames(resolved([text('a', '快', 100, 101)], 30, 300), 300)).toEqual([3, 100, 296]);
    // Fades that leave it whole for four frames only (a 12-frame caption with fades of 4): read twice there.
    expect(readbackFrames(resolved([{ ...text('a', '快', 100, 112), enter: fade(4), exit: fade(4) }], 30, 300), 300)).toEqual([3, 105, 106, 296]);
    const two = resolved([], 30, 300, 2);
    const mixed: Resolved = { ...two, segments: [two.segments[0] as Resolved['segments'][number], { ...(two.segments[1] as Resolved['segments'][number]), transition: { kind: 'dissolve', a: 140, frames: 20, boundary: 150 } as NonNullable<Resolved['segments'][number]['transition']> }] };
    expect(readbackFrames(mixed, 300)).toEqual([3, 136, 163, 296]);
  });

  it('reads at most two frames a second, spread evenly over the ones it chose', () => {
    const many = resolved(Array.from({ length: 60 }, (_, k) => text('c' + k, '第' + k + '句', 10 * k, 10 * k + 10)), 30, 600);
    const frames = readbackFrames(many, 600);
    expect(frames).toHaveLength(40);
    expect(frames.every((f, i) => i === 0 || f > (frames[i - 1] as number))).toBe(true);
    expect(frames[0]).toBeLessThan(20);
    expect(frames[39]).toBeGreaterThan(580);
  });

  it('reads a 100 s video of 33 captions, 17 of them under a second, in far fewer frames than one step for all', () => {
    // Captions of 0.4 to 0.9 s and of 4 to 5 s in turn, a shot under every two of them, fades of 4 frames.
    let at = 0;
    const items: ResolvedItem[] = [];
    for (let k = 0; k < 33; k++) {
      const len = k % 2 === 1 ? 150 + 8 * (k % 4) : 12 + (k % 5) * 3;
      items.push({ ...text('captions#' + k, '第' + k + '句话', at, at + len), enter: fade(4), exit: fade(4) });
      at += len;
    }
    const frames = readbackFrames(resolved(items, 30, at, 16), at);
    expect(items.filter((i) => i.end - i.start < 30)).toHaveLength(17);
    expect(at).toBeGreaterThan(2900);
    expect(frames.length).toBeLessThanOrEqual(2 * 33 + 2 * 16);
    expect(frames.length).toBeGreaterThanOrEqual(66);
    // Every caption has two frames inside it.
    expect(items.every((i) => frames.filter((f) => f >= i.start && f < i.end).length >= 2)).toBe(true);
  });

  it('expects about the measured seconds, to ten: one part after the other below 4 processors, side by side from 4', () => {
    // 50 s at 30 fps, read every 15 frames: 100 frames (T011 measured 48 s, 27 s and 18 s).
    expect(readbackEstimate({ frames: 100, soundSeconds: 50, cpus: 1, together: false })).toBe(50);
    expect(readbackEstimate({ frames: 100, soundSeconds: 50, cpus: 3, together: false })).toBe(30);
    expect(readbackEstimate({ frames: 100, soundSeconds: 50, cpus: 8, together: true })).toBe(20);
    expect(readbackEstimate({ frames: 4, soundSeconds: 0, cpus: 8, together: true })).toBe(10);
  });

  it('scales the reading by the text a frame holds: 1 for captions, about 8.4 for a page full of text, half to ten times', () => {
    expect(textFactor(3.6)).toBeCloseTo(1, 5);
    expect(textFactor(46)).toBeCloseTo(8.44, 2);
    expect(textFactor(0)).toBe(0.5);
    expect(textFactor(1000)).toBe(10);
    expect(readbackEstimate({ frames: 100, soundSeconds: 50, cpus: 3, together: false, text: textFactor(46) })).toBe(160);
  });

  it('reads eight frames spread over the list first, then the rest, and gives the same samples in order', async () => {
    const calls: number[][] = [];
    const inner: TextReader = { read: (frames) => { calls.push(frames.map((f) => f.frame)); return Promise.resolve(frames.map((f) => ({ frame: f.frame, lines: Array.from({ length: f.frame % 2 ? 3 : 5 }, () => ({ text: '字', confidence: 0.9, box: [0, 0, 0.1, 0.1] as [number, number, number, number] })) }))); } };
    const seen: number[] = [];
    const reader = lookingFirst(inner, (lines) => seen.push(lines));
    const frames = Array.from({ length: 40 }, (_, k) => ({ frame: k, file: 'f' + k + '.jpg' }));
    const out = await reader.read(frames);
    expect(calls[0]).toEqual([2, 7, 12, 17, 22, 27, 32, 37]);
    expect(calls[1]).toHaveLength(32);
    expect(out.map((s) => s.frame)).toEqual(frames.map((f) => f.frame));
    expect(seen).toEqual([4]);
    // Only the first list: a second one (caption strips) is read as it is.
    await reader.read(frames.slice(0, 20));
    expect(calls[2]).toHaveLength(20);
    expect(seen).toHaveLength(1);
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('readback on a render', () => {
  let rt: DiskRuntime;
  const clip = (name: string, frequency: number | undefined) => runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=2',
    ...(frequency ? ['-f', 'lavfi', '-i', 'sine=frequency=' + frequency + ':duration=2', '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-shortest', rt.path.join(rt.dir, name)]);
  beforeAll(async () => {
    rt = await createDiskRuntime();
    await Promise.all([clip('a.mp4', 440), clip('b.mp4', 660), clip('silent.mp4', undefined), runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', rt.path.join(rt.dir, 'twelve.mp4')])]);
  }, 60_000);
  afterAll(() => rt.cleanup());

  const counting = () => {
    const read: number[][] = [];
    let heard = 0;
    const reader: TextReader = { read: (frames) => { read.push(frames.map((f) => f.frame)); return Promise.resolve(frames.map((f) => ({ frame: f.frame, lines: [{ text: '第一句', confidence: 0.95, box: [0.2, 0.8, 0.6, 0.08] }] }))); } };
    const transcriber: Transcriber = { transcribe: () => { heard++; return Promise.resolve({ language: 'zh', words: [{ text: '第一句', start: 0.1, end: 0.9, confidence: 0.9 }] }); } };
    return { read, heard: () => heard, reader, transcriber };
  };
  const run = async (cpus: string, video: string, tools: ReturnType<typeof counting>, dir = 'project') => {
    const lines: string[] = [];
    const at = { ...rt, env: { ...rt.env, POPOST_CPUS: cpus } };
    await rt.fs.mkdir(rt.path.join(rt.dir, dir));
    const r = await runReadback(at, { dir: rt.path.join(rt.dir, dir), video: rt.path.join(rt.dir, video), resolved: resolved([text('captions#0', '第一句', 0, 60)]),
      reader: tools.reader, transcriber: tools.transcriber, language: 'zh', write: (l) => lines.push(l) });
    return { r, lines };
  };

  it('reads the frames it chose, says so first, and hears the sound once while it stays the same', async () => {
    const tools = counting();
    const first = await run('1', 'a.mp4', tools);
    expect(tools.read.flat()).toEqual([3, 56]);
    expect(first.lines[0]).toBe('readback: the text reader reads 2 frames of 2.0 s and the transcriber hears the sound, one after the other (CPU budget 1); expect about 10 s (up to twice that on a slower machine).');
    expect(first.r.text.cues.map((c) => [c.text, c.start, c.end])).toEqual([['第一句', 0, 60]]);
    expect(first.r.transcript?.words.map((w) => w.text)).toEqual(['第一句']);
    expect(first.r.took).toMatchObject({ frames: 2, step: 8, transcriptReused: false, expected: 10 });
    expect(tools.heard()).toBe(1);

    // The same sound again (a render after a scene was fixed): the kept transcript, the same answer.
    const again = await run('4', 'a.mp4', tools);
    expect(again.lines[0]).toContain(', side by side;');
    expect(again.r.took.transcriptReused).toBe(true);
    expect(again.r.transcript).toEqual(first.r.transcript);
    expect(tools.heard()).toBe(1);
    expect(tools.read).toHaveLength(2);

    // Other sound: heard again, and kept in its place.
    const other = await run('4', 'b.mp4', tools);
    expect(other.r.took.transcriptReused).toBe(false);
    expect(tools.heard()).toBe(2);
    const kept = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'project', TRANSCRIPT_CACHE))) as { format: string; key: string };
    expect(kept.format).toBe('popost-video-readback-transcript');
    expect(kept.key).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('says the estimate again when frames spread over the video hold far more text than captions', async () => {
    const lines: string[] = [];
    const page = Array.from({ length: 50 }, () => ({ text: '一行字', confidence: 0.9, box: [0.1, 0.1, 0.5, 0.02] as [number, number, number, number] }));
    const reader: TextReader = { read: (frames) => Promise.resolve(frames.map((f) => ({ frame: f.frame, lines: page }))) };
    await rt.fs.mkdir(rt.path.join(rt.dir, 'dense'));
    await runReadback({ ...rt, env: { ...rt.env, POPOST_CPUS: '1' } }, { dir: rt.path.join(rt.dir, 'dense'), video: rt.path.join(rt.dir, 'twelve.mp4'), resolved: resolved(Array.from({ length: 12 }, (_, k) => text('captions#' + k, '第一句', 30 * k, 30 * k + 30)), 30, 360, 12), reader, write: (l) => lines.push(l) });
    expect(lines[0]).toContain('reads 24 frames of 12.0 s, one after the other (CPU budget 1); expect about 10 s');
    expect(lines[1]).toBe('readback: 8 frames spread over the video hold about 50 lines of text each (a frame of captions holds 3 or 4), so reading takes longer: expect about 80 s in all.');
  }, 60_000);

  it('hears nothing in a render without sound, and keeps no transcript', async () => {
    const tools = counting();
    const r = await run('2', 'silent.mp4', tools, 'quiet');
    expect(r.lines[0]).toBe('readback: the text reader reads 2 frames of 2.0 s, one after the other (CPU budget 2); expect about 10 s (up to twice that on a slower machine).');
    expect(r.r.transcript).toBeUndefined();
    expect(r.r.took.transcriptReused).toBe(false);
    expect(tools.heard()).toBe(0);
    expect(await rt.fs.stat(rt.path.join(rt.dir, 'quiet', TRANSCRIPT_CACHE))).toBeNull();
  }, 60_000);
});
