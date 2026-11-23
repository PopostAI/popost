/**
 * Boundaries on clips made after what real videos showed (development case notes, no real media): a dissolve from a
 * light shot to a dark one, a hard cut with one partly updated frame, a cut followed by a push-in on the new shot,
 * cuts between still pages of one layout, cuts on the second and the last frame (a cover frame before the first shot
 * is a shot of its own: the draft needs to know it), and cuts a tenth of a second from either end. Each clip is drawn
 * here from lavfi pictures or from flat shapes, encoded with ffmpeg and measured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { Boundary, Measure } from '../../src/video/types';
import { measureVideo } from '../../src/video/measure/index';
import { encode, ffmpegReady, H, pool, sourceFrames, W } from './read-clips';
import { hash } from './read-scene';

const ok = await ffmpegReady();
let rt: DiskRuntime;

type Frame = Uint8Array;

/** Every channel mapped to offset + gain x value: a light or a dark version of a picture. */
const tone = (f: Frame, gain: number, offset: number): Frame => f.map((v) => Math.round(offset + gain * v));
const mixOf = (a: Frame, b: Frame, wb: number): Frame => a.map((v, i) => Math.round(v * (1 - wb) + (b[i] as number) * wb));
const hold = (f: Frame, n: number): Frame[] => Array.from({ length: n }, () => f);

/** A box of colour c drawn into a copy of f (fractions of the frame). */
const rect = (f: Frame, x0: number, y0: number, w: number, h: number, c: [number, number, number]): void => {
  for (let y = Math.max(0, Math.round(y0 * H)); y < Math.min(H, Math.round((y0 + h) * H)); y++) {
    for (let x = Math.max(0, Math.round(x0 * W)); x < Math.min(W, Math.round((x0 + w) * W)); x++) f.set(c, (y * W + x) * 3);
  }
};

/**
 * A dark page of a documentation site as a screen recording shows it: the same header, sidebar and caption strip on
 * every page, the content (lines of text, a code block) different per page. Thin light lines on a dark ground, so a
 * page change moves little of the picture by much.
 */
const page = (content: number, caption = content): Frame => {
  const f = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) f.set([24, 26, 30], i * 3);
  rect(f, 0, 0, 1, 0.04, [36, 38, 44]);
  for (let k = 0; k < 14; k++) rect(f, 0.03, 0.08 + 0.05 * k, 0.12 + 0.08 * hash(k), 0.012, [120, 124, 130]);
  for (let k = 0; k < 16; k++) {
    const w = 0.25 + 0.45 * hash(content * 97 + k);
    rect(f, 0.26, 0.07 + 0.048 * k, w, 0.012, k % 5 === 0 ? [90, 200, 150] : [150, 154, 160]);
  }
  rect(f, 0.26, 0.38 + 0.2 * hash(content * 13), 0.68, 0.14, [34, 36, 42]);
  for (let k = 0; k < 5; k++) rect(f, 0.28, 0.4 + 0.2 * hash(content * 13) + 0.024 * k, 0.2 + 0.4 * hash(content * 31 + k), 0.01, [170, 150, 220]);
  rect(f, 0.2 + 0.1 * hash(caption * 7), 0.86, 0.4 + 0.2 * hash(caption * 5), 0.035, [235, 235, 235]);
  return f;
};

/** The picture scaled by s about the point (cx, cy) (fractions of the frame), bilinear. */
const zoomed = (f: Frame, s: number, cx: number, cy: number): Frame => {
  const out = new Uint8Array(f.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1.001, Math.max(0, cx * W + (x - cx * W) / s)), sy = Math.min(H - 1.001, Math.max(0, cy * H + (y - cy * H) / s));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number): number => f[(yy * W + xx) * 3 + c] as number;
        out[(y * W + x) * 3 + c] = Math.round((at(y0, x0) * (1 - fx) + at(y0, x0 + 1) * fx) * (1 - fy) + (at(y0 + 1, x0) * (1 - fx) + at(y0 + 1, x0 + 1) * fx) * fy);
      }
    }
  }
  return out;
};

/** The caption strip of a page drawn over another picture (it stays put while the picture under it moves). */
const captioned = (f: Frame, caption: number): Frame => {
  const out = Uint8Array.from(f);
  rect(out, 0.2 + 0.1 * hash(caption * 7), 0.86, 0.4 + 0.2 * hash(caption * 5), 0.035, [235, 235, 235]);
  return out;
};

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const cut = (frame: number): Boundary => ({ frame, kind: 'cut', start: frame - 1, end: frame, confidence: 1 });

interface Case { name: string; frames: () => Frame[]; truth: Boundary[] }

let pics: Record<string, Frame> = {};
const CASES: Case[] = [
  // a light shot dissolving into a dark one passes through every level in between but never below the dark end
  ...[6, 12].map((F): Case => ({
    name: 'dissolve of ' + F + ' frames from a light shot to a dark one',
    frames: () => {
      const a = tone(pics.test as Frame, 0.35, 160), b = tone(pics.bars as Frame, 0.2, 12);
      const start = 40 - Math.floor(F / 2);
      return [...hold(a, start), ...Array.from({ length: F }, (_, i) => mixOf(a, b, (i + 1) / (F + 1))), ...hold(b, 80 - start - F)];
    },
    truth: [{ frame: 40, kind: 'dissolve', start: 40 - Math.floor(F / 2) - 1, end: 40 - Math.floor(F / 2) + F, confidence: 1 }],
  })),
  {
    // the frame before the cut already shows the bottom of the new picture (a partly updated frame)
    name: 'hard cut with one partly updated frame',
    frames: () => {
      const a = pics.test as Frame, b = pics.mandel as Frame;
      const odd = Uint8Array.from(a);
      odd.set(b.subarray(Math.round(0.85 * H) * W * 3), Math.round(0.85 * H) * W * 3);
      return [...hold(a, 39), odd, ...hold(b, 40)];
    },
    truth: [cut(40)],
  },
  {
    // the new shot starts with a 28-frame eased push-in towards its top right, under a caption that stays put
    name: 'hard cut, then a push-in on the new shot',
    frames: () => {
      const a = page(1), b = page(2, 1);
      const moving = Array.from({ length: 28 }, (_, i) => captioned(zoomed(b, 1.15 + 0.25 * easeInOut(i / 27), 0.8, 0.2), 1));
      return [...hold(a, 40), ...moving, ...hold(moving[27] as Frame, 32)];
    },
    truth: [cut(40)],
  },
  {
    name: 'cuts between still pages of one layout',
    frames: () => [...hold(page(1), 40), ...hold(page(2), 40), ...hold(page(3), 40)],
    truth: [cut(40), cut(80)],
  },
  {
    name: 'a new caption on a still page',
    frames: () => [...hold(page(1, 1), 40), ...hold(page(1, 2), 40)],
    truth: [],
  },
  {
    name: 'a block of text appearing on a still page',
    frames: () => {
      const a = page(1), b = Uint8Array.from(a);
      for (let k = 0; k < 6; k++) rect(b, 0.3, 0.6 + 0.03 * k, 0.5, 0.012, [200, 200, 205]);
      return [...hold(a, 40), ...hold(b, 40)];
    },
    truth: [],
  },
  {
    name: 'cuts on the second and the last frame',
    frames: () => [pics.mandel as Frame, ...hold(pics.test as Frame, 58), pics.bars as Frame],
    truth: [cut(1), cut(59)],
  },
  {
    name: 'cuts a tenth of a second from either end',
    frames: () => [...hold(pics.mandel as Frame, 3), ...hold(pics.test as Frame, 54), ...hold(pics.bars as Frame, 3)],
    truth: [cut(3), cut(57)],
  },
];

/** Truth and measured boundaries paired by takeover frame (within 2). */
const pairs = (truth: Boundary[], got: Boundary[]): Array<[Boundary, Boundary | undefined]> =>
  truth.map((t) => [t, got.find((g) => Math.abs(g.frame - t.frame) <= 2)]);

describe.skipIf(!ok)('read: boundaries the real videos asked for', () => {
  let dir = '';
  let results: Array<{ c: Case; m: Measure }> = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    pics = {
      test: (await sourceFrames(rt, 'testsrc2', 1, W, H, true))[0] as Frame,
      mandel: (await sourceFrames(rt, 'mandelbrot', 1, W, H, true))[0] as Frame,
      bars: (await sourceFrames(rt, 'smptebars', 1, W, H, true))[0] as Frame,
    };
    results = await pool(CASES, 4, async (c, i) => {
      const out = dir + '/f' + i + '.mp4';
      await encode(rt, c.frames(), W, H, out);
      return { c, m: await measureVideo(rt, out) };
    });
    console.info(results.map(({ c, m }) => c.name + ': ' + (m.boundaries.map((b) => b.kind + (b.via ? ' via ' + b.via : '') + ' ' + b.start + '-' + b.end + ' @' + b.frame).join(', ') || 'none')).join('\n'));
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('finds every boundary and nothing else', () => {
    const lines = results.map(({ c, m }) => c.name + ': ' + m.boundaries.length + ' found, ' + pairs(c.truth, m.boundaries).filter(([, g]) => g).length + ' of ' + c.truth.length + ' true');
    expect(lines).toEqual(results.map(({ c }) => c.name + ': ' + c.truth.length + ' found, ' + c.truth.length + ' of ' + c.truth.length + ' true'));
  });

  it('names each kind (a dissolve is not a fade through black, a cut is not a one-frame wipe or a long fade)', () => {
    const got = results.flatMap(({ c, m }) => pairs(c.truth, m.boundaries).map(([t, g]) => c.name + ' @' + t.frame + ': ' + (g ? g.kind : 'missed')));
    expect(got).toEqual(results.flatMap(({ c }) => c.truth.map((t) => c.name + ' @' + t.frame + ': ' + t.kind)));
  });

  it('keeps a cut to its one frame when the new shot moves after it', () => {
    const r = results.find(({ c }) => c.name.startsWith('hard cut, then')) as { m: Measure };
    expect(r.m.boundaries.map((b) => [b.start, b.end])).toEqual([[39, 40]]);
  });

  it('gives every shot at least one frame', () => {
    for (const { m } of results) for (const s of m.shots) expect(s.end).toBeGreaterThan(s.start);
  });
});
