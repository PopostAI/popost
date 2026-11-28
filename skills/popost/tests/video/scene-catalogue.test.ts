/**
 * The effects catalogue (assets/video/examples/catalogue.json, written by tools/video/port-hyperframes.mjs): every
 * entry has its file, passes the scene lint, declares parameters the Skill can set and sound cues with known names;
 * a ported entry names its source and its licence. In the renderer a sample of entries, each loaded as the scene of
 * a later shot (in a layer that is not displayed), draws the same picture for the same frame whichever order the
 * frames come in, and its picture changes over the shot; their cues come out in the video's time. Needs Chrome for
 * the second half; skipped without it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { PACKAGE_ROOT, runCli } from '../../src/testing/memory';
import { CUE_NAMES } from '../../src/video/page/contract';
import { openSession } from '../../src/video/render/session';
import { checkScenes } from '../../src/video/scene/check';
import { readCues, writtenCues } from '../../src/video/scene/cues';
import { EXAMPLES, librariesOf, readCatalogue, readExample, searchCatalogue, setExample } from '../../src/video/scene/examples';
import { addLibrary, LIBRARIES } from '../../src/video/scene/library';
import { lintScene } from '../../src/video/scene/lint';

const rt = await createDiskRuntime();
afterAll(() => rt.cleanup());
const catalogue = await readCatalogue(rt);
const at = (...p: string[]): string => path.join(rt.dir, ...p);
/** three.js is not a library of the Skill yet. */
const three = false as boolean;

describe('the effects catalogue', () => {
  it('lists every example with its file, class, libraries, parameters and cues', async () => {
    expect(catalogue.entries.length).toBeGreaterThan(300);
    expect(new Set(catalogue.entries.map((e) => e.name)).size).toBe(catalogue.entries.length);
    for (const name of EXAMPLES) expect(catalogue.entries.map((e) => e.name)).toContain(name);
    const page = await readFile(path.join(PACKAGE_ROOT, 'references/video-effects.md'), 'utf8');
    for (const e of catalogue.entries) {
      expect(e.about.length, e.name).toBeGreaterThan(10);
      expect(e.seconds, e.name).toBeGreaterThan(0);
      for (const l of e.libraries) expect(Object.keys(LIBRARIES), e.name).toContain(l);
      for (const c of e.cues) {
        expect(CUE_NAMES as readonly string[], e.name).toContain(c.cue);
        expect(c.at, e.name).toBeGreaterThanOrEqual(0);
        expect(c.gain, e.name).toBeGreaterThan(0);
        expect(c.gain, e.name).toBeLessThanOrEqual(1);
      }
      expect(page, e.name).toContain('`' + e.name + '`');
    }
    // What was not ported is listed with its reason, and the source says how many of each.
    expect(catalogue.source?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(catalogue.source?.found).toBe((catalogue.source?.ported ?? 0) + (catalogue.source?.skipped ?? 0));
    expect(catalogue.skipped?.every((s) => s.reason.length > 10 && s.source.startsWith('hyperframes:'))).toBe(true);
  });

  it('every entry is a scene the Skill can read, set and lint clean; a ported one names its source and licence', async () => {
    const dirty: string[] = [];
    for (const e of catalogue.entries) {
      const ex = await readExample(rt, e.name);
      expect(ex.params.map((p) => p.name), e.name).toEqual(e.params);
      const set = setExample(ex, [], [1080, 1920]);
      expect(set.problems, e.name).toEqual([]);
      expect(set.html, e.name).toContain('width: 1080px; height: 1920px;');
      const problems = lintScene(set.html, e.name);
      if (problems.length) dirty.push(e.name + ': ' + problems[0]?.message);
      expect(librariesOf(set.html).sort(), e.name).toEqual([...e.libraries].sort());
      if (e.source) {
        expect(ex.html, e.name).toContain('Adapted from HyperFrames (https://github.com/heygen-com/hyperframes), registry/' + e.source.replace('hyperframes:', ''));
        expect(ex.html, e.name).toContain('Copyright 2026 HeyGen, Inc. Licensed under the Apache License, Version 2.0');
        expect(writtenCues(ex.html), e.name).toEqual(e.cues);
      }
    }
    expect(dirty).toEqual([]);
  });

  it('finds entries by words, the best first, and by class', () => {
    expect(searchCatalogue(catalogue, 'bounce ball')[0]?.name).toBe('bouncing-ball');
    expect(searchCatalogue(catalogue, 'confetti').map((e) => e.name)).toEqual(expect.arrayContaining(['confetti', 'particle-burst']));
    expect(searchCatalogue(catalogue, 'caption glitch').every((e) => /caption/.test(e.name + e.class + e.about) && /glitch/.test(e.name + e.about + (e.tags ?? []).join(' ') + e.cues.map((c) => c.cue).join(' ')))).toBe(true);
    expect(searchCatalogue(catalogue, 'zzzz-nothing')).toEqual([]);
    expect(searchCatalogue(catalogue, '')).toHaveLength(catalogue.entries.length);
  });

  it('the command searches the catalogue and writes an entry with its libraries named', async () => {
    expect((await runCli(rt, ['video', 'scene', 'example', '--search', 'bounce ball', '--limit', '3'])).code).toBe(0);
    const found = rt.json() as { total: number; found: { name: string; cues: string[]; libraries: string[] }[] };
    expect(found.found[0]).toMatchObject({ name: 'bouncing-ball', libraries: ['motion'] });
    expect(found.found[0]?.cues.filter((c) => c.startsWith('impact@'))).toHaveLength(4);
    expect((await runCli(rt, ['video', 'scene', 'example', 'bouncing-ball', '--set', 'bounces=2', '--set', 'hold=2', '--size', '720x1280', '--out', 'ball.html'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, example: 'bouncing-ball', values: { bounces: 2, hold: 2, restitution: 0.6 }, libraries: ['popost video scene library <project> --name motion'] });
    expect(await readFile(at('ball.html'), 'utf8')).toContain('"values": {"bounces":2,"hold":2}');
    expect((await runCli(rt, ['video', 'scene', 'example', 'bouncing-ball', '--set', 'restitution=2'])).code).toBe(2);
    expect((await runCli(rt, ['video', 'scene', 'example'])).code).toBe(0);
    expect((rt.json() as { catalogue: { entries: number } }).catalogue.entries).toBe(catalogue.entries.length);
  });

  it('the lint lets a scene draw with WebGL from render(seconds) and still refuses an animation loop', () => {
    const page = (script: string): string => '<!doctype html><html><head><style>html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }</style></head><body><canvas id="gl"></canvas><script src="../lib/three.min.js"></script><script>' + script + '</script></body></html>';
    const drawn = "var r = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), preserveDrawingBuffer: true }); var gl = r.getContext('webgl2'); window.__popostScene = { render: function (s) { mesh.rotation.y = s; mesh.parent.position.x = s; r.render(scene, camera); } };";
    expect(lintScene(page(drawn), 'gl')).toEqual([]);
    expect(lintScene(page(drawn + ' r.setAnimationLoop(function () {}); function loop() { requestAnimationFrame(loop); } loop();'), 'gl').map((p) => p.level)).toEqual(['error']);
    expect(lintScene(page('var clock = performance.now();'), 'gl')[0]?.message).toContain('reads the real clock');
    // A property called parent or top is not the page around the scene; the window's is.
    expect(lintScene(page('var a = ctl.parent.anchor, b = rect.top.toFixed(1);'), 'gl')).toEqual([]);
    expect(lintScene(page('var a = parent.document;'), 'gl')[0]?.message).toContain('reaches outside its own page');
    expect(lintScene(page('window.top.location.href = "x";'), 'gl')).toHaveLength(1);
  });
});

/** Entries drawn in the renderer: the helper's, a ported timeline, a ported caption, and lit 3D when three is installed. */
const SAMPLE = ['bouncing-ball', 'slam-title', 'particle-burst', 'pen-draw', 'shape-morph', 'glitch-title', 'badge-pop', 'caption-kinetic-slam', ...(three ? ['three-chrome-knot', 'three-extruded-shape'] : [])];

describe.skipIf(!hasChrome())('catalogue entries in the renderer', () => {
  it('a sample loads as scenes of later shots, moves, and draws the same frame the same way in any order', async () => {
    const dir = at('sample');
    await mkdir(path.join(dir, 'scenes'), { recursive: true });
    const libs = new Set<string>();
    for (const name of SAMPLE) {
      const html = setExample(await readExample(rt, name), [], [640, 360]).html;
      librariesOf(html).forEach((l) => libs.add(l));
      await writeFile(path.join(dir, 'scenes', name + '.html'), html);
    }
    for (const l of libs) await addLibrary(rt, dir, l);
    // A colour shot first: every scene loads in a layer that is not displayed, as the scenes of a real video do.
    await writeFile(path.join(dir, 'video.json'), JSON.stringify({
      version: 1, canvas: { width: 640, height: 360, fps: 30 }, materials: [], tracks: [],
      segments: [{ id: 'lead', frames: 30, base: { color: '#000000' } }, ...SAMPLE.map((name) => ({ id: name, frames: 75, base: { scene: 'scenes/' + name + '.html' } }))],
    }));
    const session = await openSession(rt, dir, { reuse: false });
    try {
      for (const [k, name] of SAMPLE.entries()) {
        const start = 30 + k * 75, frames = [4, 14, 30, 60].map((f) => start + f);
        const first: Buffer[] = [];
        for (const f of frames) first.push(await session.frame(f));
        const again: Buffer[] = [];
        for (const f of [...frames].reverse()) again.unshift(await session.frame(f));
        expect(first.map((x, i) => x.equals(again[i] as Buffer)), name + ': the same frame drawn again').toEqual(frames.map(() => true));
        expect(new Set(first.map((x) => x.toString('base64'))).size, name + ': its picture changes over the shot').toBeGreaterThan(1);
      }
      expect(session.errors()).toEqual([]);
    } finally { await session.close(); }

    // The cues of every scene, in the video's time: the ball's landings are impacts after its shot's start.
    const read = await readCues(rt, dir);
    expect(read.from).toBe('page');
    expect(read.scenes.map((s) => s.segment)).toEqual(SAMPLE);
    const ball = read.cues.filter((c) => c.segment === 'bouncing-ball');
    expect(ball.filter((c) => c.cue === 'impact' && c.effect === 'bounce')).toHaveLength(4);
    expect(ball[0]).toMatchObject({ at: 1.677, frame: 50, local: 0.677, cue: 'impact', gain: 1, scene: 'scenes/bouncing-ball.html' });
    expect(read.cues.filter((c) => c.segment === 'slam-title').map((c) => c.cue)).toEqual(['whoosh', 'impact']);
    // A ported entry's cues are data in its file, read the same way.
    expect(read.cues.filter((c) => c.segment === 'badge-pop').map((c) => c.cue)).toEqual(expect.arrayContaining(['pop']));
    expect(read.cues.map((c) => c.at)).toEqual([...read.cues.map((c) => c.at)].sort((a, b) => a - b));

    expect((await runCli(rt, ['video', 'scene', 'cues', 'sample'])).code).toBe(0);
    const out = rt.json() as { ok: boolean; total: number; kinds: Record<string, number>; cues: unknown[] };
    expect(out).toMatchObject({ ok: true, from: 'page', total: read.cues.length });
    expect(out.kinds.impact).toBeGreaterThanOrEqual(5);

    // scene check passes every one of them and counts their cues.
    const checked = await checkScenes(rt, dir);
    expect(checked.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(checked.scenes.find((s) => s.id === 'bouncing-ball')?.cues).toBe(4);
  }, 600_000);

  it('puts the motion helper and three.js into a project as the unchanged files', async () => {
    await mkdir(at('libs'), { recursive: true });
    expect((await runCli(rt, ['video', 'scene', 'library', 'libs', '--name', 'motion'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, library: 'motion', file: 'libs/lib/popost-motion.js', tag: '<script src="../lib/popost-motion.js"></script>' });
    expect((await readFile(at('libs/lib/popost-motion.js'))).equals(await readFile(path.join(PACKAGE_ROOT, 'assets/video/motion.js')))).toBe(true);
    if (!three) return;
    expect((await runCli(rt, ['video', 'scene', 'library', 'libs', '--name', 'three'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, library: 'three', version: '0.147.0', file: 'libs/lib/three.min.js' });
    expect((await readFile(at('libs/lib/three.min.js'), 'utf8')).slice(0, 120)).toContain('SPDX-License-Identifier: MIT');
  });
});
