import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { capturePage, outlinePage, stillPage } from '../../src/video/capture/index';
import { pointerAt, zoomPlan } from '../../src/video/capture/steps';
import { hasFfmpeg, probe, runFfmpegOk } from '../../src/video/media/ffmpeg';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();
let dir = '';

/** A tall page: three bands of 600 px (red, green, blue), a square moved by a CSS animation at 300 px a second. */
const PAGE = '<!doctype html><html><body style="margin:0">' +
  '<style>@keyframes mv{from{transform:translateX(0)}to{transform:translateX(300px)}} #sq{position:fixed;left:0;top:0;width:40px;height:40px;background:#ffff00;animation:mv 1s linear forwards}</style>' +
  '<div style="height:600px;background:#ff0000"></div><div id="green" style="height:600px;background:#00ff00"></div><div style="height:600px;background:#0000ff"></div><div id="sq"></div></body></html>';

/** The colour of one pixel of one frame, decoded by ffmpeg. */
const pixel = async (file: string, frame: number, x: number, y: number): Promise<number[]> => {
  const r = await runFfmpegOk(rt, ['-i', file, '-vf', 'select=eq(n\\,' + frame + '),crop=2:2:' + x + ':' + y + ',scale=1:1:flags=area,format=rgb24', '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  return [...r.stdout.subarray(0, 3)];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'popost-video-capture-'));
  await writeFile(join(dir, 'page.html'), PAGE);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe.skipIf(!ready)('page capture', () => {
  it('records the planned frames, scrolls where the plan says, and steps CSS animations by frame time', async () => {
    const out = join(dir, 'out.mp4');
    const r = await capturePage(rt, {
      url: pathToFileURL(join(dir, 'page.html')).href, out, width: 320, height: 200, fps: 30, settleMs: 100,
      steps: [{ hold: 15 }, { scroll: { to: 1000, frames: 10, ease: 'linear' } }, { hold: 5 }, { scroll: { to: '#green', frames: 6 } }, { hold: 4 }],
    });
    expect(r).toMatchObject({ frames: 40, width: 320, height: 200, fps: 30, pageHeight: 1800 });
    // The yellow square is fixed over the window, which the only note says.
    expect(r.notes).toEqual(["a fixed element covers the upper left of the window in every frame: '#sq'; hide it with --hide '#sq'"]);
    expect(await probe(rt, out)).toMatchObject({ frames: 40, width: 320, height: 200, fps: 30 });
    // Frame 5: still at the top, the red band. Frame 28: scrolled to 1000 px, the green band (600..1200).
    const red = await pixel(out, 5, 300, 150);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[1]).toBeLessThan(60);
    const green = await pixel(out, 28, 300, 150);
    expect(green[1]).toBeGreaterThan(200);
    expect(green[0]).toBeLessThan(60);
    // The last frames: the green band's top is 12% of the window below the top, so the lower part is green, the top red.
    const top = await pixel(out, 39, 300, 6);
    const low = await pixel(out, 39, 300, 150);
    expect(top[0]).toBeGreaterThan(200);
    expect(low[1]).toBeGreaterThan(200);
    // The yellow square moves 10 px per frame (300 px a second at 30 fps): the 12th recorded frame is 12 frame-times in,
    // so it covers x 120..160. It is yellow at x 140 and not yet at x 200.
    const at = await pixel(out, 11, 140, 20);
    expect(at[0]).toBeGreaterThan(200);
    expect(at[1]).toBeGreaterThan(200);
    expect(at[2]).toBeLessThan(80);
    const ahead = await pixel(out, 11, 200, 20);
    expect(ahead[1]).toBeLessThan(80);
  });

  it('says when a scroll goes past the end of the page or does not move, and still records', async () => {
    const r = await capturePage(rt, {
      url: pathToFileURL(join(dir, 'page.html')).href, out: join(dir, 'past.mp4'), width: 320, height: 200, fps: 30, settleMs: 100,
      steps: [{ scroll: { to: 5000, frames: 4 } }, { scroll: { to: 'bottom', frames: 3 } }],
    });
    expect(r.frames).toBe(7);
    expect(r.notes).toHaveLength(3);
    expect(r.notes[0]).toContain('steps[0]: the plan scrolls to 5000 px, but the page can only scroll to 1600 px');
    expect(r.notes[1]).toContain('steps[1]: the scroll does not move');
    expect(r.notes[2]).toContain("'#sq'");
  });

  it('leaves animations that follow the scroll alone, and hides what it is told to hide', async () => {
    // A bar whose width follows the scroll position, and a banner fixed over the page.
    const page = '<!doctype html><html><body style="margin:0"><style>@keyframes grow{from{width:0}to{width:320px}}' +
      '#bar{position:fixed;left:0;top:0;height:20px;background:#ffff00;animation:grow linear;animation-timeline:scroll()}' +
      '#banner{position:fixed;left:0;bottom:0;width:100%;height:60px;background:#ff00ff}</style>' +
      '<div style="height:1800px;background:#0000ff"></div><div id="bar"></div><div id="banner"></div></body></html>';
    await writeFile(join(dir, 'driven.html'), page);
    const out = join(dir, 'driven.mp4');
    const r = await capturePage(rt, { url: pathToFileURL(join(dir, 'driven.html')).href, out, width: 320, height: 200, fps: 30, settleMs: 100, hide: ['#banner'], steps: [{ hold: 3 }, { scroll: { to: 'bottom', frames: 6, ease: 'linear' } }, { hold: 3 }] });
    expect(r.frames).toBe(12);
    // At the bottom the bar spans the window; at the top it has no width. The banner's place shows the page.
    const end = await pixel(out, 11, 300, 8);
    expect(end[0]).toBeGreaterThan(200);
    expect(end[2]).toBeLessThan(80);
    const start = await pixel(out, 1, 300, 8);
    expect(start[2]).toBeGreaterThan(200);
    const low = await pixel(out, 1, 160, 180);
    expect(low[2]).toBeGreaterThan(200);
    expect(low[0]).toBeLessThan(60);
  });

  it('lists the headings of a page with their positions', async () => {
    const page = '<!doctype html><html><head><title>Demo page</title></head><body style="margin:0">' +
      '<h1 style="margin:0;height:100px">Welcome  to\n the demo</h1><div style="height:500px"></div><h2 id="pricing" style="margin:0;height:50px">Pricing</h2>' +
      '<h2 style="display:none">Hidden</h2><div style="height:900px"></div><h3 style="margin:0">Questions</h3></body></html>';
    await writeFile(join(dir, 'outline.html'), page);
    const o = await outlinePage(rt, { url: pathToFileURL(join(dir, 'outline.html')).href, width: 320, height: 200, settleMs: 100 });
    expect(o).toMatchObject({ title: 'Demo page', width: 320, height: 200 });
    expect(o.sections.map(({ box: _box, ...s }) => s)).toEqual([
      { y: 0, tag: 'h1', text: 'Welcome to the demo', selector: 'h1' },
      { y: 600, tag: 'h2', text: 'Pricing', selector: '#pricing' },
      { y: 1550, tag: 'h3', text: 'Questions', selector: 'h3' },
    ]);
    expect(o.sections.slice(0, 2).map((s) => s.box)).toEqual([[0, 0, 320, 100], [0, 600, 320, 50]]);
  });

  describe('a page that answers with an error', () => {
    let server: Server;
    let url = '';
    beforeAll(async () => {
      server = createServer((_req, res) => { res.writeHead(503, { 'content-type': 'text/html' }).end('<h1>Unavailable</h1>'); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/';
    });
    afterAll(async () => { await new Promise((r) => server.close(r)); });

    it('is not recorded', async () => {
      await expect(capturePage(rt, { url, out: join(dir, 'error.mp4'), width: 320, height: 200, fps: 30, settleMs: 100, steps: [{ hold: 5 }] })).rejects.toThrow(/answered HTTP 503, so it was not recorded/);
      await expect(outlinePage(rt, { url, width: 320, height: 200, settleMs: 100 })).rejects.toThrow(/HTTP 503/);
    });
  });

  it('refuses a plan that makes no sense, naming what is wrong', async () => {
    await expect(capturePage(rt, { url: 'ftp://x', out: join(dir, 'x.mp4'), width: 320, height: 200, fps: 30, steps: [] })).rejects.toThrow(/url must start with[\s\S]*no steps/);
    await expect(capturePage(rt, { url: 'https://example.invalid', out: join(dir, 'x.mp4'), width: 320, height: 200, fps: 30, steps: [{ hold: 0 }] })).rejects.toThrow(/at least 1/);
  });
});


type Rgb = [number, number, number];
interface Picture { width: number; height: number; at: (x: number, y: number) => Rgb }

/** One frame of a video as RGB pixels, decoded by ffmpeg. */
const frameOf = async (file: string, n: number, width: number, height: number): Promise<Picture> => {
  const r = await runFfmpegOk(rt, ['-i', file, '-vf', 'select=eq(n\\,' + n + '),format=rgb24', '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const px = r.stdout;
  return { width, height, at: (x, y) => { const i = (Math.round(y) * width + Math.round(x)) * 3; return [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0]; } };
};

/** The smallest box [x0, y0, x1, y1] (x1, y1 one past the last) around the pixels that match, in a part of the picture; null when none does. */
const boxWhere = (pic: Picture, match: (c: Rgb) => boolean, part: [number, number, number, number] = [0, 0, pic.width, pic.height]): [number, number, number, number] | null => {
  let box: [number, number, number, number] | null = null;
  for (let y = part[1]; y < part[3]; y++) for (let x = part[0]; x < part[2]; x++) {
    if (!match(pic.at(x, y))) continue;
    box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1];
  }
  return box;
};
const isRed = (c: Rgb): boolean => c[0] > 170 && c[1] < 100 && c[2] < 100;
const isBlue = (c: Rgb): boolean => c[2] > 170 && c[0] < 100 && c[1] < 100;
const isGreen = (c: Rgb): boolean => c[1] > 140 && c[0] < 110 && c[2] < 110;
const isWhite = (c: Rgb): boolean => c[0] > 225 && c[1] > 225 && c[2] > 225;
const isDark = (c: Rgb): boolean => c[0] + c[1] + c[2] < 300;
/** Each side of the box found within tolerance px of the box expected. */
const near = (found: readonly number[] | null, expected: readonly number[], tolerance = 3): void => {
  expect(found, 'nothing of that colour in the frame').not.toBeNull();
  (found ?? []).forEach((v, i) => expect(Math.abs(v - (expected[i] ?? 0)), 'side ' + i + ' of [' + (found ?? []).join(', ') + '], expected [' + expected.join(', ') + ']').toBeLessThanOrEqual(tolerance));
};

describe.skipIf(!ready)('directed capture', () => {
  /** Small pages served over HTTP; a page may answer after a delay, as a real one does. */
  const pages: Record<string, { html: string; delayMs?: number }> = {};
  let server: Server;
  let origin = '';
  const serve = (path: string, html: string, delayMs = 0): string => {
    pages[path] = { html, delayMs };
    return origin + path;
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = pages[req.url ?? ''];
      if (!p) return void res.writeHead(404).end();
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(p.html), p.delayMs ?? 0);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  const base = { width: 320, height: 200, fps: 30, settleMs: 100 };

  it('zooms until the element fills its share of the window in the middle, keeps the zoom while scrolling, and goes back to the page', async () => {
    // A red box 80x40 at 40,300 (below the window), and a blue bar fixed to the bottom of the window.
    const url = serve('/zoom', '<!doctype html><html><body style="margin:0;background:#fff"><div style="height:1000px"></div>'
      + '<div id="target" style="position:absolute;left:40px;top:300px;width:80px;height:40px;background:#ff0000"></div>'
      + '<div id="bar" style="position:fixed;left:0;bottom:0;width:100%;height:20px;background:#0000ff"></div></body></html>');
    const out = join(dir, 'zoom.mp4');
    const r = await capturePage(rt, { ...base, url, out, steps: [
      { hold: 1 }, { zoom: { to: '#target', frames: 6, fill: 0.5 } }, { hold: 2 },
      { scroll: { to: 190, frames: 4 } }, { hold: 1 }, { zoom: { to: 'page', frames: 4 } }, { hold: 1 },
    ] });
    expect(r.frames).toBe(19);
    // Before: the box is below the window.
    expect(boxWhere(await frameOf(out, 0, 320, 200), isRed)).toBeNull();
    // Zoomed: filling half the width limits (2x), so the box is 160x80 with its middle in the middle of the window. The page
    // scrolled to 170 and the camera shows the window from y 100 down, so the fixed bar is where it always is, enlarged.
    const zoomed = await frameOf(out, 8, 320, 200);
    near(boxWhere(zoomed, isRed), [80, 60, 240, 140]);
    near(boxWhere(zoomed, isBlue), [0, 160, 320, 200]);
    // Scrolled 20 px further while zoomed: the box moves up 40 window pixels and keeps its size; the fixed bar stays.
    const scrolled = await frameOf(out, 13, 320, 200);
    near(boxWhere(scrolled, isRed), [80, 20, 240, 100]);
    near(boxWhere(scrolled, isBlue), [0, 160, 320, 200]);
    // Back to the whole page, still scrolled to 190.
    const page = await frameOf(out, 18, 320, 200);
    near(boxWhere(page, isRed), [40, 110, 120, 150]);
    near(boxWhere(page, isBlue), [0, 180, 320, 200]);
  });

  it('says when a zoom is capped or cannot enlarge, and works out the camera from a box in page pixels', async () => {
    const url = serve('/zoom-notes', '<!doctype html><html><body style="margin:0;height:1000px;background:#fff"></body></html>');
    const r = await capturePage(rt, { ...base, url, out: join(dir, 'zoom-notes.mp4'), steps: [{ zoom: { to: [0, 0, 20, 20], frames: 2 } }, { zoom: { to: 'body', frames: 2 } }] });
    expect(r.notes[0]).toContain('steps[0]: filling 0.7 of the window with the box [0,0,20,20] needs a zoom of 7.0; the zoom stops at 3');
    expect(r.notes[1]).toContain('steps[1]: "body" is larger than 0.7 of the window, so the view only moves to it');
    // An element at the left edge of the page cannot be centred: the camera stops at the edge instead of showing past it.
    const plan = zoomPlan({ x: 0, y: 50, width: 40, height: 20 }, { scrollX: 0, scrollY: 0, maxScroll: 800 }, { width: 320, height: 200 }, 0.25);
    expect(plan.camera).toEqual({ s: 2, x: 0, y: 10 });
    expect(plan.scrollY).toBe(0);
  });

  it('draws a highlight on over its frames, keeps it on the element through a scroll and a zoom at the same line width, and clears it', async () => {
    const url = serve('/mark', '<!doctype html><html><body style="margin:0;background:#fff;height:1200px">'
      + '<div id="item" style="position:absolute;left:100px;top:60px;width:120px;height:40px;background:#dddddd"></div></body></html>');
    const out = join(dir, 'mark.mp4');
    // At scale 2: the window's 320x200 CSS pixels are 640x400 in the video; every position below is doubled.
    const r = await capturePage(rt, { ...base, url, out, scale: 2, steps: [
      { highlight: { to: '#item', frames: 12, color: '#ff0000' } }, { hold: 1 }, { scroll: { to: 30, frames: 2, ease: 'linear' } },
      { zoom: { to: '#item', frames: 2, fill: 0.5 } }, { hold: 1 }, { clear: 4 }, { hold: 1 },
    ] });
    expect(r.frames).toBe(23);
    // The box: 6 px around the element, 94,54 to 226,106, a line of 2 window pixels. Halfway, the top and the right side are drawn.
    const half = await frameOf(out, 5, 640, 400);
    expect(isRed(half.at(320, 108))).toBe(true);
    expect(isRed(half.at(452, 160))).toBe(true);
    expect(isRed(half.at(320, 212))).toBe(false);
    expect(isRed(half.at(188, 160))).toBe(false);
    const done = await frameOf(out, 12, 640, 400);
    for (const [x, y] of [[320, 108], [452, 160], [320, 212], [188, 160]] as const) expect(isRed(done.at(x, y)), x + ',' + y).toBe(true);
    expect(isRed(done.at(320, 160))).toBe(false);
    expect(isRed(done.at(320, 90))).toBe(false);
    const thickness = (pic: Picture, x: number, from: number, to: number): number => { let n = 0; for (let y = from; y < to; y++) if (isRed(pic.at(x, y))) n++; return n; };
    expect(thickness(done, 320, 80, 140)).toBeGreaterThanOrEqual(3);
    expect(thickness(done, 320, 80, 140)).toBeLessThanOrEqual(6);
    // Scrolled 30 px: the box follows the element up.
    expect(isRed((await frameOf(out, 14, 640, 400)).at(320, 48))).toBe(true);
    // Zoomed 4/3 to the element: the page scrolled to 5 and the camera shows x 40..280; the element's top is at window
    // y 73.3, the box's top 6 window pixels above it. The line is as thick as before.
    const zoomed = await frameOf(out, 17, 640, 400);
    const top = boxWhere(zoomed, isRed, [300, 100, 340, 160]);
    near(top ? [top[1]] : null, [2 * (73.33 - 6) - 2], 3);
    expect(thickness(zoomed, 320, 100, 160)).toBeGreaterThanOrEqual(3);
    expect(thickness(zoomed, 320, 100, 160)).toBeLessThanOrEqual(6);
    expect(boxWhere(await frameOf(out, 22, 640, 400), isRed)).toBeNull();
  });

  it('underlines, or dims everything but the element (spot); the next highlight replaces the last', async () => {
    const url = serve('/mark2', '<!doctype html><html><body style="margin:0;background:#fff">'
      + '<div id="item" style="position:absolute;left:100px;top:60px;width:120px;height:40px;background:#dddddd"></div></body></html>');
    const out = join(dir, 'mark2.mp4');
    await capturePage(rt, { ...base, url, out, scale: 2, steps: [
      { highlight: { to: '#item', frames: 4, style: 'underline', color: '#ff0000' } }, { highlight: { to: '#item', frames: 4, style: 'spot' } }, { hold: 1 },
    ] });
    // At scale 2, as above: the line under the element is at y 103, 3 px below it.
    const under = await frameOf(out, 3, 640, 400);
    expect(isRed(under.at(320, 206))).toBe(true);
    expect(isRed(under.at(320, 108))).toBe(false);
    const spot = await frameOf(out, 8, 640, 400);
    expect(spot.at(40, 40)[0]).toBeLessThan(150);
    expect(spot.at(320, 160)[0]).toBeGreaterThan(200);
    expect(isRed(spot.at(320, 206))).toBe(false);
  });

  it('moves the pointer on a curved, eased path from where it was to the middle of the element, and hides it', async () => {
    const url = serve('/point', '<!doctype html><html><body style="margin:0;background:#3366cc;height:600px">'
      + '<div id="a" style="position:absolute;left:40px;top:40px;width:60px;height:30px;background:#204080"></div>'
      + '<div id="b" style="position:absolute;left:220px;top:130px;width:60px;height:30px;background:#204080"></div></body></html>');
    const out = join(dir, 'point.mp4');
    const r = await capturePage(rt, { ...base, url, out, scale: 2, steps: [{ hold: 1 }, { point: { to: '#a', frames: 6 } }, { point: { to: '#b', frames: 8 } }, { pointer: 'hide' }, { hold: 1 }] });
    expect(r.frames).toBe(16);
    // The pointer is the only white on the page; its tip is the top left corner of the white.
    const tip = async (n: number): Promise<number[] | null> => { const b = boxWhere(await frameOf(out, n, 640, 400), isWhite); return b ? [b[0] / 2, b[1] / 2] : null; };
    expect(await tip(0)).toBeNull();
    near(await tip(6), [70, 55], 3);
    const a = { x: 70, y: 55 };
    const b = { x: 250, y: 145 };
    const first = pointerAt(a, b, 1 / 8);
    near(await tip(7), [first.x, first.y], 3);
    // Halfway along the path the pointer is off the straight line by a fourteenth of the distance.
    const middle = pointerAt(a, b, 0.5);
    expect(Math.hypot(middle.x - 160, middle.y - 100)).toBeGreaterThan(10);
    near(await tip(10), [middle.x, middle.y], 3);
    near(await tip(14), [b.x, b.y], 3);
    expect(await tip(15)).toBeNull();
  });

  it('clicks where the pointer is, waits for the page it opens, and puts the pointer back on it with the zoom reset', async () => {
    const url = serve('/a', '<!doctype html><html><body style="margin:0;background:#cc3333">'
      + '<a id="next" href="/b" style="position:absolute;left:120px;top:80px;width:80px;height:40px;background:#222;display:block"></a></body></html>');
    serve('/b', '<!doctype html><html><body style="margin:0;background:#33aa33">'
      + '<div id="title" style="position:absolute;left:60px;top:30px;width:200px;height:40px;background:#ffffff"></div></body></html>', 400);
    const out = join(dir, 'click.mp4');
    const r = await capturePage(rt, { ...base, url, out, steps: [
      { hold: 1 }, { point: { to: '#next', frames: 4 } }, { zoom: { to: '#next', frames: 2, fill: 0.5 } }, { click: '#next' }, { hold: 2 },
      { highlight: { to: '#title', frames: 3, color: '#0000ff' } },
    ] });
    // 1 + 4 + 2, then the press (8 frames, the pointer already there), 2, 3.
    expect(r.frames).toBe(20);
    // The press's first frame is the old page, zoomed (its corner is red); the third is the new page, answered after 400 ms.
    expect(isRed((await frameOf(out, 7, 320, 200)).at(10, 10))).toBe(true);
    expect(isGreen((await frameOf(out, 9, 320, 200)).at(10, 190))).toBe(true);
    // On the new page the pointer is where it clicked, the middle of the window, and the zoom is the whole page again.
    const after = await frameOf(out, 15, 320, 200);
    near(boxWhere(after, isWhite, [140, 90, 200, 140])?.slice(0, 2) ?? null, [160, 100], 3);
    expect(r.notes.some((n) => /steps\[3\]: the page changed to .*\/b; the zoom went back to the whole page/.test(n))).toBe(true);
    // The stage works on the new page: a highlight around its title.
    const line = (await frameOf(out, 19, 320, 200)).at(160, 24);
    expect(line[2] - Math.max(line[0], line[1])).toBeGreaterThan(30);
    // Without a pointer, a click is one frame, taken once the new page has loaded.
    const plain = join(dir, 'click-plain.mp4');
    expect((await capturePage(rt, { ...base, url, out: plain, steps: [{ click: '#next' }, { hold: 1 }] })).frames).toBe(2);
    expect(isGreen((await frameOf(plain, 0, 320, 200)).at(10, 190))).toBe(true);
  });

  it('types into a field a few characters a frame, with the caret shown', async () => {
    const url = serve('/type', '<!doctype html><html><body style="margin:0;background:#ffffff">'
      + '<input id="q" style="position:absolute;left:20px;top:20px;width:260px;height:40px;box-sizing:border-box;padding:0 8px;border:2px solid #999;font:20px monospace;color:#000;outline:none"'
      + ' oninput="document.body.style.background = this.value === \'ab\' ? \'#00ff00\' : \'#ffffff\'"></body></html>');
    const out = join(dir, 'type.mp4');
    const r = await capturePage(rt, { ...base, url, out, steps: [{ type: { into: '#q', text: 'ab', frames: 6 } }, { hold: 1 }] });
    expect(r.frames).toBe(7);
    const field: [number, number, number, number] = [24, 24, 276, 56];
    // Nothing typed yet: the only dark mark in the field is the caret, a thin bar about 1.15 times the font size, at its start.
    const empty = boxWhere(await frameOf(out, 0, 320, 200), isDark, field);
    expect(empty).not.toBeNull();
    const [x0, y0, x1, y1] = empty ?? [0, 0, 0, 0];
    expect(x1 - x0).toBeLessThanOrEqual(3);
    expect(y1 - y0).toBeGreaterThanOrEqual(18);
    expect(y1 - y0).toBeLessThanOrEqual(26);
    expect(Math.abs(x0 - 30)).toBeLessThanOrEqual(2);
    // One character, then two: the marks reach further right; the page saw the input and turned green at "ab".
    const one = boxWhere(await frameOf(out, 2, 320, 200), isDark, field);
    const two = await frameOf(out, 6, 320, 200);
    expect((one?.[2] ?? 0) - x1).toBeGreaterThanOrEqual(8);
    expect((boxWhere(two, isDark, field)?.[2] ?? 0) - (one?.[2] ?? 0)).toBeGreaterThanOrEqual(8);
    expect(isGreen(two.at(300, 190))).toBe(true);
  });

  const OVERLAYS = '<!doctype html><html><head><title>Overlays</title></head><body style="margin:0;font:16px sans-serif">'
    + '<header style="position:sticky;top:0;height:30px;background:#333;color:#fff">Docs Blog</header>'
    + '<div style="position:fixed;inset:0;z-index:-1;background:#f4f4f4"></div>'
    + '<main style="height:1200px;padding:10px 20px"><h1 style="margin:0 0 8px">Title</h1>'
    + '<button class="buy" style="font-size:16px;padding:8px 16px;background:#0066cc;color:#fff;border:0">Buy now</button> <input placeholder="Email">'
    + '<div class="stat" style="font-size:48px">98%</div>'
    + '<div class="cards"><div class="card" style="border:1px solid #ccc;width:140px;height:90px;display:inline-block">One</div> '
    + '<div class="card" style="border:1px solid #ccc;width:140px;height:90px;display:inline-block">Two</div></div></main>'
    + '<div class="lang-switch" style="position:fixed;left:190px;bottom:10px;width:100px;height:30px;background:#ffffcc">English 中文</div>'
    + '<div id="cookie" style="position:fixed;left:0;right:0;bottom:0;height:20px;background:#000;color:#fff">We use cookies</div></body></html>';

  it('lists what covers the window and the elements to point at, with selectors that --hide and the steps take', async () => {
    const url = serve('/overlays', OVERLAYS);
    const o = await outlinePage(rt, { url, width: 480, height: 320, settleMs: 100 });
    expect(o.overlays).toEqual([
      { selector: 'header', position: 'sticky', box: [0, 0, 480, 30], text: 'Docs Blog', kind: 'header', where: 'top' },
      { selector: 'div.lang-switch', position: 'fixed', box: [190, 280, 100, 30], text: 'English 中文', kind: 'language', where: 'lower middle' },
      { selector: '#cookie', position: 'fixed', box: [0, 300, 480, 20], text: 'We use cookies', kind: 'cookie', where: 'bottom' },
    ]);
    expect(o.sections).toEqual([expect.objectContaining({ y: 40, tag: 'h1', text: 'Title', selector: 'h1' })]);
    expect(o.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'button', selector: 'button.buy', text: 'Buy now' }),
      expect.objectContaining({ kind: 'input', selector: 'input[placeholder="Email"]', text: 'Email' }),
      expect.objectContaining({ kind: 'number', selector: 'div.stat', text: '98%' }),
      expect.objectContaining({ kind: 'card', selector: 'div.cards div.card:nth-of-type(1)', text: 'One' }),
      expect.objectContaining({ kind: 'card', selector: 'div.cards div.card:nth-of-type(2)', text: 'Two' }),
    ]));
    expect(o.text).toEqual({ smallestPx: 16, medianPx: 16 });

    // Recorded with the cookie banner hidden: the notes name the other two, the header as probably wanted.
    const steps = [{ hold: 2 }, { scroll: { to: 200, frames: 3 } }, { hold: 1 }];
    const r = await capturePage(rt, { ...base, width: 480, height: 320, url, out: join(dir, 'overlays.mp4'), hide: ['#cookie'], steps });
    expect(r.notes).toEqual([
      "a sticky element covers the top of the window in every frame: 'header' (\"Docs Blog\"); it is probably the site's header, which is usually wanted; to remove it anyway: --hide 'header'",
      "a fixed element, probably a language switcher, covers the lower middle of the window in every frame: 'div.lang-switch' (\"English 中文\"); hide it with --hide 'div.lang-switch'",
    ]);
    // The selector the note gives works for --hide.
    const hidden = await capturePage(rt, { ...base, width: 480, height: 320, url, out: join(dir, 'overlays-hidden.mp4'), hide: ['#cookie', 'div.lang-switch'], steps });
    expect(hidden.notes.filter((n) => n.includes('lang-switch'))).toEqual([]);
    // A target's selector is one the steps accept.
    const marked = await capturePage(rt, { ...base, width: 480, height: 320, url, out: join(dir, 'overlays-marked.mp4'), steps: [{ highlight: { to: 'div.cards div.card:nth-of-type(2)', frames: 2 } }] });
    expect(marked.notes.some((n) => n.startsWith('steps['))).toBe(false);
  });

  it('reports how large the text is in the video, says when it is small, and --zoom lays the page out larger', async () => {
    const url = serve('/text', '<!doctype html><html><body style="margin:0;font:10px sans-serif">' + '<p>Small print that a viewer cannot read in a video.</p>'.repeat(30) + '</body></html>');
    const small = await capturePage(rt, { ...base, width: 960, height: 720, url, out: join(dir, 'text-small.mp4'), steps: [{ hold: 2 }] });
    expect(small.text).toEqual({ smallestPx: 10, medianPx: 10 });
    expect(small.notes).toEqual(['text is small: median 10 px of 720; use --zoom 2 or zoom steps.']);
    const out = join(dir, 'text-zoomed.mp4');
    const zoomed = await capturePage(rt, { ...base, width: 960, height: 720, zoom: 1.5, url, out, steps: [{ hold: 2 }] });
    expect(zoomed.text).toEqual({ smallestPx: 15, medianPx: 15 });
    expect(zoomed.notes).toEqual([]);
    expect(await probe(rt, out)).toMatchObject({ width: 960, height: 720 });
    // The outline is in the pixels of the window the page is laid out in.
    expect(await outlinePage(rt, { url, width: 960, height: 720, zoom: 1.5, settleMs: 100 })).toMatchObject({ width: 640, height: 480, text: { medianPx: 15 } });
  });

  it('refuses steps it does not know or cannot play, naming the step and what to write', async () => {
    const url = serve('/plain', '<!doctype html><html><body style="margin:0;height:600px"></body></html>');
    const steps = [{ jump: 3 }, { zoom: { to: '#x', fill: 2 } }, { pointer: 'show' }, { type: { into: '#q' } }] as unknown as Parameters<typeof capturePage>[1]['steps'];
    await expect(capturePage(rt, { ...base, url, out: join(dir, 'bad.mp4'), steps })).rejects.toThrow(/steps\[0\]: a step has one of the keys[\s\S]*steps\[1\]: zoom.fill[\s\S]*steps\[2\]: pointer takes "hide"[\s\S]*steps\[3\]: type takes/);
    await expect(capturePage(rt, { ...base, url, out: join(dir, 'missing.mp4'), steps: [{ hold: 1 }, { point: { to: '#missing' } }] })).rejects.toThrow(/steps\[1\]: nothing on .* matches "#missing"\. Take a selector from popost video capture <url> --outline/);
    await expect(capturePage(rt, { ...base, url, out: join(dir, 'zoom.mp4'), zoom: 9, steps: [{ hold: 1 }] })).rejects.toThrow(/zoom must be between 1 and 4/);
  });

  it('prints the outline\'s targets, overlays and text size through the CLI, and takes --zoom', async () => {
    const url = serve('/cli', OVERLAYS);
    expect((await runCli(rt, ['video', 'capture', url, '--outline', '--size', '480x320', '--zoom', '1.25'])).code).toBe(0);
    const o = rt.json() as { ok: boolean; width: number; height: number; targets: unknown[]; overlays: { selector: string }[]; text: { medianPx: number } };
    expect(o).toMatchObject({ ok: true, width: 384, height: 256, text: { medianPx: 20 } });
    expect(o.overlays.map((v) => v.selector)).toEqual(['header', 'div.lang-switch', '#cookie']);
    expect(o.targets.length).toBeGreaterThan(3);
    expect((await runCli(rt, ['video', 'capture', url, '--out', 'x.mp4', '--zoom', '9'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--zoom');
  });
});


describe.skipIf(!ready)('stills and boxes', () => {
  const pages: Record<string, string> = {};
  let server: Server;
  let origin = '';
  const serve = (path: string, html: string): string => { pages[path] = html; return origin + path; };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = pages[req.url ?? ''];
      if (html === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  /** The size of a PNG and the colour of one of its pixels. */
  const png = async (file: string): Promise<{ width: number; height: number; at: (x: number, y: number) => number[] }> => {
    const bytes = await readFile(file);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const raw = (await runFfmpegOk(rt, ['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])).stdout;
    return { width, height, at: (x, y) => { const i = (y * width + x) * 3; return [raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0]; } };
  };
  const base = { width: 320, height: 200, settleMs: 100 };

  it('takes one picture of the window where --at puts it, at the size, scale and zoom asked, or of the whole page', async () => {
    const url = serve('/bands', PAGE);
    const top = await stillPage(rt, { ...base, url, out: join(dir, 'top.png') });
    expect(top).toMatchObject({ width: 320, height: 200, pageHeight: 1800, y: 0, stillScale: 1 });
    expect((await png(join(dir, 'top.png'))).at(300, 150)[0]).toBeGreaterThan(200);
    // At the green band: its top 12% of the window below the top of the picture, so the middle is green, the top red.
    const green = await stillPage(rt, { ...base, url, out: join(dir, 'green.png'), at: '#green' });
    expect(green.y).toBe(576);
    const g = await png(join(dir, 'green.png'));
    expect(g.at(300, 150)[1]).toBeGreaterThan(200);
    expect(g.at(300, 10)[0]).toBeGreaterThan(200);
    expect((await stillPage(rt, { ...base, url, out: join(dir, 'low.png'), at: 1500 })).y).toBe(1500);
    expect((await png(join(dir, 'low.png'))).at(300, 150)[2]).toBeGreaterThan(200);
    expect((await stillPage(rt, { ...base, url, out: join(dir, 'past.png'), at: 5000 })).notes[0]).toContain('--at 5000 is past the end of the page');
    expect(await stillPage(rt, { ...base, url, out: join(dir, 'big.png'), scale: 2 })).toMatchObject({ width: 640, height: 400, stillScale: 2 });
    expect(await stillPage(rt, { url, width: 300, height: 200, zoom: 1.5, settleMs: 100, out: join(dir, 'zoomed.png') })).toMatchObject({ width: 300, height: 200, stillScale: 1.5 });
    const whole = await stillPage(rt, { ...base, url, out: join(dir, 'whole.png'), fullPage: true });
    expect(whole).toMatchObject({ width: 320, height: 1800, y: 0 });
    const w = await png(join(dir, 'whole.png'));
    expect([w.width, w.height]).toEqual([320, 1800]);
    expect(w.at(300, 300)[0]).toBeGreaterThan(200);
    expect(w.at(300, 900)[1]).toBeGreaterThan(200);
    expect(w.at(300, 1500)[2]).toBeGreaterThan(200);
    // The fixed square is reported as a recording reports it.
    expect(top.overlays.map((v) => v.selector)).toEqual(['#sq']);
    expect(top.notes.some((n) => /^a fixed element covers the upper \w+ of the window: '#sq'; hide it with --hide '#sq'$/.test(n))).toBe(true);
    await expect(stillPage(rt, { ...base, url, out: join(dir, 'none.png'), at: '#nothing' })).rejects.toThrow(/--at: nothing on .* matches "#nothing"/);
  });

  it('gives every element of the outline its box in page pixels, the same at any --zoom, and the factor to the still', async () => {
    const url = serve('/boxes', '<!doctype html><html><body style="margin:0;height:1500px;font:16px sans-serif">'
      + '<h2 style="position:absolute;left:10px;top:900px;width:200px;height:30px;margin:0">Head</h2>'
      + '<button class="go" style="position:absolute;left:30px;top:500px;width:100px;height:40px">Go</button>'
      + '<div class="stat" style="position:absolute;left:150px;top:60px;font-size:48px;line-height:60px;width:120px;height:60px">42%</div>'
      + '<div class="note" style="position:fixed;left:20px;top:50px;width:100px;height:30px;background:#ffff00">Hi</div></body></html>');
    for (const zoom of [1, 2]) {
      const o = await outlinePage(rt, { url, width: 400, height: 300, zoom, settleMs: 100 });
      expect(o.stillScale).toBe(zoom);
      expect(o.sections).toEqual([{ y: 900, tag: 'h2', text: 'Head', selector: 'h2', box: [10, 900, 200, 30] }]);
      expect(o.targets).toEqual(expect.arrayContaining([
        { y: 500, kind: 'button', selector: 'button.go', text: 'Go', box: [30, 500, 100, 40] },
        { y: 60, kind: 'number', selector: 'div.stat', text: '42%', box: [150, 60, 120, 60] },
      ]));
      expect(o.overlays).toEqual([expect.objectContaining({ selector: 'div.note', box: [20, 50, 100, 30] })]);
    }
    // In a still of the same size, the box is the element's place in the picture: the yellow note at 20,50.
    await stillPage(rt, { url, width: 400, height: 300, settleMs: 100, out: join(dir, 'boxes.png') });
    const p = await png(join(dir, 'boxes.png'));
    expect(p.at(70, 65).slice(0, 2).every((c) => c > 200) && (p.at(70, 65)[2] ?? 255) < 80).toBe(true);
    expect(p.at(70, 40)[2]).toBeGreaterThan(200);
    expect(p.at(70, 90)[2]).toBeGreaterThan(200);
  });

  it('writes a still through the CLI', async () => {
    const url = serve('/cli-still', PAGE);
    expect((await runCli(rt, ['video', 'capture', url, '--still', 'shot.png', '--size', '320x200', '--at', '#green'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, still: 'shot.png', width: 320, height: 200, y: 576, stillScale: 1 });
  });
});
