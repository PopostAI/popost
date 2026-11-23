import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { checkProjectOnDisk } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { openRenderer, renderVideo, type Renderer } from '../../src/video/render/index';
import { checkScenes } from '../../src/video/scene/check';
import { lintScene, slotNames } from '../../src/video/scene/lint';
import { decodePng, isNear, pixelAt, projectDir } from './make-fixtures';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const page = (body: string, css: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:180px;height:320px;overflow:hidden;background:#102040}' + css + '</style></head><body>' + body + '</body></html>';

/**
 * A scene on a dark blue ground. A yellow square travels 120 px to the right in its first second. A green square
 * appears between 1.5 and 1.7 s. A magenta bar at the bottom is drawn by the scene's own render(): 90 px a second.
 */
const MOVING = page(
  '<div id="box"></div><div id="late"></div><div id="bar"></div><script>window.__popostScene = { render: function (s) { document.getElementById("bar").style.width = Math.round(s * 90) + "px"; } };</script>',
  '#box{position:absolute;left:0;top:40px;width:40px;height:40px;background:#ffff00;animation:mv 1s linear both}@keyframes mv{from{transform:translateX(0)}to{transform:translateX(120px)}}' +
  '#late{position:absolute;left:20px;top:200px;width:40px;height:40px;background:#00ff00;animation:show 0.2s linear 1.5s both}@keyframes show{from{opacity:0}to{opacity:1}}' +
  '#bar{position:absolute;left:0;top:300px;height:10px;width:0;background:#ff00ff}',
);
/** A scene that only animates for half a second and then rests; no render() of its own. */
const RESTING = page('<div id="box"></div>', '#box{position:absolute;left:0;top:40px;width:40px;height:40px;background:#ffff00;animation:mv 0.5s linear both}@keyframes mv{from{transform:translateX(0)}to{transform:translateX(120px)}}');

/** Red for 10 frames, then a scene for 60 frames, entered by a 6-frame dissolve. The scene's time starts at frame 10. */
const project = (scene: string): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [],
  segments: [
    { id: 'a', frames: 10, base: { color: '#e01010' } },
    { id: 'b', frames: 60, base: { scene }, in: { transition: 'dissolve', frames: 6 } },
  ],
  tracks: [],
});

const YELLOW = [255, 255, 0], GROUND = [16, 32, 64], GREEN = [0, 255, 0], MAGENTA = [255, 0, 255];

describe('scene bases: check', () => {
  it('takes an HTML file of the project and says what a scene may not do', async () => {
    expect(parseProject(project('scenes/s.html')).problems).toEqual([]);
    const dir = await projectDir('make-scene-check-', project('scenes/s.html'));
    try {
      const at = async (p: Project): Promise<string[]> => (await checkProjectOnDisk(rt, p, dir)).filter((x) => x.level === 'error').map((x) => x.at + ': ' + x.message);
      expect(await at(project('scenes/s.html'))).toEqual(['segments[1].base.scene: The scene "scenes/s.html" of segment "b" does not exist in ' + dir + '.']);
      expect((await at(project('../s.html')))[0]).toContain('lies outside the project directory');
      expect((await at(project('scenes/s.txt')))[0]).toContain('is not an HTML file');
      await mkdir(path.join(dir, 'scenes'));
      await writeFile(path.join(dir, 'scenes', 's.html'), MOVING);
      expect(await at(project('scenes/s.html'))).toEqual([]);
      await writeFile(path.join(dir, 'scenes', 's.html'), MOVING.replace('</body>', '<script>setTimeout(function () {}, 100)</script></body>'));
      expect((await at(project('scenes/s.html')))[0]).toContain('segments[1].base.scene: It drives something with a timer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names each rule with a fix: network, clocks, random numbers, embedded media, reaching outside', () => {
    const rules = (html: string): string[] => lintScene(page(html, ''), 'x').map((p) => p.level + ' ' + p.message.split(/[;.(]/)[0]);
    expect(rules('<img src="https://example.com/a.png">')).toEqual(['error It loads something from the network']);
    expect(rules('<div style="background:url(//cdn.example.com/a.png)"></div>')).toEqual(['error Its CSS loads something from the network ']);
    expect(rules('<video src="assets/a.mp4"></video>')).toEqual(['error It has a video, audio or embedded page']);
    expect(rules('<script>var t = Date.now(); var r = Math.random();</script>')).toEqual(['error It reads the real clock', 'error It uses random numbers, so two renders differ']);
    expect(rules('<script>requestAnimationFrame(function () {});</script>')).toEqual(['error It drives something with a timer or requestAnimationFrame']);
    expect(rules('<script>fetch("/api/edit"); top.location = "x";</script>').sort()).toEqual(['error It reaches outside its own page ', 'error It talks to the network from a script']);
    expect(rules('<div style="transition: opacity 1s"></div>')).toEqual(['warning It has a CSS transition']);
    expect(lintScene('<div>no page</div>', 'x')[0]?.message).toContain('no <body>');
    expect(lintScene(MOVING, 'x')).toEqual([]);
    expect(lintScene(MOVING, 'x').every((p) => p.fix !== '')).toBe(true);
  });
});

describe.skipIf(!ready)('scene bases: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer;
  beforeAll(async () => {
    dir = await projectDir('make-scene-', project('scenes/moving.html'));
    await mkdir(path.join(dir, 'scenes'));
    await writeFile(path.join(dir, 'scenes', 'moving.html'), MOVING);
    await writeFile(path.join(dir, 'scenes', 'resting.html'), RESTING);
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => { await renderer?.close(); await rm(dir, { recursive: true, force: true }); });

  const at = async (n: number, x: number, y: number): Promise<number[]> => pixelAt(await decodePng(await renderer.frame(n)), x, y);

  it('puts the scene on the time of its own segment: animations, a delayed one, and its own render()', async () => {
    // Frame 25 is 0.5 s into the scene: the square has travelled 60 px (it covers x 60..100).
    expect(await at(25, 80, 60), 'square at 0.5 s').toSatisfy((c: number[]) => isNear(c, YELLOW));
    expect(await at(25, 20, 60), 'where it was').toSatisfy((c: number[]) => isNear(c, GROUND));
    // Frame 40 is 1.0 s: the square rests at x 120..160; the bar is 90 px wide.
    expect(await at(40, 140, 60)).toSatisfy((c: number[]) => isNear(c, YELLOW));
    expect(await at(40, 45, 305), 'bar at 1 s').toSatisfy((c: number[]) => isNear(c, MAGENTA));
    expect(await at(40, 135, 305), 'bar not that long yet').toSatisfy((c: number[]) => isNear(c, GROUND));
    // The green square is not there at 1.0 s and is whole at 1.8 s (frame 64).
    expect(await at(40, 40, 220)).toSatisfy((c: number[]) => isNear(c, GROUND));
    expect(await at(64, 40, 220)).toSatisfy((c: number[]) => isNear(c, GREEN));
  });

  it('draws a frame the same after the frame before it, after a jump forward and after a jump back', async () => {
    for (const n of [12, 25, 33, 58, 64]) {
      await renderer.frame(n - 1);
      const played = await renderer.frame(n);
      await renderer.frame(0);
      const forward = await renderer.frame(n);
      await renderer.frame(69);
      const back = await renderer.frame(n);
      expect(played.equals(forward), 'frame ' + n + ' forward').toBe(true);
      expect(played.equals(back), 'frame ' + n + ' back').toBe(true);
    }
  });

  it('holds the scene at its first moment while the transition shows it early, mixed with the segment before', async () => {
    // The dissolve mixes frames 7..12. On frame 8 the red is still there; on frame 9 the square shows through at its first place.
    const c = await at(8, 100, 200);
    expect(c[0]).toBeGreaterThan(40);
    expect(c[0]).toBeLessThan(224);
    const early = await at(9, 20, 60);
    expect(early[1]).toBeGreaterThan(40);
    expect(await at(5, 100, 200)).toSatisfy((x: number[]) => isNear(x, [224, 16, 16]));
  });

  it('puts new content into the places a scene marks, without touching its file', async () => {
    // A title in white on the dark ground and a picture place; the project gives another title.
    const slotted = page('<h1 data-slot="title" style="margin:0;position:absolute;left:10px;top:100px;font:700 28px sans-serif;color:#fff">OLD</h1><div data-slot="note" style="display:none">n</div>', '');
    const p = { ...project('scenes/slotted.html'), segments: [{ id: 'b', frames: 20, base: { scene: 'scenes/slotted.html', slots: { title: 'MMMMMMMM' } } }] };
    const d = await projectDir('make-scene-slots-', p);
    try {
      await mkdir(path.join(d, 'scenes'));
      await writeFile(path.join(d, 'scenes', 'slotted.html'), slotted);
      expect(slotNames(slotted)).toEqual(['title', 'note']);
      expect(await checkProjectOnDisk(rt, p, d)).toEqual([]);
      const wrong = await checkProjectOnDisk(rt, { ...p, segments: [{ id: 'b', frames: 20, base: { scene: 'scenes/slotted.html', slots: { headline: 'x' } } }] }, d);
      expect(wrong[0]).toMatchObject({ level: 'error', at: 'segments[0].base.slots.headline', allowed: ['title', 'note'] });
      const r = await openRenderer(rt, d);
      try {
        const img = await decodePng(await r.frame(5));
        // "OLD" ends before x = 80; eight M at 28 px reach past x = 150. White ink out there means the new title is drawn.
        let white = 0;
        for (let x = 110; x < 175; x++) for (let y = 100; y < 135; y++) if (isNear(pixelAt(img, x, y), [255, 255, 255], 40)) white++;
        expect(white).toBeGreaterThan(40);
      } finally { await r.close(); }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('lets a scene measure its own layout when it first draws, though it waited for its segment in a layer not displayed', async () => {
    // The scene reads an element's width the first time it draws and keeps it, as a script that lays things out once
    // does. The page loads it while the red segment is on screen.
    const measuring = page('<div id="ruler"></div><div id="bar"></div><script>var w; window.__popostScene = { render: function () { if (w === undefined) w = document.getElementById("ruler").getBoundingClientRect().width; document.getElementById("bar").style.width = w + "px"; } };</script>',
      '#ruler{position:absolute;left:0;top:0;width:120px;height:4px}#bar{position:absolute;left:0;top:300px;height:10px;width:0;background:#ff00ff}');
    const d = await projectDir('make-scene-measure-', project('scenes/measuring.html'));
    try {
      await mkdir(path.join(d, 'scenes'));
      await writeFile(path.join(d, 'scenes', 'measuring.html'), measuring);
      const r = await openRenderer(rt, d);
      try {
        const img = await decodePng(await r.frame(40));
        expect(pixelAt(img, 100, 305), 'bar 120 px wide').toSatisfy((c: number[]) => isNear(c, MAGENTA));
        expect(pixelAt(img, 140, 305), 'and no wider').toSatisfy((c: number[]) => isNear(c, GROUND));
      } finally { await r.close(); }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('takes a timeline a scene hands over to its time, by either name, and rests when it is over', async () => {
    // No library: an object with pause, seek and duration, as a library's timeline has. The square travels 120 px in one second.
    const script = (how: string): string => '<script>var el = document.getElementById("box"); var paused = false; var tl = { pause: function () { paused = true; }, seek: function (s) { if (paused) el.style.transform = "translateX(" + Math.min(1, s) * 120 + "px)"; }, duration: function () { return 1; } }; ' + how + '</script>';
    const css = '#box{position:absolute;left:0;top:40px;width:40px;height:40px;background:#ffff00}';
    for (const how of ['window.__timelines = { main: tl };', 'window.__popostScene = { timeline: tl };']) {
      const d = await projectDir('make-scene-timeline-', { ...project('scenes/t.html'), segments: [{ id: 'b', frames: 60, base: { scene: 'scenes/t.html' } }] });
      try {
        await mkdir(path.join(d, 'scenes'));
        await writeFile(path.join(d, 'scenes', 't.html'), page('<div id="box"></div>' + script(how), css));
        const r = await openRenderer(rt, d);
        try {
          expect(pixelAt(await decodePng(await r.frame(15)), 80, 60), how).toSatisfy((c: number[]) => isNear(c, YELLOW));
          expect(pixelAt(await decodePng(await r.frame(45)), 140, 60), how).toSatisfy((c: number[]) => isNear(c, YELLOW));
          expect(pixelAt(await decodePng(await r.frame(3)), 100, 60), how).toSatisfy((c: number[]) => isNear(c, GROUND));
        } finally { await r.close(); }
        const v = await renderVideo(rt, { projectDir: d, out: path.join(d, 'out.mp4'), pages: 1 });
        // After its one second the timeline is over: the second half of the 60 frames is not drawn again.
        expect(v.reused).toBeGreaterThanOrEqual(25);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  it('opens a scene and says what it actually does: a script that fails, content outside the canvas, a place too small, nothing drawn', async () => {
    const one = (file: string): Project => ({ ...project(file), segments: [{ id: 'b', frames: 30, base: { scene: file } }] });
    const cases: [string, string, RegExp][] = [
      ['good.html', MOVING, /^$/],
      ['throws.html', page('<div>x</div><script>notDefinedAnywhere.go();</script>', ''), /error: The scene "scenes\/throws.html" reported an error: .*notDefinedAnywhere/],
      ['missing.html', page('<img src="nothing.png"><div>x</div>', ''), /error: .*(could not be opened|could not load|could not be loaded)/],
      ['wide.html', page('<div style="width:400px;height:20px;background:#fff"></div>', ''), /warning: The content of "scenes\/wide.html" needs 400x320 pixels; the canvas is 180x320/],
      ['tight.html', page('<div data-slot="title" style="width:40px;height:14px;overflow:hidden;white-space:nowrap;font:12px sans-serif;color:#fff">a title that is far too long for it</div>', ''), /warning: The text of the place "title" \("a title that is far too long for it"\) does not fit its box in "scenes\/tight.html": its glyphs run \d+ px past the right side of the element/],
      // Capitals on a line as tall as the font size: the font's box sticks out of the line, the glyphs do not.
      ['snug.html', page('<div data-slot="title" style="position:absolute;left:10px;top:40px;width:160px;font:700 28px sans-serif;line-height:1;color:#fff">TITLE</div><div id="box"></div>', '#box{position:absolute;left:0;top:200px;width:40px;height:40px;background:#ffff00;animation:mv 1s linear both}@keyframes mv{from{transform:translateX(0)}to{transform:translateX(120px)}}'), /^$/],
      // The title fits its own element, but the card around it is 40 px high and hides the rest.
      ['card.html', page('<div class="card" style="position:absolute;left:10px;top:40px;width:160px;height:40px;overflow:hidden;background:#fff"><div data-slot="title" style="font:700 20px sans-serif;line-height:1.4;color:#102040">one two three four five six seven</div></div>', ''), /warning: The text of the place "title" \("one two three four five six seven"\) is cut off in "scenes\/card.html": it fits its own element, but div\.card around it hides what lies outside it \(overflow\), and the glyphs run \d+ px past its bottom/],
      ['empty.html', page('', ''), /error: The scene "scenes\/empty.html" has nothing in its <body>/],
    ];
    for (const [name, html, want] of cases) {
      const d = await projectDir('make-scene-open-', one('scenes/' + name));
      try {
        await mkdir(path.join(d, 'scenes'));
        await writeFile(path.join(d, 'scenes', name), html);
        const r = await checkScenes(rt, d);
        expect(r.problems.map((p) => p.level + ': ' + p.message).join('\n'), name).toMatch(want);
        if (name === 'good.html') expect(r.shots.map((s) => s.frame)).toEqual([7, 15, 22]);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  it('does not draw a resting scene again, and always draws one that draws itself', async () => {
    // (The frames before the dissolve are red and repeat in both.)
    const resting = await projectDir('make-scene-rest-', project('scenes/resting.html'));
    try {
      await mkdir(path.join(resting, 'scenes'));
      await writeFile(path.join(resting, 'scenes', 'resting.html'), RESTING);
      // The animation ends 15 frames into the scene: about 44 of the 70 frames repeat (the red ones and the rest).
      const r = await renderVideo(rt, { projectDir: resting, out: path.join(resting, 'out.mp4'), pages: 1 });
      expect(r.frames).toBe(70);
      expect(r.reused).toBeGreaterThanOrEqual(40);
      expect(r.reused).toBeLessThanOrEqual(52);
      const moving = await renderVideo(rt, { projectDir: dir, out: path.join(dir, 'out.mp4'), pages: 1 });
      // Only the red frames before the dissolve repeat: the scene has a render() of its own.
      expect(moving.reused).toBeLessThanOrEqual(8);
    } finally {
      await rm(resting, { recursive: true, force: true });
    }
  });
});
