/**
 * A bar of sections at the top of a video (three names, the current one marked, through the whole video) was read as
 * three watermarks, and a model dropped it as a platform mark. A row of words whose mark moves between them is a bar
 * laid on in the edit, and so is one of three or more words spread over most of the width over a picture that changes;
 * a plain account mark of a few words side by side, or a row that never changes over a picture that does not either,
 * stays a watermark. The picture changes when what it shows changes, not only its mean colour: a dark screen recording
 * scrolls and opens panels while its mean colour hardly moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { deltaE, toLab } from '../../src/video/measure/colour';
import { barsOf, markedAt, markedText, measureBars, rowsOf } from '../../src/video/text/bar';
import { changedShare, smallOf } from '../../src/video/text/change';
import { buildCues, mergeRowPieces } from '../../src/video/text/cues';
import type { TextCue, TextLine, TextSample, TextTrack } from '../../src/video/text/types';
import type { Box } from '../../src/video/types';
import { encode, ffmpegReady } from './read-clips';

const line = (text: string, x: number, y: number, w: number, h: number): TextLine => ({ text, confidence: 0.95, box: [x, y, w, h] });
const CAPTIONS = ['first we open it', 'then we plug it in', 'and it just works'];
/** 45 samples, one every 6 frames (9 s at 30 fps): a bar of three words, an account mark of three words at the bottom right, captions. */
const samples = (bar: string[]): TextSample[] => Array.from({ length: 45 }, (_, k) => ({
  frame: k * 6,
  lines: [
    ...bar.map((t, i) => line(t, 0.2 + 0.22 * i, 0.04, 0.08, 0.05)),
    line('@maker', 0.62, 0.93, 0.12, 0.035), line('·', 0.76, 0.93, 0.02, 0.035), line('platform', 0.8, 0.93, 0.15, 0.035),
    line(CAPTIONS[Math.floor(k / 15)] ?? '', 0.35, 0.84, 0.3, 0.06),
  ],
}));

describe('a bar of words through the video', () => {
  it('is a bar laid on in the edit when three or more words stay in a row, not watermarks', () => {
    const cues = buildCues(samples(['Intro', 'Setup', 'Results']), { step: 6, total: 270, fps: 30 }).cues;
    const bar = cues.filter((c) => c.bar).sort((a, b) => (a.bar?.at ?? 0) - (b.bar?.at ?? 0));
    expect(bar.map((c) => [c.text, c.role, c.bar])).toEqual([
      ['Intro', 'label', { row: 0, at: 0, of: 3 }], ['Setup', 'label', { row: 0, at: 1, of: 3 }], ['Results', 'label', { row: 0, at: 2, of: 3 }],
    ]);
    expect(bar[0]?.why).toContain('a bar laid on in the edit, not a watermark');
    // an account mark of a few words side by side in a corner stays a watermark
    expect(cues.filter((c) => ['@maker', '·', 'platform'].includes(c.text)).map((c) => c.role)).toEqual(['watermark', 'watermark', 'watermark']);
    expect(cues.filter((c) => c.role === 'caption')).toHaveLength(3);
  });

  it('groups words into rows only when they sit side by side on one line and are on screen together', () => {
    const cue = (text: string, box: Box, start = 0, end = 270): Omit<TextCue, 'role'> => ({ text, start, end, box, size: box[3], samples: 40, confidence: 0.9 });
    const row = rowsOf([cue('b', [0.4, 0.05, 0.1, 0.05]), cue('a', [0.2, 0.05, 0.1, 0.05]), cue('c', [0.6, 0.052, 0.1, 0.05])]);
    expect(row.map((r) => r.map((c) => c.text))).toEqual([['a', 'b', 'c']]);
    expect(rowsOf([cue('top', [0.2, 0.05, 0.1, 0.05]), cue('below', [0.2, 0.12, 0.1, 0.05])])).toEqual([]);
    expect(rowsOf([cue('early', [0.2, 0.05, 0.1, 0.05], 0, 100), cue('late', [0.4, 0.05, 0.1, 0.05], 120, 270)])).toEqual([]);
    expect(rowsOf([cue('small', [0.2, 0.05, 0.1, 0.03]), cue('large', [0.4, 0.04, 0.2, 0.09])])).toEqual([]);
  });

  it('puts a bar read in pieces back together: a pair read as one line, a word split where its mark starts, a dropped letter', () => {
    const piece = (text: string, start: number, end: number, box: Box): Omit<TextCue, 'role'> => ({ text, start, end, box, size: 0.05, samples: Math.round((end - start) / 6), confidence: 0.9 });
    const pieces = [
      piece('Intro', 0, 267, [0.344, 0.043, 0.071, 0.058]), piece('Setup Results', 0, 87, [0.44, 0.042, 0.187, 0.058]),
      piece('Setup', 87, 267, [0.437, 0.042, 0.083, 0.06]), piece('Results', 87, 177, [0.532, 0.043, 0.096, 0.056]),
      // read higher while its plate is behind it
      piece('Result', 177, 267, [0.535, 0.013, 0.085, 0.056]),
    ];
    const merged = mergeRowPieces(pieces, 270).sort((a, b) => a.box[0] - b.box[0]);
    expect(merged.map((c) => [c.text, c.start, c.end, c.box[1]])).toEqual([['Intro', 0, 267, 0.043], ['Setup', 0, 267, 0.042], ['Results', 0, 267, 0.043]]);
    // captions follow one another in one place with other words: never one cue
    const captions = [piece('first we open it', 0, 90, [0.35, 0.84, 0.3, 0.06]), piece('then we plug it in', 90, 180, [0.34, 0.84, 0.32, 0.06]), piece('and it works', 180, 270, [0.38, 0.84, 0.24, 0.06])];
    expect(mergeRowPieces(captions, 270)).toEqual(captions);
    // a word alone on its line is left as the reader read it
    const alone = [piece('@maker', 0, 130, [0.7, 0.93, 0.1, 0.035]), piece('@make', 130, 270, [0.7, 0.93, 0.09, 0.035])];
    expect(mergeRowPieces(alone, 270)).toEqual(alone);
  });

  it('tells a change of what the picture shows, a band left out', () => {
    const w = 64, h = 36;
    const frame = (band: number, below: number): Uint8Array => {
      const rgb = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) rgb.fill(y < 6 ? band : below, 3 * y * w, 3 * (y + 1) * w);
      return rgb;
    };
    const small = (band: number, below: number) => smallOf(frame(band, below), w, h, { skip: [0, 0.2] });
    expect(changedShare(small(40, 30), small(200, 30))).toBe(0);
    expect(changedShare(small(40, 30), small(40, 36))).toBe(0);
    expect(changedShare(small(40, 30), small(40, 60))).toBe(1);
  });

  it('tells the marked word from the box colours, or none', () => {
    const plain: [number, number, number] = [30, 0, -5], lit: [number, number, number] = [70, 5, 60], white: [number, number, number] = [90, 0, 0];
    expect(markedAt([[lit, plain, plain], [plain, plain, lit], [plain, plain, plain], [lit, lit, plain], [plain, white, plain]])).toEqual([0, 2, -1, -1, 1]);
    // of two, the one with the stronger colour
    expect(markedAt([[plain, lit], [lit, plain], [plain, plain]])).toEqual([1, 0, -1]);
  });

  it('names the marked word of each shot', () => {
    const word = (text: string, at: number, highlighted: [number, number][]): TextCue =>
      ({ text, start: 0, end: 300, box: [0.2 + 0.2 * at, 0.04, 0.1, 0.05], role: 'label', size: 0.05, samples: 50, confidence: 0.9, bar: { row: 0, at, of: 3, highlighted } });
    const cues = [word('Intro', 0, [[0, 100]]), word('Setup', 1, [[100, 220]]), word('Results', 2, [[220, 300]])];
    const shots = [{ start: 0, end: 60 }, { start: 60, end: 100 }, { start: 100, end: 160 }, { start: 160, end: 230 }, { start: 230, end: 300 }];
    const [bar] = barsOf(cues, shots);
    expect(bar?.words.map((c) => c.text)).toEqual(['Intro', 'Setup', 'Results']);
    expect(bar?.marked).toEqual([0, 0, 1, 1, 2]);
    expect(markedText(bar ?? { words: [], marked: [] })).toBe('"Intro" shots 1-2, "Setup" shots 3-4, "Results" shot 5');
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('the marked word of a bar, from the frames', () => {
  let rt: DiskRuntime;
  beforeAll(async () => { rt = await createDiskRuntime(); });
  afterAll(() => rt.cleanup());

  /**
   * 270 frames of 320x180: three words in a row at the top, the k-th marked (a yellow plate) in the k-th third when
   * the top is marked; two words at the bottom, the mark on one of them in each half when the pair is marked; a ground
   * that changes colour at each third when the picture moves.
   */
  const W = 320, H = 180;
  const words: Box[] = [[0.2, 0.04, 0.12, 0.06], [0.42, 0.04, 0.12, 0.06], [0.64, 0.04, 0.12, 0.06]];
  const pair: Box[] = [[0.3, 0.86, 0.12, 0.06], [0.5, 0.86, 0.12, 0.06]];
  const paint = (rgb: Uint8Array, box: Box, colour: [number, number, number], grow = 0): void => {
    const x0 = Math.round((box[0] - grow) * W), x1 = Math.round((box[0] + box[2] + grow) * W), y0 = Math.round((box[1] - grow) * H), y1 = Math.round((box[1] + box[3] + grow) * H);
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) rgb.set(colour, 3 * (y * W + x));
  };
  const GROUNDS: [number, number, number][] = [[28, 28, 28], [30, 60, 110], [110, 40, 50]];
  /** The same three words close together (a gap smaller than a plate's room): a neighbour's plate must not count. */
  const tight: Box[] = [[0.3, 0.04, 0.12, 0.06], [0.435, 0.04, 0.12, 0.06], [0.57, 0.04, 0.12, 0.06]];
  const video = async (name: string, o: { top: boolean; pair: boolean; picture: boolean; words?: Box[] }): Promise<string> => {
    const top = o.words ?? words;
    const frames = Array.from({ length: 270 }, (_v, n) => {
      const third = Math.floor(n / 90), rgb = new Uint8Array(W * H * 3);
      const ground = GROUNDS[o.picture ? third : 0] ?? [28, 28, 28];
      for (let i = 0; i < W * H; i++) rgb.set(ground, 3 * i);
      top.forEach((b, i) => {
        const lit = o.top && third === i;
        if (lit) paint(rgb, b, [255, 216, 74], 0.015);
        paint(rgb, [b[0] + 0.02, b[1] + 0.015, b[2] - 0.04, b[3] - 0.03], lit ? [20, 20, 20] : [200, 200, 200]);
      });
      pair.forEach((b, i) => { if (o.pair && Math.floor(n / 135) === i) paint(rgb, b, [240, 60, 60], 0.015); paint(rgb, [b[0] + 0.02, b[1] + 0.015, b[2] - 0.04, b[3] - 0.03], [200, 200, 200]); });
      return rgb;
    });
    const out = rt.path.join(rt.dir, name + '.mp4');
    await encode(rt, frames, W, H, out, 30);
    return out;
  };
  /**
   * A dark screen recording: two or three panels of lines of text that change every 45 frames (every third one
   * scrolling), under a constant grey band with the three words; its mean colour hardly moves. Still: the first panels
   * throughout.
   */
  const screen = async (name: string, still: boolean): Promise<{ out: string; drift: number }> => {
    const frames = Array.from({ length: 270 }, (_v, n) => {
      const seg = still ? 0 : Math.floor(n / 45), scroll = !still && seg % 3 === 2 ? (n % 45) / 2 : 0, panels = 2 + (seg % 2);
      const rgb = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) rgb.set([27, 29, 34], 3 * i);
      for (let p = 0; p < panels; p++) {
        const pw = (1 - 0.02 * (panels + 1)) / panels, x = 0.02 + p * (pw + 0.02);
        paint(rgb, [x, 0.16, pw, 0.82], [42, 45, 52]);
        for (let j = 0; j < 18; j++) {
          const y = 0.19 + j * 0.045 - scroll / H;
          if (y >= 0.17 && y + 0.02 <= 0.97) paint(rgb, [x + 0.03 * pw, y, (0.3 + (0.6 * ((j * 7 + seg * 5 + p * 3) % 11)) / 11) * pw, 0.018], [138, 143, 153]);
        }
      }
      paint(rgb, [0, 0.02, 1, 0.1], [70, 72, 76]);
      words.forEach((b) => paint(rgb, [b[0] + 0.02, b[1] + 0.015, b[2] - 0.04, b[3] - 0.03], [225, 225, 225]));
      return rgb;
    });
    const means = frames.map((rgb) => {
      const s = [0, 0, 0];
      for (let i = 0; i < rgb.length; i++) s[i % 3] = (s[i % 3] as number) + (rgb[i] as number);
      return toLab(s.map((v) => v / (W * H)) as [number, number, number]);
    });
    const out = rt.path.join(rt.dir, name + '.mp4');
    await encode(rt, frames, W, H, out, 30);
    return { out, drift: Math.max(...means.map((m) => deltaE(m, means[0] as typeof m))) };
  };
  const track = (top: Box[] = words): TextTrack => {
    const base = { start: 0, end: 270, samples: 45, confidence: 0.9 };
    return {
      step: 6, sampled: 45,
      cues: [
        ...['Intro', 'Setup', 'Results'].map((text, at): TextCue => ({ ...base, text, box: top[at] as Box, size: 0.06, role: 'label', why: 'bar', bar: { row: 0, at, of: 3 } })),
        ...['@maker', 'brand'].map((text, at): TextCue => ({ ...base, text, box: pair[at] as Box, size: 0.05, role: 'watermark', why: 'mark' })),
      ],
    };
  };

  it('marks each word of the bar over its third, and makes two words whose mark moves a bar', async () => {
    const t = await measureBars(rt, await video('moving', { top: true, pair: true, picture: false }), track());
    const spans = t.cues.map((c) => [c.text, c.role, c.bar?.row, c.bar?.highlighted]);
    const near = (got: unknown, want: [number, number]): boolean => Array.isArray(got) && got.length === 1 && Math.abs((got[0] as number[])[0]! - want[0]) <= 16 && Math.abs((got[0] as number[])[1]! - want[1]) <= 16;
    expect(near(spans[0]?.[3], [0, 90]) && near(spans[1]?.[3], [90, 180]) && near(spans[2]?.[3], [180, 270])).toBe(true);
    expect(spans.slice(3).map((s) => [s[0], s[1], s[2]])).toEqual([['@maker', 'label', 1], ['brand', 'label', 1]]);
    expect(t.cues[0]?.why).toContain('the marked one changes: "Intro", then "Setup", then "Results"');
  }, 60_000);

  it('finds the mark of words set close together, a neighbour\'s plate not counted', async () => {
    const t = await measureBars(rt, await video('tight', { top: true, pair: false, picture: false, words: tight }), track(tight));
    expect(t.cues.slice(0, 3).map((c) => (c.bar?.highlighted ?? []).length)).toEqual([1, 1, 1]);
    expect(t.cues[0]?.why).toContain('the marked one changes: "Intro", then "Setup", then "Results"');
  }, 60_000);

  it('leaves two words whose mark never moves as watermarks', async () => {
    const t = await measureBars(rt, await video('still', { top: true, pair: false, picture: false }), track());
    expect(t.cues.slice(3).map((c) => [c.text, c.role, c.bar])).toEqual([['@maker', 'watermark', undefined], ['brand', 'watermark', undefined]]);
  }, 60_000);

  it('keeps a wide row with no mark a bar over a picture that changes, and makes it a watermark over one that does not', async () => {
    const over = await measureBars(rt, await video('unmarked-moving', { top: false, pair: false, picture: true }), track());
    expect(over.cues.slice(0, 3).map((c) => [c.text, c.role, c.bar])).toEqual([['Intro', 'label', { row: 0, at: 0, of: 3 }], ['Setup', 'label', { row: 0, at: 1, of: 3 }], ['Results', 'label', { row: 0, at: 2, of: 3 }]]);
    const still = await measureBars(rt, await video('unmarked-still', { top: false, pair: false, picture: false }), track());
    expect(still.cues.slice(0, 3).map((c) => [c.text, c.role, c.bar])).toEqual([['Intro', 'watermark', undefined], ['Setup', 'watermark', undefined], ['Results', 'watermark', undefined]]);
    expect(still.cues[0]?.why).toContain('never changes its look');
  }, 60_000);

  it('keeps a wide row a bar over a dark screen recording whose mean colour hardly moves, and a watermark over one still screen', async () => {
    const changing = await screen('screen', false);
    expect(changing.drift).toBeLessThan(3);
    const over = await measureBars(rt, changing.out, track());
    expect(over.cues.slice(0, 3).map((c) => [c.text, c.role, c.bar])).toEqual([['Intro', 'label', { row: 0, at: 0, of: 3 }], ['Setup', 'label', { row: 0, at: 1, of: 3 }], ['Results', 'label', { row: 0, at: 2, of: 3 }]]);
    const still = await measureBars(rt, (await screen('screen-still', true)).out, track());
    expect(still.cues.slice(0, 3).map((c) => [c.text, c.role, c.bar])).toEqual([['Intro', 'watermark', undefined], ['Setup', 'watermark', undefined], ['Results', 'watermark', undefined]]);
  }, 60_000);
});
