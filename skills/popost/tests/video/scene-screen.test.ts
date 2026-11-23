/**
 * The screen helper (assets/video/screen.js): a still of a page under a camera, driven by steps addressed by the
 * boxes --outline prints. Synthetic stills made with ffmpeg at stillScale 2: white, a blue box at page [400, 200, 160,
 * 80]; the second still is orange. The scene is a 640x360 window filling the canvas. Pixels of frames after a zoom,
 * of a highlight, of the pointer at three times, of a click, of the swap and of typed text; a frame drawn first equals
 * the same frame drawn after others; scene check says what is wrong in words. In a project of several scenes, each
 * scene's window is drawn although the page loads every scene at once and only the first one's segment is on screen
 * then, and a problem is named at the scene that has it. Needs Chrome and ffmpeg.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { PACKAGE_ROOT, runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openSession, type Session } from '../../src/video/render/session';
import { decodePng, pixelAt, pixelsWhere, type Colour, type Rgb } from './make-fixtures';

const probe = await createDiskRuntime();
const ready = (await hasFfmpeg(probe)) && hasChrome();
await probe.cleanup();
let rt: DiskRuntime;

beforeAll(async () => {
  if (!ready) return;
  rt = await createDiskRuntime();
  // Page 640x1200 at stillScale 2: the still is 1280x2400 pixels.
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1280x2400,format=rgb24,drawbox=x=800:y=400:w=320:h=160:color=0x0000ff:t=fill', '-frames:v', '1', path.join(rt.dir, 'still-a.png')]);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff8000:s=1280x2400,format=rgb24', '-frames:v', '1', path.join(rt.dir, 'still-b.png')]);
}, 60_000);
afterAll(async () => {
  await rt?.cleanup();
});

const FPS = 30;
const STEPS = [
  { at: 0.5, zoom: [400, 200, 160, 80], fill: 0.5, for: 0.5 },
  { at: 1.2, highlight: [400, 200, 160, 80], for: 0.3 },
  { at: 1.6, pointer: [400, 200, 160, 80], for: 0.6 },
  { at: 2.4, click: true },
  { at: 2.9, still: '../assets/still-b.png' },
  { at: 3.0, type: 'hello', into: [400, 200, 160, 80], for: 0.5 },
];

/** before: markup and scripts of the scene's own, put in place of the bare window. */
const sceneHtml = (options: object, before = '<div id="window"></div>', selector = '#window'): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#202020}' +
  '#window{position:absolute;left:0;top:0;width:640px;height:360px}</style></head><body>' + before +
  '<script src="../lib/popost-screen.js"></script><script>popostScreen(' + JSON.stringify(selector) + ', ' + JSON.stringify(options) + ');</script></body></html>';

const project = async (name: string, options: object, frames = 120): Promise<string> => {
  const dir = path.join(rt.dir, name);
  await mkdir(path.join(dir, 'scenes'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 640, height: 360, fps: FPS }, materials: [], tracks: [], segments: [{ id: 'a', frames, base: { scene: 'scenes/screen.html' } }] }));
  await writeFile(path.join(dir, 'scenes', 'screen.html'), sceneHtml(options));
  expect((await runCli(rt, ['video', 'scene', 'library', name, '--name', 'screen'])).code).toBe(0);
  for (const f of ['still-a.png', 'still-b.png']) await writeFile(path.join(dir, 'assets', f), await readFile(path.join(rt.dir, f)));
  return name;
};

/** A project of one segment per scene (file name in scenes/ to its HTML), each the given number of frames long. */
const scenesProject = async (name: string, scenes: Record<string, string>, frames = 30): Promise<string> => {
  const dir = path.join(rt.dir, name);
  await mkdir(path.join(dir, 'scenes'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const segments = Object.keys(scenes).map((f, i) => ({ id: 's' + i, frames, base: { scene: 'scenes/' + f } }));
  await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 640, height: 360, fps: FPS }, materials: [], tracks: [], segments }));
  for (const [f, html] of Object.entries(scenes)) await writeFile(path.join(dir, 'scenes', f), html);
  expect((await runCli(rt, ['video', 'scene', 'library', name, '--name', 'screen'])).code).toBe(0);
  await writeFile(path.join(dir, 'assets', 'still-a.png'), await readFile(path.join(rt.dir, 'still-a.png')));
  return name;
};

const isBlue = (c: Colour): boolean => c[2] > 180 && c[0] < 70 && c[1] < 70;
const isRed = (c: Colour): boolean => c[0] > 180 && c[1] < 90 && c[2] < 90;
const isWhite = (c: Colour): boolean => c.every((v) => v > 225);
const isOrange = (c: Colour): boolean => c[0] > 200 && c[1] > 90 && c[1] < 170 && c[2] < 60;
const isMagenta = (c: Colour): boolean => c[0] > 180 && c[2] > 180 && c[1] < 80;
const isDark = (c: Colour): boolean => c.every((v) => v < 110);

/** In-out easing of the helper (and of the engine). */
const inOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

describe.skipIf(!ready)('the screen helper', () => {
  let session: Session;
  const frame = async (n: number): Promise<Rgb> => decodePng(await session.frame(n));
  beforeAll(async () => {
    await project('demo', { still: '../assets/still-a.png', scale: 2, top: 0, pointerColor: '#ff00ff', pointerOutline: '#ff00ff', steps: STEPS });
    session = await openSession(rt, path.join(rt.dir, 'demo'), { reuse: false });
  }, 60_000);
  afterAll(async () => {
    await session?.close();
  });

  it('puts the Skill\'s own file into the project', async () => {
    expect((await runCli(rt, ['video', 'scene', 'library', 'demo', '--name', 'screen'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, library: 'screen', tag: '<script src="../lib/popost-screen.js"></script>' });
    expect(String(rt.json().next)).toContain('popostScreen');
    const shipped = await readFile(path.join(PACKAGE_ROOT, 'assets', 'video', 'screen.js'));
    expect((await readFile(path.join(rt.dir, 'demo', 'lib', 'popost-screen.js'))).equals(shipped)).toBe(true);
  });

  it('shows the whole width first, then moves in until the box fills half the window', async () => {
    // At the start the page's width (640) fills the window: the box is at its own page pixels.
    const start = await frame(0);
    expect(isBlue(pixelAt(start, 480, 240))).toBe(true);
    expect(isWhite(pixelAt(start, 380, 240))).toBe(true);
    // After the zoom (1.0 s) two window pixels per page pixel, the box's middle in the window's middle: 320x160 at (160, 100).
    const zoomed = await frame(32);
    expect(isBlue(pixelAt(zoomed, 320, 180))).toBe(true);
    for (const [x, y] of [[163, 103], [476, 103], [163, 256], [476, 256]] as const) expect(isBlue(pixelAt(zoomed, x, y)), x + ',' + y).toBe(true);
    for (const [x, y] of [[156, 180], [484, 180], [320, 97], [320, 263]] as const) expect(isWhite(pixelAt(zoomed, x, y)), x + ',' + y).toBe(true);
  });

  it('draws the highlight round the box, 6 px out, with a line 4 px wide', async () => {
    const lit = await frame(46);
    const row = pixelsWhere(lit, [140, 180, 170, 181], isRed).map(([x]) => x);
    expect(Math.min(...row)).toBeGreaterThanOrEqual(150);
    expect(Math.max(...row)).toBeLessThanOrEqual(157);
    expect(row.length).toBeGreaterThanOrEqual(3);
    expect(row.length).toBeLessThanOrEqual(5);
    expect(pixelsWhere(lit, [470, 180, 500, 181], isRed).length).toBeGreaterThanOrEqual(3);
  });

  it('brings the pointer to the box on a curve: where it is at three times', async () => {
    const from = [320 + 0.3 * 640, 180 + 0.25 * 360], to = [320, 180];
    const control = [(from[0]! + to[0]!) / 2 + (to[1]! - from[1]!) * 0.25, (from[1]! + to[1]!) / 2 - (to[0]! - from[0]!) * 0.25];
    const expected = (n: number): number[] => {
      const p = inOut(Math.min(1, Math.max(0, (n / FPS - 1.6) / 0.6)));
      return [0, 1].map((i) => (1 - p) * (1 - p) * from[i]! + 2 * (1 - p) * p * control[i]! + p * p * to[i]!);
    };
    for (const n of [53, 57, 70]) {
      const tip = pixelsWhere(await frame(n), [0, 0, 640, 360], isMagenta);
      expect(tip.length, 'frame ' + n).toBeGreaterThan(50);
      const [x, y] = expected(n);
      expect(Math.abs(Math.min(...tip.map((p) => p[0])) - x!), 'x at frame ' + n).toBeLessThanOrEqual(3);
      expect(Math.abs(Math.min(...tip.map((p) => p[1])) - y!), 'y at frame ' + n).toBeLessThanOrEqual(3);
    }
    // Half way it is off the straight line: the path is a curve.
    const mid = expected(57);
    expect(Math.hypot(mid[0]! - (from[0]! + to[0]!) / 2, mid[1]! - (from[1]! + to[1]!) / 2)).toBeGreaterThan(20);
  });

  it('clicks: a ring grows round the point of the click', async () => {
    // 2.467 s: 0.067 s after the click the ring's radius is 4 + 18 * ease-out(0.148), about 10.9 px, still 85% opaque.
    const ring = pixelsWhere(await frame(74), [290, 176, 320, 184], isRed).map(([x]) => x);
    expect(ring.length).toBeGreaterThan(0);
    expect(Math.abs(Math.min(...ring) - (320 - 10.9))).toBeLessThanOrEqual(3);
    // Gone when it is over.
    expect(pixelsWhere(await frame(90), [290, 176, 320, 184], isRed)).toHaveLength(0);
  });

  it('swaps the still at its time, and the highlight of the page before goes with it', async () => {
    const before = await frame(86);
    const after = await frame(88);
    expect(isWhite(pixelAt(before, 20, 20))).toBe(true);
    expect(isOrange(pixelAt(after, 20, 20))).toBe(true);
    expect(pixelsWhere(after, [140, 180, 170, 181], isRed)).toHaveLength(0);
  });

  it('types the text into the box a few characters at a time, with a caret while it types', async () => {
    const box = [170, 110, 470, 250];
    const early = pixelsWhere(await frame(96), box, isDark).length;
    const done = pixelsWhere(await frame(110), box, isDark).length;
    expect(early).toBeGreaterThan(20);
    expect(done).toBeGreaterThan(early);
    expect(isWhite(pixelAt(await frame(110), 460, 240))).toBe(true);
  });

  it('draws a frame the same whichever frame was drawn before it', async () => {
    const fresh = await openSession(rt, path.join(rt.dir, 'demo'), { reuse: false });
    try {
      const first = await fresh.frame(40);
      await fresh.frame(10);
      expect((await fresh.frame(40)).equals(first)).toBe(true);
      const ahead = await fresh.frame(110);
      expect(ahead.length).toBeGreaterThan(0);
      expect((await fresh.frame(57)).equals(await session.frame(57))).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});

describe.skipIf(!ready)('scene check of a screen', () => {
  it('names a box outside the still, a zoom that blurs, steps out of order, each with a fix', async () => {
    const dir = await project('bad', { still: '../assets/still-a.png', scale: 2, steps: [
      { at: 1, zoom: [600, 1300, 100, 50] },
      { at: 2, zoom: [400, 200, 20, 10], fill: 0.9 },
      { at: 1.5, highlight: [400, 200, 160, 80] },
    ] }, 90);
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(2);
    const problems = rt.json().problems as { level: string; message: string; fix: string }[];
    const find = (text: string) => problems.find((p) => p.message.includes(text));
    expect(find('lies outside the still')).toMatchObject({ level: 'error' });
    expect(find('lies outside the still')?.message).toContain('covers x 0..640 and y 0..1200 in page pixels (1280x2400 pixels at scale 2');
    expect(find('lies outside the still')?.fix).toContain('exactly as --outline printed it');
    expect(find('enlarges the still')).toMatchObject({ level: 'warning' });
    expect(find('enlarges the still')?.fix).toContain('--scale');
    expect(find('out of order')).toMatchObject({ level: 'error' });
    expect(find('out of order')?.message).toContain('step 3 (highlight at 1.5 s)');
  }, 60_000);

  it('says which still did not load', async () => {
    const dir = await project('missing', { still: '../assets/nothing.png', steps: [] }, 30);
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(2);
    expect(JSON.stringify(rt.json().problems)).toContain('nothing.png');
  }, 60_000);
});

describe.skipIf(!ready)('the screen helper in a project of several scenes', () => {
  // The page loads every scene at once; when it does, only the first segment is on screen and the others wait in
  // layers that are not displayed, where every element measures 0.
  const STILL = { still: '../assets/still-a.png', scale: 2, top: 0, pointerColor: '#ff00ff', pointerOutline: '#ff00ff' };
  const ZOOM = { at: 0.2, zoom: [400, 200, 160, 80], fill: 0.5, for: 0.3 };
  const screenProblems = (): { level: string; at: string; message: string }[] =>
    (rt.json().problems as { level: string; at: string; message: string }[]).filter((p) => p.message.startsWith('The screen in'));
  const noPointer = (img: Rgb): void => { expect(pixelsWhere(img, [0, 0, 640, 360], isMagenta)).toHaveLength(0); };

  it('draws the window of every scene, not only of the one on screen while the page loaded, and scene check finds nothing', async () => {
    const dir = await scenesProject('many', { 's0.html': sceneHtml({ ...STILL, steps: [] }), 's1.html': sceneHtml({ ...STILL, steps: [ZOOM] }), 's2.html': sceneHtml({ ...STILL, steps: [] }) });
    const session = await openSession(rt, path.join(rt.dir, dir), { reuse: false });
    try {
      // Segments 0 and 2: the page's width fills the window, so the box is at its own page pixels.
      for (const n of [15, 75]) {
        const img = await decodePng(await session.frame(n));
        expect(isBlue(pixelAt(img, 480, 240)), 'box at frame ' + n).toBe(true);
        expect(isWhite(pixelAt(img, 380, 240)), 'page beside it at frame ' + n).toBe(true);
        noPointer(img);
      }
      // Segment 1, 0.67 s in: zoomed until the box fills half the window, 320x160 at (160, 100).
      const zoomed = await decodePng(await session.frame(50));
      for (const [x, y] of [[320, 180], [163, 103], [476, 256]] as const) expect(isBlue(pixelAt(zoomed, x, y)), x + ',' + y).toBe(true);
      expect(isWhite(pixelAt(zoomed, 156, 180))).toBe(true);
      noPointer(zoomed);
    } finally {
      await session.close();
    }
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(0);
    expect(screenProblems()).toEqual([]);
  }, 90_000);

  it('draws a window its own scene hides at first from the first frame that shows it, whatever was drawn before', async () => {
    // The scene's own render hides the window for its first 0.6 s; the helper adds itself after it.
    const hiding = '<div id="wrap"><div id="window"></div></div><script>window.__popostScene = { render: function (s) { document.getElementById("wrap").style.display = s < 0.6 ? "none" : "block"; } };</script>';
    const dir = await scenesProject('hidden-first', { 'screen.html': sceneHtml({ ...STILL, steps: [] }, hiding) }, 60);
    const session = await openSession(rt, path.join(rt.dir, dir), { reuse: false });
    try {
      const hidden = await decodePng(await session.frame(5));
      expect(isDark(pixelAt(hidden, 480, 240))).toBe(true);
      const shown = await decodePng(await session.frame(40));
      expect(isBlue(pixelAt(shown, 480, 240))).toBe(true);
      expect(isWhite(pixelAt(shown, 380, 240))).toBe(true);
      noPointer(shown);
    } finally {
      await session.close();
    }
    // Its first picture (a quarter in, 0.5 s) has no window: that is no fault.
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(0);
    expect(screenProblems()).toEqual([]);
  }, 90_000);

  it('names a window of no size and a selector that matches nothing at the scene that has it', async () => {
    const dir = await scenesProject('wrong', {
      's0.html': sceneHtml({ ...STILL, steps: [] }),
      's1.html': sceneHtml({ ...STILL, steps: [] }, '<div id="window" style="width:0"></div>'),
      's2.html': sceneHtml({ ...STILL, steps: [] }, '<div id="window"></div>', '#nothing'),
    });
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(2);
    expect(screenProblems().map((p) => p.level + ' ' + p.at + ' ' + p.message)).toEqual([
      'error segments[1].base.scene The screen in "scenes/s1.html": The window element has no size: it is drawn 0x360 CSS pixels.',
      'error segments[2].base.scene The screen in "scenes/s2.html": popostScreen: no element matches "#nothing".',
    ]);
  }, 90_000);
});
