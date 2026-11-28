/**
 * The example scenes with declared parameters (assets/video/examples): each declares its parameters with a range and
 * what they do, keeps the rules of a scene, takes values that are checked against the declaration, and is drawn from the
 * time alone. With Chrome and ffmpeg: every example passes scene check and moves, a sheet of frames is drawn without a
 * project, and the object-led reveal, rendered with a path set by its parameters, reads back as that path.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { renderVideo } from '../../src/video/render/index';
import { checkScenes } from '../../src/video/scene/check';
import { EXAMPLES, readExample, setExample } from '../../src/video/scene/examples';
import { lintScene } from '../../src/video/scene/lint';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);

describe('example scenes with parameters', () => {
  it('each declares its parameters: a type, a default inside its range or among its options, and what it does', async () => {
    for (const name of EXAMPLES) {
      const ex = await readExample(rt, name);
      expect(ex.about.length, name).toBeGreaterThan(20);
      expect(ex.params.map((p) => p.name), name).toEqual(expect.arrayContaining(['duration', 'delay', 'ease']));
      for (const p of ex.params) {
        expect(p.what.length, name + '.' + p.name).toBeGreaterThan(8);
        if (p.type === 'number') expect(Number(p.default) >= Number(p.min) && Number(p.default) <= Number(p.max) && typeof p.unit === 'string', name + '.' + p.name).toBe(true);
        else if (p.type === 'choice') expect(p.options, name + '.' + p.name).toContain(p.default);
        else expect(p.type, name + '.' + p.name).toBe('colour');
      }
    }
    expect((await readExample(rt, 'object-reveal')).params.map((p) => p.name)).toEqual(expect.arrayContaining(['startX', 'startY', 'endX', 'endY', 'objectSize', 'edge', 'spread', 'travel']));
    await expect(readExample(rt, 'no-such-effect')).rejects.toThrow('There is no example scene named "no-such-effect". Known: object-reveal, card-flip, folding-doors, streak-wipe');
  });

  it('each keeps the rules of a scene: no clock of its own, no randomness, nothing from the network, drawn shapes only', async () => {
    for (const name of EXAMPLES) {
      const { html } = await readExample(rt, name);
      expect(lintScene(html, name), name).toEqual([]);
      expect(html, name).toContain('window.__popostScene = { render: function (seconds)');
      // No picture file: the only src is a transparent pixel written out in the page.
      expect([...html.matchAll(/src="([^"]*)"/g)].every((m) => (m[1] ?? '').startsWith('data:image/gif;base64,')), name).toBe(true);
    }
  });

  it('takes values that fit the declaration, writes them and the canvas size into the copy, and names every value that does not fit', async () => {
    const ex = await readExample(rt, 'object-reveal');
    const set = setExample(ex, ['spread=60', 'edge=circle', 'objectColor=#ffffff', 'startY=0.25'], [1080, 1920]);
    expect(set.problems).toEqual([]);
    expect(set.values).toMatchObject({ spread: 60, edge: 'circle', objectColor: '#ffffff', startY: 0.25, object: 'plane', duration: 1.8 });
    expect(set.html).toContain('"values": {"spread":60,"edge":"circle","objectColor":"#ffffff","startY":0.25}');
    expect(set.html).toContain('width: 1080px; height: 1920px;');
    expect(set.html).not.toContain('width: 1280px; height: 720px;');
    // Without values the copy is the example itself.
    expect(setExample(ex, []).html).toBe(ex.html);
    const bad = setExample(ex, ['spread=400', 'shape=plane', 'edge=star', 'objectColor=red', 'travel']);
    expect(bad.problems.map((p) => p.at)).toEqual(['set.spread', 'set.shape', 'set.edge', 'set.objectColor', 'set.travel']);
    expect(bad.problems[0]?.message).toContain('"spread" is a number from 5 to 170 (degrees)');
    expect(bad.problems[2]?.allowed).toEqual(['wedge', 'straight', 'circle']);
    // A choice of numbers is written as a number.
    expect(setExample(await readExample(rt, 'folding-doors'), ['panels=6']).values.panels).toBe(6);
  });

  it('the command lists the examples with their parameters, and refuses a value outside its range', async () => {
    expect((await runCli(rt, ['video', 'scene', 'example'])).code).toBe(0);
    const listed = rt.json() as { examples: { name: string; params: { name: string }[] }[] };
    expect(listed.examples.map((e) => e.name)).toEqual([...EXAMPLES]);
    expect(listed.examples.every((e) => e.params.length >= 8)).toBe(true);
    expect((await runCli(rt, ['video', 'scene', 'example', 'card-flip', '--set', 'depth=99'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, errors: 1, problems: [{ at: 'set.depth' }] });
    expect((await runCli(rt, ['video', 'scene', 'example', 'card-flip', '--set', 'toward=left', '--out', 'project/scenes/flip.html'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, example: 'card-flip', file: 'project/scenes/flip.html', values: { toward: 'left', axis: 'vertical' } });
    expect((await stat(at('project/scenes/flip.html'))).size).toBeGreaterThan(2000);
  });
});

describe.skipIf(!ready)('example scenes in the renderer', () => {
  it('every example passes scene check, and its picture changes over the shot', async () => {
    await mkdir(at('all/scenes'), { recursive: true });
    for (const name of EXAMPLES) await writeFile(at('all/scenes', name + '.html'), setExample(await readExample(rt, name), ['delay=0.3', 'duration=1.2'], [640, 360]).html);
    await writeFile(at('all/video.json'), JSON.stringify({
      version: 1, canvas: { width: 640, height: 360, fps: 30 }, materials: [],
      segments: EXAMPLES.map((name) => ({ id: name, frames: 60, base: { scene: 'scenes/' + name + '.html' } })), tracks: [],
    }));
    const first = await checkScenes(rt, at('all'));
    expect(first.problems.filter((p) => p.level === 'error')).toEqual([]);
    for (const k of EXAMPLES.keys()) {
      const mine = first.shots.filter((s) => s.k === k);
      expect(mine).toHaveLength(3);
      expect(mine[0]?.png.equals(mine[2]?.png ?? Buffer.alloc(0)), EXAMPLES[k]).toBe(false);
    }
    // Drawn from the time alone: the same frames again are the same bytes.
    const again = await checkScenes(rt, at('all'));
    expect(again.shots.map((s) => s.png.equals(first.shots.find((x) => x.k === s.k && x.frame === s.frame)?.png ?? Buffer.alloc(0)))).toEqual(first.shots.map(() => true));
  }, 240_000);

  it('a sheet of frames is drawn without a project', async () => {
    const r = await runCli(rt, ['video', 'scene', 'example', 'streak-wipe', '--set', 'angle=-30', '--size', '640x360', '--sheet', 'look/streak.jpg', '--frames', '6']);
    expect(r.code, r.stdout).toBe(0);
    const out = rt.json() as { sheet: string; seconds: number[]; grid: number[] };
    expect(out.seconds).toHaveLength(6);
    expect(out.seconds[0]).toBe(0);
    expect((await stat(at('look/streak.jpg'))).size).toBeGreaterThan(3000);
  }, 240_000);

  it('the object-led reveal, set to a path, reads back as that path: its angle, the size of the object, the edge', async () => {
    // From the lower left to the upper right: 1280 x 720 at these fractions is a path of about -16 degrees.
    const ex = await readExample(rt, 'object-reveal');
    const set = setExample(ex, ['startX=-0.08', 'startY=0.72', 'endX=1.08', 'endY=0.3', 'objectSize=0.3', 'spread=40', 'travel=1.2', 'duration=1.6', 'delay=0.2'], [640, 360]);
    await mkdir(at('one/scenes'), { recursive: true });
    await writeFile(at('one/scenes/reveal.html'), set.html);
    await writeFile(at('one/video.json'), JSON.stringify({ version: 1, canvas: { width: 640, height: 360, fps: 30 }, materials: [], segments: [{ id: 'reveal', frames: 75, base: { scene: 'scenes/reveal.html' } }], tracks: [] }));
    await renderVideo(rt, { projectDir: at('one'), out: at('one.mp4') });
    const track = (await measureVideo(rt, at('one.mp4'))).tracks?.find((t) => t.of === 'transition');
    const expected = (Math.atan2((0.3 - 0.72) * 360, (1.08 + 0.08) * 640) * 180) / Math.PI;
    expect(track).toMatchObject({ what: 'object', method: 'reveal-front' });
    expect(Math.abs((track?.path.angle ?? 99) - expected)).toBeLessThan(6);
    expect(track?.reveal?.edge.shape).toBe('wedge');
    expect(Math.abs((track?.reveal?.edge.spread ?? 0) - 40)).toBeLessThan(12);
    // The object's breadth across its path is 0.3 of the height; on a slanted path its box is a little larger.
    expect(track?.size[1]).toBeGreaterThan(0.25);
    expect(track?.size[1]).toBeLessThan(0.45);
  }, 240_000);
});
