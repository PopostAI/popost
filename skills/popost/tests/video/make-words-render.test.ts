import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { CaptionTrack, Project, TextStyle, TextTrack, WordsFile } from '../../src/video/types';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { checkLayout, openRenderer, type Renderer } from '../../src/video/render/index';
import { openSession } from '../../src/video/render/session';
import { decodePng, pixelsWhere, playedAndJumped, projectDir, type Colour, type Rgb } from './make-fixtures';

const W = 180;
const H = 320;

/** What is said, one token every 8 frames from frame 10, with a pause before "dd": ww 10..17, mm 18..25, ww 26..33, dd 40..47, ee 48..55, ff 56..63. */
const STARTS = [10, 18, 26, 40, 48, 56];
const WORDS: WordsFile = { fps: 30, tokens: ['ww', 'mm', 'ww', 'dd', 'ee', 'ff'].map((text, k) => ({ text, start: STARTS[k] ?? 0, end: (STARTS[k] ?? 0) + 8, confidence: 1, matched: true })) };

const BASE: TextStyle = { size: 0.06, weight: 400, color: '#ffffff', align: 'center' };
const TOP: [number, number, number, number] = [0.05, 0.25, 0.9, 0.12];
const LOW: [number, number, number, number] = [0.05, 0.6, 0.9, 0.12];

/**
 * 80 black frames. "follow" (frames 6..39): white words, the spoken one red and heavier (800 against 400), past ones
 * green. "reveal" (frames 38..69): each word appears when it is spoken, red on a blue box and 1.2x larger while spoken.
 * Two plain text items in the top box for comparison: the same words (70..74), and the first word set at 800 (75..79).
 */
const project = (top: [number, number, number, number] = TOP): Project => {
  const follow: CaptionTrack = { id: 'follow', type: 'caption', box: top, words: true, style: { ...BASE, spoken: { color: '#ff0000', weight: 800, past: { color: '#00ff00' } } }, cues: [{ text: 'ww mm ww', during: { phrase: 'ww mm ww', lead: 4, hold: 6 } }] };
  const reveal: CaptionTrack = {
    id: 'reveal', type: 'caption', box: LOW, words: 'vo', reveal: 'words', enter: { preset: 'type' },
    style: { ...BASE, spoken: { color: '#ff0000', scale: 1.2, background: { color: '#0000ff' }, past: { color: '#00ff00' } } }, cues: [{ text: 'dd ee ff', during: { phrase: 'dd ee ff', lead: 2, hold: 6 } }],
  };
  const plain = (id: string, from: number, more: Partial<TextStyle> = {}): TextTrack => ({ id, type: 'text', text: 'ww mm ww', box: top, style: { ...BASE, ...more }, during: { segment: 's', from, to: from + 5 } });
  return {
    version: 1,
    canvas: { width: W, height: H, fps: 30 },
    materials: [{ id: 'voice', kind: 'audio', file: 'assets/voice.sbg', words: 'assets/voice.words.json', note: 'An SBaGen script: ffmpeg reads it as silence, so the test needs no audio file.' }],
    segments: [{ id: 's', frames: 80, base: { color: '#000000' } }],
    tracks: [{ id: 'vo', type: 'audio', material: 'voice' }, follow, reveal, plain('plain', 70), plain('bold', 75, { spans: [{ from: 0, to: 2, weight: 800 }] })],
  };
};

const writeProject = async (prefix: string, p: Project): Promise<string> => {
  const dir = await projectDir(prefix, p);
  await writeFile(path.join(dir, 'assets', 'voice.sbg'), 'quiet: -\nNOW quiet\n');
  await writeFile(path.join(dir, 'assets', 'voice.words.json'), JSON.stringify(WORDS));
  return dir;
};

const red = (c: Colour): boolean => c[0] > 180 && c[1] < 90 && c[2] < 90;
const green = (c: Colour): boolean => c[1] > 180 && c[0] < 90 && c[2] < 90;
const white = (c: Colour): boolean => c.every((v) => v > 200);
const blue = (c: Colour): boolean => c[2] > 180 && c[0] < 60 && c[1] < 60;

/** Rows of a box, with a margin for the spoken box and scale. */
const band = (box: readonly number[]): [number, number, number, number] => [0, Math.round((box[1] ?? 0) * H) - 8, W, Math.round(((box[1] ?? 0) + (box[3] ?? 0)) * H) + 8];
const meanX = (px: [number, number][]): number => px.reduce((s, p) => s + p[0], 0) / Math.max(1, px.length);

/** Gaps between the letters of a word are narrower than this; the space between two words at this size is wider. */
const WORD_GAP = 4;

/** Runs of columns that hold ink (any channel above 60) in the band, split where WORD_GAP columns are empty: the words. */
const words = (img: Rgb, b: readonly number[]): [number, number][] => {
  const cols = [...new Set(pixelsWhere(img, b, (c) => c.some((v) => v > 60)).map((p) => p[0]))].sort((x, y) => x - y);
  return cols.reduce<[number, number][]>((runs, x) => {
    const last = runs[runs.length - 1];
    if (last && x - last[1] < WORD_GAP) last[1] = x;
    else runs.push([x, x]);
    return runs;
  }, []);
};

/** The RGB bytes of the columns x0 .. x1 (inclusive) of a band, row by row. */
const crop = (img: Rgb, b: readonly number[], x0: number, x1: number): Buffer =>
  Buffer.concat(Array.from({ length: (b[3] ?? 0) - (b[1] ?? 0) }, (_r, i) => {
    const y = (b[1] ?? 0) + i;
    return img.data.subarray((y * img.width + x0) * 3, (y * img.width + x1 + 1) * 3);
  }));

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('words: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const rgb = async (n: number): Promise<Rgb> => {
    if (!renderer) throw new Error('renderer not open');
    return decodePng(await renderer.frame(n));
  };
  const count = (img: Rgb, b: readonly number[]) => ({ red: pixelsWhere(img, b, red), green: pixelsWhere(img, b, green), white: pixelsWhere(img, b, white), blue: pixelsWhere(img, b, blue) });

  beforeAll(async () => {
    dir = await writeProject('make-words-', project());
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives the token being spoken the spoken colour, the tokens after it the base colour and the tokens before it the past colour', async () => {
    const top = band(TOP);
    const first = count(await rgb(13), top);
    const second = count(await rgb(21), top);
    console.log('frame 13 red/white/green ' + [first.red, first.white, first.green].map((x) => x.length).join('/') + ', frame 21 ' + [second.red, second.white, second.green].map((x) => x.length).join('/'));
    expect(first.red.length).toBeGreaterThan(10);
    expect(first.white.length).toBeGreaterThan(20);
    expect(first.green.length).toBe(0);
    expect(meanX(first.red)).toBeLessThan(meanX(first.white));
    for (const c of [second.green, second.red, second.white]) expect(c.length).toBeGreaterThan(10);
    expect(meanX(second.green)).toBeLessThan(meanX(second.red));
    expect(meanX(second.red)).toBeLessThan(meanX(second.white));
  });

  it('with reveal "words", shows no token before its time, and each one from its first frame', async () => {
    const low = band(LOW);
    const at = await Promise.all([39, 43, 51, 60, 66].map(async (n) => [n, count(await rgb(n), low)] as const));
    console.log('reveal red/white/green/blue by frame: ' + at.map(([n, c]) => n + ':' + [c.red, c.white, c.green, c.blue].map((x) => x.length).join('/')).join(' '));
    const by = new Map(at);
    expect(Object.values(by.get(39) ?? {}).map((x) => x.length)).toEqual([0, 0, 0, 0]);
    for (const n of [43, 51, 60]) {
      expect(by.get(n)?.red.length, 'frame ' + n).toBeGreaterThan(10);
      expect(by.get(n)?.blue.length, 'frame ' + n).toBeGreaterThan(10);
      expect(by.get(n)?.white.length, 'frame ' + n).toBe(0);
    }
    expect(by.get(43)?.green.length).toBe(0);
    expect(by.get(51)?.green.length).toBeGreaterThan(10);
    expect([by.get(66)?.green.length ?? 0, by.get(66)?.red.length, by.get(66)?.blue.length]).toSatisfy((c: number[]) => (c[0] ?? 0) > 20 && c[1] === 0 && c[2] === 0);
  });

  it('draws frames inside spoken words the same when played and when jumped to', async () => {
    if (!renderer) throw new Error('renderer not open');
    const r = renderer;
    for (const n of [13, 21, 29, 43, 51, 60]) {
      const [played, jumped] = await playedAndJumped((f) => r.frame(f), n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });

  it('does not move the other words when the spoken word is set heavier (and plain text with a heavier word does)', async () => {
    const top = band(TOP);
    const still = await rgb(8);
    const runs = words(still, top);
    console.log('word columns at frame 8: ' + JSON.stringify(runs));
    expect(runs).toHaveLength(3);
    const [, mid, last] = runs as [[number, number], [number, number], [number, number]];
    const lastOf = (img: Rgb): Buffer => crop(img, top, last[0] - 2, Math.min(W - 1, last[1] + 2));
    const [f13, f21] = [await rgb(13), await rgb(21)];
    expect(lastOf(f13).equals(lastOf(still)), 'last word, frame 13').toBe(true);
    expect(lastOf(f21).equals(lastOf(still)), 'last word, frame 21').toBe(true);
    expect(crop(f13, top, mid[0] - 2, mid[1] + 2).equals(crop(still, top, mid[0] - 2, mid[1] + 2)), 'middle word, frame 13').toBe(true);
    // The control: without reserved room a heavier first word pushes the centred line out on both sides.
    const plain = words(await rgb(72), top);
    const bold = words(await rgb(77), top);
    console.log('word columns: caption ' + JSON.stringify(runs) + ', plain ' + JSON.stringify(plain) + ', first word heavier ' + JSON.stringify(bold));
    expect(bold[2]?.[0]).not.toBe(plain[2]?.[0]);
  });

  it('is measured by checkLayout: the caption fits, and a box too narrow for it is reported', async () => {
    expect(await checkLayout(rt, dir)).toEqual([]);
    const session = await openSession(rt, dir, { scale: 0.5 });
    try {
      const fact = (await session.layout()).find((f) => f.id === 'follow#0');
      expect(fact).toMatchObject({ fits: true, lines: 1 });
      expect(fact?.ink[2]).toBeGreaterThan(0.2);
    } finally {
      await session.close();
    }
    const narrow = await writeProject('make-words-narrow-', project([0.3, 0.25, 0.25, 0.06]));
    try {
      const problems = await checkLayout(rt, narrow);
      console.log(problems.map((p) => p.message).join('\n'));
      expect(problems.some((p) => p.message.startsWith('Cue 0 of caption track "follow" does not fit its box'))).toBe(true);
    } finally {
      await rm(narrow, { recursive: true, force: true });
    }
  });
});
