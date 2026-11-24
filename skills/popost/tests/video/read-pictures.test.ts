/**
 * describe's pictures and what it says when a label does not explain the frames, on videos synthesized here: a wipe
 * whose edge is a curve led by a moving disc (the fit is poor and the reading says so; its picture shows the disc at
 * several places), a plain dissolve (no warning), and a half-second shot on a flat ground right before a transition
 * (reported with it). Then look --shots-like draws the same pictures of another video. Skipped without ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { fitsPoorly, pictureSheets, transitionFrames } from '../../src/video/describe/frames';
import { describeReference } from '../../src/video/describe/index';
import { gridOf, pickExpression } from '../../src/video/look/sheets';
import { probe, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Boundary, Measure } from '../../src/video/types';
import { encode, ffmpegReady, sourceFrames, xfadeClip } from './read-clips';

const ok = await ffmpegReady();
const W = 320, H = 180, FPS = 30;
/** Tiles as describe draws them (insetPlan: the video is narrower than its sample width), and the sheet's spacing. */
const TILE = { w: 320, h: 180 }, GAP = 4, BAND = 18;
/** A violet neither testsrc2 nor mandelbrot shows, so that the disc is found in a sheet by its colour. */
const DISC: [number, number, number] = [140, 60, 255];

describe('when a label does not fit, and which frames a sheet shows', () => {
  const b = (o: Partial<Boundary>): Boundary => ({ frame: 50, kind: 'wipe', start: 44, end: 56, confidence: 0.9, ...o });
  it('says a label does not fit by its residual, its bend or its confidence, with room for the coarser models', () => {
    expect(fitsPoorly(b({ residual: 0.05, bend: 0 }))).toBe(false);
    expect(fitsPoorly(b({ residual: 0.05, bend: 0.12 }))).toBe(true);
    expect(fitsPoorly(b({ residual: 0.22, bend: 0 }))).toBe(true);
    expect(fitsPoorly(b({ kind: 'dissolve', residual: 0.08, confidence: 0.3 }))).toBe(true);
    // A shaped wipe is read on blocks, a zoom with a few scales: a soft circle or ffmpeg's zoomin fits.
    expect(fitsPoorly(b({ direction: 'center-out', residual: 0.26 }))).toBe(false);
    expect(fitsPoorly(b({ kind: 'zoom', residual: 0.38 }))).toBe(false);
    expect(fitsPoorly(b({ kind: 'cut', start: 49, end: 50, confidence: 1, residual: 0.9 }))).toBe(false);
    expect(fitsPoorly(b({}))).toBe(false);
  });

  it('shows every frame of a short transition, every second of a longer one, and at most 24', () => {
    expect(transitionFrames(10, 25)).toHaveLength(16);
    expect(transitionFrames(10, 33)).toHaveLength(12);
    expect(transitionFrames(0, 199).length).toBeLessThanOrEqual(24);
    expect(pickExpression([3, 4, 5, 9, 12, 13])).toBe('between(n,3,5)+eq(n,9)+between(n,12,13)');
    expect(gridOf(12, 342)).toEqual({ columns: 4, rows: 3 });
    expect(gridOf(12, 192)).toEqual({ columns: 6, rows: 2 });
    expect(gridOf(18, 192)).toEqual({ columns: 6, rows: 3 });
  });

  it('plans the opening at six frames a second, each shot from just before the change into it, each transition with its margins', () => {
    const m: Measure = {
      version: 1, source: { width: 1080, height: 1920, fps: 30, frames: 300, duration: 10, hasAudio: false },
      boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }, { frame: 200, kind: 'dissolve', start: 195, end: 205, confidence: 0.9, residual: 0.02 }],
      shots: [0, 1, 2].map((i) => ({ index: i, start: [0, 90, 200][i] as number, end: [90, 200, 300][i] as number, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#000000', palette: [], events: [] })),
      rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
    };
    const sheets = pictureSheets(m);
    expect(sheets.map((s) => s.file)).toEqual(['opening.jpg', 'shots/01-frames.jpg', 'shots/02-frames.jpg', 'shots/03-frames.jpg', 'transitions/03.jpg']);
    expect(sheets[0]?.frames).toEqual(Array.from({ length: 18 }, (_, i) => i * 5));
    // Shot 2 begins at a cut on frame 90: its sheet starts 0.1 s (3 frames) before it and ends on its last frame.
    expect(sheets[2]?.frames[0]).toBe(87);
    expect(sheets[2]?.frames.at(-1)).toBe(199);
    expect(sheets[2]?.frames).toHaveLength(12);
    // Shot 3 begins with the dissolve mixed on 196-204: 0.1 s before 196.
    expect(sheets[3]?.frames[0]).toBe(193);
    // The dissolve's own sheet: 0.2 s either side of its mixed frames, 190-210, every second frame.
    expect(sheets[4]?.frames[0]).toBe(190);
    expect(sheets[4]?.frames.at(-1)).toBe(210);
    expect(sheets[4]?.marked).toEqual([[196, 204]]);
  });

  it('names the pictures in the text only when they were written', () => {
    const m: Measure = {
      version: 1, source: { width: 320, height: 180, fps: 30, frames: 80, duration: 80 / 30, hasAudio: false },
      boundaries: [{ frame: 40, kind: 'slide', direction: 'right', mode: 'cover', start: 30, end: 50, confidence: 0.8, residual: 0.09, bend: 0.2 }],
      shots: [0, 1].map((i) => ({ index: i, start: i * 40, end: i * 40 + 40, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#000000', palette: [], events: [] })),
      rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
    };
    const plain = describeReference(m, undefined, 'x');
    expect(plain.files['timeline.md']).toContain('| in slide cover right 19f (does not fit well: it may be an effect of its own) |');
    expect(plain.files['REFERENCE.md']).not.toContain('opening.jpg');
    const d = describeReference(m, undefined, 'x', undefined, undefined, { pictures: true });
    expect(d.files['timeline.md']).toContain('| in slide cover right 19f (does not fit well: look at transitions/02.jpg; it may be an effect of its own) |');
    expect(d.files['shots/02.md']).toContain('- In: slide cover right 19f (does not fit well: look at transitions/02.jpg; it may be an effect of its own), mixed on frames 31-49');
    expect(d.files['shots/01.md']).toContain('- Frames: shots/01-frames.jpg');
    expect(d.files['REFERENCE.md']).toContain('## Pictures: open every one before writing a plan');
    expect(d.files['REFERENCE.md']).toContain('1 measured transition kind does not fit the frames well: transitions/02.jpg (slide cover right)');
  });
});

/** The pixels of a JPEG ffmpeg can read, as rgb24. */
const pixels = async (rt: DiskRuntime, file: string): Promise<{ width: number; height: number; data: Uint8Array }> => {
  const p = await probe(rt, file);
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return { width: p.width, height: p.height, data: r.stdout };
};

/** Mean x (in the tile) of the pixels close to a colour in tile k of a sheet, or undefined when there are few. */
const colourIn = (img: { width: number; data: Uint8Array }, columns: number, k: number, rgb: [number, number, number]): number | undefined => {
  const x0 = GAP + (k % columns) * (TILE.w + GAP), y0 = GAP + Math.floor(k / columns) * (TILE.h + BAND + GAP);
  let n = 0, sx = 0;
  for (let y = y0; y < y0 + TILE.h; y++) for (let x = x0; x < x0 + TILE.w; x++) {
    const i = (y * img.width + x) * 3;
    if (Math.abs((img.data[i] as number) - rgb[0]) < 40 && Math.abs((img.data[i + 1] as number) - rgb[1]) < 40 && Math.abs((img.data[i + 2] as number) - rgb[2]) < 40) { n++; sx += x - x0; }
  }
  return n >= 30 ? sx / n : undefined;
};

/** Whether the band under tile k holds a written time: light letters on the dark band, or dark ones on an orange one (red channel). */
const labelled = (img: { width: number; data: Uint8Array }, columns: number, k: number): boolean => {
  const x0 = GAP + (k % columns) * (TILE.w + GAP), y0 = GAP + Math.floor(k / columns) * (TILE.h + BAND + GAP) + TILE.h;
  let light = 0, dark = 0;
  for (let y = y0; y < y0 + BAND; y++) for (let x = x0; x < x0 + TILE.w; x++) {
    const v = img.data[(y * img.width + x) * 3] as number;
    if (v > 200) light++;
    else if (v < 60) dark++;
  }
  return light > 20 && dark > 20;
};

describe.skipIf(!ok)('describe draws the pictures of a reference', () => {
  let rt: DiskRuntime;
  const at = (p: string): string => rt.path.join(rt.dir, p);
  const read = (p: string): Promise<string> => rt.fs.readText(at(p));
  const json = (): Record<string, unknown> => rt.json();

  beforeAll(async () => {
    rt = await createDiskRuntime();
    // A wipe whose edge is a curve bulging half the frame, a disc leading it, between two still pictures.
    const a = await sourceFrames(rt, 'testsrc2', 1, W, H, true), bb = await sourceFrames(rt, 'mandelbrot', 1, W, H, true);
    const F = 12, start = 40 - Math.floor(F / 2), r = 0.12 * H;
    const curved = Array.from({ length: 80 }, (_, i) => {
      const A = a[0] as Uint8Array, B = bb[0] as Uint8Array, f = new Uint8Array(W * H * 3);
      const p = Math.min(1, Math.max(0, (i - start + 1) / (F + 1)));
      const lead = -r + p * (W + 0.5 * W + 2 * r);
      for (let y = 0; y < H; y++) {
        const v = (y - H / 2) / (H / 2), edge = lead - 0.5 * W * v * v;
        for (let x = 0; x < W; x++) {
          const k = (y * W + x) * 3, disc = p > 0 && p < 1 && Math.hypot(x - lead - 0.6 * r, y - H / 2) < r;
          const src = x < edge ? B : A;
          f[k] = disc ? DISC[0] : (src[k] as number); f[k + 1] = disc ? DISC[1] : (src[k + 1] as number); f[k + 2] = disc ? DISC[2] : (src[k + 2] as number);
        }
      }
      return f;
    });
    await encode(rt, curved, W, H, at('curved.mp4'));
    await xfadeClip(rt, at('dissolve.mp4'), [{ src: 'testsrc2', frames: 40, still: true }, { src: 'mandelbrot', frames: 40, still: true }], [{ name: 'fade', frames: 12 }], W, H, FPS);
    // A still picture, a cut to half a second of a flat blue ground with a white square crossing it, then a wipe to a third picture.
    const third = await sourceFrames(rt, 'smptebars', 1, W, H, true);
    const short = Array.from({ length: 100 }, (_, i) => {
      const f = new Uint8Array(W * H * 3);
      const pic = i < 40 ? (a[0] as Uint8Array) : undefined;
      const edgeX = i < 50 ? -1 : Math.round(((i - 49) / 11) * W);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 3;
        let c: [number, number, number];
        if (pic) c = [pic[k] as number, pic[k + 1] as number, pic[k + 2] as number];
        else if (x < edgeX || i >= 60) c = [(third[0] as Uint8Array)[k] as number, (third[0] as Uint8Array)[k + 1] as number, (third[0] as Uint8Array)[k + 2] as number];
        else {
          const sx = 20 + (i - 40) * 14;
          c = x >= sx && x < sx + 40 && y >= 70 && y < 110 ? [245, 245, 245] : [32, 80, 192];
        }
        f[k] = c[0]; f[k + 1] = c[1]; f[k + 2] = c[2];
      }
      return f;
    });
    await encode(rt, short, W, H, at('short.mp4'));
  }, 120_000);
  afterAll(async () => { await rt?.cleanup(); });

  it('says a curved wipe led by a disc does not fit its label, and its picture shows the disc at several places', async () => {
    expect((await runCli(rt, ['video', 'describe', 'curved.mp4', '--out', 'curved'])).code).toBe(0);
    const out = json(), pictures = out.pictures as { transitions: string[]; doNotFit?: string[]; shots: number; opening: string };
    expect(pictures).toMatchObject({ opening: 'opening.jpg', shots: 2, transitions: ['transitions/02.jpg'], doNotFit: ['transitions/02.jpg'] });
    const m = JSON.parse(await read('curved/measure.json')) as Measure;
    expect(m.boundaries).toHaveLength(1);
    expect(m.boundaries[0]?.bend).toBeGreaterThanOrEqual(0.1);
    const line = (await read('curved/timeline.md')).split('\n').find((l) => l.startsWith('#02')) ?? '';
    expect(line).toMatch(/\| in (wipe|slide)[^|]* \(does not fit well: look at transitions\/02\.jpg; it may be an effect of its own\)(; path: [^|]*)? \|/);
    // Its path is measured too: the new picture opens to the right behind an edge that is not straight.
    expect(m.tracks?.[0]).toMatchObject({ id: 'transition-02', of: 'transition', shot: 2 });
    expect(m.tracks?.[0]?.reveal?.edge.shape).not.toBe('straight');
    expect(Math.abs(m.tracks?.[0]?.path.angle ?? 99)).toBeLessThan(10);
    expect(JSON.parse(await read('curved/tracks.json'))).toMatchObject({ version: 1, tracks: [{ id: 'transition-02' }] });
    expect(await read('curved/shots/02.md')).toContain('(does not fit well: look at transitions/02.jpg; it may be an effect of its own)');
    expect(await read('curved/REFERENCE.md')).toContain('not fit the frames well: transitions/02.jpg');
    // The sheet holds the frames the plan says, each with its time, and the disc moves right across them.
    const sheet = pictureSheets(m).find((s) => s.file === 'transitions/02.jpg');
    const n = sheet?.frames.length ?? 0;
    expect(n).toBeGreaterThanOrEqual(8);
    const grid = gridOf(n, TILE.w);
    const img = await pixels(rt, at('curved/transitions/02.jpg'));
    expect([img.width, img.height]).toEqual([GAP + grid.columns * (TILE.w + GAP), GAP + grid.rows * (TILE.h + BAND + GAP)]);
    for (let k = 0; k < n; k++) expect(labelled(img, grid.columns, k), 'time under frame ' + k).toBe(true);
    const xs = Array.from({ length: n }, (_, k) => colourIn(img, grid.columns, k, DISC)).filter((x): x is number => x !== undefined);
    expect(xs.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < xs.length; k++) expect(xs[k] as number).toBeGreaterThan(xs[k - 1] as number);
    expect((xs.at(-1) as number) - (xs[0] as number)).toBeGreaterThan(0.3 * TILE.w);
  });

  it('gives a plain dissolve no warning, and still draws it frame by frame', async () => {
    expect((await runCli(rt, ['video', 'describe', 'dissolve.mp4', '--out', 'dissolve'])).code).toBe(0);
    const pictures = json().pictures as { transitions: string[]; doNotFit?: string[] };
    expect(pictures.transitions).toEqual(['transitions/02.jpg']);
    expect(pictures.doNotFit).toBeUndefined();
    const timeline = await read('dissolve/timeline.md');
    expect(timeline).toMatch(/\| in dissolve \d+f \|/);
    expect(timeline).not.toContain('does not fit');
    const m = JSON.parse(await read('dissolve/measure.json')) as Measure;
    expect(m.boundaries[0]?.residual).toBeLessThan(0.1);
    const sheet = pictureSheets(m).find((s) => s.file === 'transitions/02.jpg');
    const grid = gridOf(sheet?.frames.length ?? 0, TILE.w);
    const img = await pixels(rt, at('dissolve/transitions/02.jpg'));
    expect([img.width, img.height]).toEqual([GAP + grid.columns * (TILE.w + GAP), GAP + grid.rows * (TILE.h + BAND + GAP)]);
    // The opening: six frames a second up to the end of this 2.7 s video (frames 0, 5, ... 75).
    const planned = pictureSheets(m).find((s) => s.file === 'opening.jpg')?.frames;
    expect(planned).toEqual(Array.from({ length: 16 }, (_, i) => i * 5));
    const opening = await pixels(rt, at('dissolve/opening.jpg'));
    const og = gridOf(16, TILE.w);
    expect([opening.width, opening.height]).toEqual([GAP + og.columns * (TILE.w + GAP), GAP + og.rows * (TILE.h + BAND + GAP)]);
  });

  it('reports a half-second shot on a flat ground right before a transition with that transition', async () => {
    expect((await runCli(rt, ['video', 'describe', 'short.mp4', '--out', 'short'])).code).toBe(0);
    const m = JSON.parse(await read('short/measure.json')) as Measure;
    expect(m.shots).toHaveLength(3);
    expect(m.boundaries.map((b) => b.kind === 'cut')).toEqual([true, false]);
    expect((json().pictures as { partOfEffect?: unknown }).partOfEffect).toEqual([{ shot: 2, with: 'transitions/03.jpg' }]);
    const lines = (await read('short/timeline.md')).split('\n');
    expect(lines.find((l) => l.startsWith('#02'))).toContain('most likely part of the change into #03');
    expect(lines.find((l) => l.startsWith('#03'))).toContain(', one effect with #02 before it');
    const shot = await read('short/shots/02.md');
    expect(shot).toContain('- This shot is most likely part of the change into #03');
    expect(shot).not.toContain('Most likely:');
    // The transition's picture starts before the short shot does, so both are seen together.
    const sheet = pictureSheets(m).find((s) => s.file === 'transitions/03.jpg');
    expect(sheet?.with).toBe(2);
    expect(sheet?.frames[0]).toBeLessThan(m.shots[1]?.start ?? 0);
  });

  it('look --shots-like draws the same pictures of another video under the same names', async () => {
    expect((await runCli(rt, ['video', 'look', 'dissolve.mp4', '--shots-like', 'dissolve', '--out', 'again'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, like: at('dissolve'), dir: at('again'), scale: 1 });
    const files = (json().pictures as { file: string }[]).map((p) => rt.path.relative(at('again'), p.file));
    expect(files).toEqual(['opening.jpg', 'shots/01-frames.jpg', 'shots/02-frames.jpg', 'transitions/02.jpg']);
    for (const f of files) expect((await pixels(rt, at('again/' + f))).width).toBe((await pixels(rt, at('dissolve/' + f))).width);
    expect(json().notes).toBeUndefined();
    // A longer video is read at the same share of its length, and says so.
    expect((await runCli(rt, ['video', 'look', 'short.mp4', '--shots-like', 'dissolve', '--out', 'longer'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, scale: 1.25 });
    expect(String((json().notes as string[])[0])).toContain('same share of the length');
    expect((await runCli(rt, ['video', 'look', 'short.mp4', '--shots-like', 'nowhere', '--out', 'x'])).code).toBe(2);
    expect(String(json().error)).toContain('No measure.json in');
    expect((await runCli(rt, ['video', 'look', 'short.mp4', '--shots-like', 'dissolve', '--at', '1', '--out', 'x'])).code).toBe(2);
    expect(String(json().error)).toContain('--shots-like');
  });
});
