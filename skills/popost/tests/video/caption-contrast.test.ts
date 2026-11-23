/**
 * Captions against what is behind them (eval/contrast.ts): the colour of the letters against a ring of the frame
 * around the line (or the outline, or the plate), its median WCAG ratio, the share under 3:1, and how busy it is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { behindOf, BUSY, CALM, contrastByShot, contrastProblems, contrastSamples, measureContrast, parseColour, ratioOf, luminance, readContrast, ringOf, standsOut, textExtent, type CaptionContrast } from '../../src/video/eval/contrast';
import { readback } from '../../src/video/eval/readback';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Resolved, ResolvedItem, ResolvedMotion, ResolvedTextStyle } from '../../src/video/types';
import { ffmpegReady } from './read-clips';

const none: ResolvedMotion = { preset: 'none', frames: 0, ease: 'linear', overshoot: 0, direction: 'up', distance: 0 };
const style = (more: Partial<ResolvedTextStyle> = {}): ResolvedTextStyle => ({ font: 'sans-serif', size: 0.1, weight: 700, color: '#ffffff', align: 'center', italic: false, ...more });
const caption = (id: string, text: string, start: number, end: number, s: Partial<ResolvedTextStyle> = {}, index = 0): ResolvedItem => ({
  id, type: 'text', start, end, box: [0.1, 0.7, 0.8, 0.2], z: 0, enter: none, exit: none, text, style: style(s), cue: { track: 'captions', index },
});
const project = (items: ResolvedItem[], frames = 60): Resolved => ({
  canvas: { width: 320, height: 180, fps: 30 }, frames,
  segments: [{ id: 'calm', index: 0, start: 0, end: 30, base: { kind: 'color', color: '#202020' } }, { id: 'page', index: 1, start: 30, end: 60, base: { kind: 'color', color: '#ffffff' } }],
  items, audio: [],
});

describe('colours and ratios', () => {
  it('reads the colours the project schema accepts', () => {
    expect(parseColour('#fff')).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(parseColour('#11223380')).toEqual({ rgb: [17, 34, 51], alpha: 128 / 255 });
    expect(parseColour('rgba(0, 0, 0, 0.6)')).toEqual({ rgb: [0, 0, 0], alpha: 0.6 });
    expect(parseColour('rgb(100% 0% 0%)')).toEqual({ rgb: [255, 0, 0], alpha: 1 });
    expect(parseColour('hsl(120, 100%, 25%)')?.rgb).toEqual([0, 128, 0]);
    expect(parseColour('White')).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(parseColour('var(--x)')).toBeUndefined();
  });

  it('gives WCAG ratios: 21 for black on white, 1 for a colour on itself', () => {
    expect(ratioOf(luminance([0, 0, 0]), luminance([255, 255, 255]))).toBeCloseTo(21, 5);
    expect(ratioOf(luminance([128, 128, 128]), luminance([128, 128, 128]))).toBe(1);
    expect(ratioOf(luminance([255, 255, 255]), luminance([128, 128, 128]))).toBeCloseTo(3.95, 2);
  });
});

describe('where the letters are and what is behind them', () => {
  it('sets a line in its box: centred across it, as wide as its characters', () => {
    const e = textExtent(caption('c', '四个汉字', 0, 30), { width: 320, height: 180 });
    // 4 em of 18 px, centred in a box 256 px wide from x 32; one em high, centred in a box 36 px high from y 126.
    expect(e).toEqual({ x0: 124, y0: 135, x1: 196, y1: 153 });
    expect(textExtent(caption('c', 'abcd', 0, 30, { align: 'left' }), { width: 320, height: 180 })?.x0).toBe(32);
  });

  it('counts an outline a pixel wide or more, a tight shadow, then a plate; else the picture', () => {
    const at = (s: Partial<ResolvedTextStyle>) => behindOf(caption('c', '字', 0, 30, s), { height: 720 }).behind;
    expect(at({ size: 0.05, stroke: { color: '#000000', width: 0.16 } })).toBe('outline');
    // Half of 0.02 of 0.02 x 720 px is 0.14 px: no outline to see.
    expect(at({ size: 0.02, stroke: { color: '#000000', width: 0.02 } })).toBe('picture');
    expect(at({ shadow: { color: '#000000', blur: 0.12, x: 0.04, y: 0.06 } })).toBe('shadow');
    expect(at({ shadow: { color: '#000000', blur: 0.8, x: 0, y: 0 } })).toBe('picture');
    expect(at({ background: { color: 'rgba(0,0,0,0.6)', padding: 0.25 } })).toBe('plate');
  });
});

/** A frame w x h of one colour, with fn(x, y) painting some pixels another. */
const frame = (w: number, h: number, base: number[], fn: (x: number, y: number) => number[] | undefined = () => undefined): Uint8Array => {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(fn(x, y) ?? base, 3 * (y * w + x));
  return rgb;
};

describe('reading a caption over a frame', () => {
  const extent = { x0: 100, y0: 80, x1: 220, y1: 100 };
  const ring = ringOf(extent, 20, 0);
  const read = (rgb: Uint8Array, colour: string, outline?: string) =>
    readContrast({ rgb, w: 320, h: 180, top: 0, letters: parseColour(colour)!, opacity: 1, ...ring, em: 20, ...(outline ? { outline: parseColour(outline)! } : {}) });

  it('finds white letters on white too close, and on dark grey far enough', () => {
    expect(read(frame(320, 180, [255, 255, 255]), '#ffffff')).toEqual({ ratio: 1, low: 1, busy: 0 });
    expect(read(frame(320, 180, [32, 32, 32]), '#ffffff')).toMatchObject({ low: 0, busy: 0 });
    expect(read(frame(320, 180, [32, 32, 32]), '#ffffff')?.ratio).toBeGreaterThan(15);
  });

  it('finds lines of dark text running behind black letters on a white page busy, though the page is white', () => {
    // Text 2 px high every 8 px, in strokes 2 px wide every 5 px.
    const page = frame(320, 180, [255, 255, 255], (x, y) => (y % 8 < 2 && x % 5 < 2 ? [30, 30, 30] : undefined));
    const r = read(page, '#111111');
    expect(r?.ratio).toBeGreaterThan(15);
    expect(r?.busy).toBeGreaterThanOrEqual(BUSY);
    expect(standsOut(r!)).toBe(false);
  });

  it('finds a caption half over a light area and half over a dark one wanting', () => {
    const half = frame(320, 180, [20, 20, 20], (x) => (x < 160 ? [250, 250, 250] : undefined));
    const r = read(half, '#ffffff');
    expect(r?.low).toBeGreaterThan(0.4);
    expect(standsOut(r!)).toBe(false);
  });

  it('takes an outline for what is behind the letters, whatever the picture', () => {
    expect(read(frame(320, 180, [255, 255, 255]), '#ffffff', '#000000')).toEqual({ ratio: 21, low: 0, busy: 0 });
  });
});

describe('warnings per shot', () => {
  const c = (at: string, ratio: number, low: number, busy: number, text = '一句字幕'): CaptionContrast => ({ id: 'captions#0', text, at, seconds: [0, 1], behind: 'picture', ratio, low, busy, samples: 3 });

  it('warns once per shot, for the worst caption, and says why', () => {
    const resolved = project([]);
    const problems = contrastProblems(resolved, [c('segments[0]', 12, 0, 0), c('segments[1]', 18, 0.05, 2.1, '页面上的字'), c('segments[1]', 1.1, 1, 0, '白字白底')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ level: 'warning', at: 'segments[1]' });
    expect(problems[0]?.message).toContain('2 caption(s) do not stand out');
    expect(problems[0]?.message).toContain('"白字白底" (plain letters over the picture): its letters are 1.1:1 against what is behind them, under the ' + CALM + ':1');
    expect(contrastProblems(resolved, [c('segments[1]', 18, 0.05, 2.1)])[0]?.message).toContain('text or fine detail of the picture runs right behind it (2.1 changes per em');
    expect(problems[0]?.fix).toContain('--caption-band');
    expect(contrastByShot([c('segments[1]', 18, 0.05, 2.1), c('segments[1]', 1.1, 1, 0)])).toEqual([{ at: 'segments[1]', captions: 2, weak: 2, lowestRatio: 1.1, busiest: 2.1 }]);
  });

  it('samples each caption three times in each shot it stays a second in, past its entrance', () => {
    const item = { ...caption('captions#0', '字幕', 0, 60), enter: { ...none, preset: 'fade' as const, frames: 6 } };
    const s = contrastSamples(project([item, caption('captions#1', '短', 50, 60, {}, 1)]));
    expect(s.map((x) => [x.item.id, x.segment, x.frame])).toEqual([['captions#0', 0, 12], ['captions#0', 0, 18], ['captions#0', 0, 24], ['captions#0', 1, 37], ['captions#0', 1, 45], ['captions#0', 1, 52]]);
  });

  it('puts the warnings among readback\'s problems and its readings in readback.json', () => {
    const resolved = project([caption('captions#0', '白字白底', 30, 60)]);
    const r = readback(resolved, { step: 6, sampled: 10, cues: [] }, { contrast: [c('segments[1]', 1.1, 1, 0, '白字白底')] });
    expect(r.contrast).toHaveLength(1);
    expect(r.problems.filter((p) => p.message.includes('do not stand out')).map((p) => p.at)).toEqual(['segments[1]']);
    expect(readback(resolved, { step: 6, sampled: 10, cues: [] }).contrast).toEqual([]);
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('a render measured', () => {
  let rt: DiskRuntime;
  beforeAll(async () => {
    rt = await createDiskRuntime();
    // One second of dark grey, then one of a white page with a grid of thin dark lines (a page of text) in the band.
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=30:d=1',
      '-filter_complex', '[1:v]drawgrid=w=5:h=8:t=2:c=0x1e1e1e[p];[0:v][p]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', rt.path.join(rt.dir, 'two.mp4')]);
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('passes white letters on dark grey and warns about black letters over the page', async () => {
    const resolved = project([caption('captions#0', '第一句字幕', 0, 30), caption('captions#1', '第二句字幕', 30, 60, { color: '#111111' }, 1)]);
    const got = await measureContrast(rt, rt.path.join(rt.dir, 'two.mp4'), resolved);
    expect(got.map((g) => [g.id, g.at, g.behind, g.samples])).toEqual([['captions#0', 'segments[0]', 'picture', 3], ['captions#1', 'segments[1]', 'picture', 3]]);
    expect(standsOut(got[0]!)).toBe(true);
    expect(got[1]?.busy).toBeGreaterThanOrEqual(BUSY);
    expect(contrastProblems(resolved, got).map((p) => p.at)).toEqual(['segments[1]']);
  }, 60_000);
});
