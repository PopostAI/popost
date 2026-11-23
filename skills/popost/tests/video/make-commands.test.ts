/**
 * The making commands through the CLI: what each prints, its exit code, and the paths shown as they were typed. The
 * engine behind each has its own tests (make-render, make-capture, make-scene, preview-server); these check the
 * command around it. Frames need Chrome and ffmpeg; without them those tests skip.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import type { Project } from '../../src/video/types';
import { serverProcesses } from './make-fixtures';

let rt: DiskRuntime;
beforeAll(async () => { rt = await createDiskRuntime(); });
afterAll(async () => { await rt.cleanup(); });
const probe = await createDiskRuntime();
const ready = (await hasFfmpeg(probe)) && hasChrome();
await probe.cleanup();

/** 40 frames at 180x320: red, then dark blue entered by a 6-frame fade; a yellow bar on frames 5..14. */
const PROJECT: Project = {
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [],
  segments: [
    { id: 'a', frames: 20, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { color: '#102040' }, in: { transition: 'fade', frames: 6 } },
  ],
  tracks: [{ id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'a', from: 5, to: 15 } }],
};

/** A project directory under the runtime's working directory, so the commands can be given a relative path. */
const project = async (name: string, p: Project, files: Record<string, string> = {}): Promise<string> => {
  const dir = path.join(rt.dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'video.json'), JSON.stringify(p, null, 2));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return name;
};

describe('video check', () => {
  it('prints the counts and the problems; a project with an error exits with code 2 and names the path as typed', async () => {
    const dir = await project('checked', PROJECT);
    const ok = await runCli(rt, ['video', 'check', dir]);
    expect(ok.code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, frames: 40, segments: 2, errors: 0, problems: [] });
    expect(typeof rt.json().items).toBe('number');

    const broken = await project('broken', { ...PROJECT, materials: [{ id: 'pic', kind: 'image', file: 'assets/none.png' }], segments: [{ id: 'a', frames: 10, base: { material: 'pic' } }] });
    expect((await runCli(rt, ['video', 'check', broken])).code).toBe(2);
    const report = rt.json() as { ok: boolean; errors: number; problems: { level: string; message: string }[] };
    expect(report.ok).toBe(false);
    expect(report.errors).toBeGreaterThan(0);
    expect(report.problems.some((p) => p.level === 'error' && p.message.includes('none.png'))).toBe(true);

    expect((await runCli(rt, ['video', 'check', 'nowhere'])).code).toBe(2);
    expect(JSON.stringify(rt.json().problems)).toContain('nowhere');
    expect(JSON.stringify(rt.json().problems)).not.toContain(rt.dir);
  });
});

describe('video preview', () => {
  it('refuses where the host cannot serve pages', async () => {
    expect((await runCli(rt, ['video', 'preview', await project('no-server', PROJECT)])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
    expect(String(rt.json().error)).toMatch(/server/i);
  });

  it('prints where it listens, serves until the host stops it, then exits with code 0', async () => {
    const stop = new AbortController();
    const host = await createDiskRuntime({ processes: serverProcesses, signal: stop.signal });
    try {
      await mkdir(path.join(host.dir, 'live'));
      await writeFile(path.join(host.dir, 'live', 'video.json'), JSON.stringify(PROJECT));
      const running = runCli(host, ['video', 'preview', 'live', '--port', '0', '--edit']);
      for (let i = 0; i < 200 && !host.out.length; i++) await new Promise((r) => setTimeout(r, 25));
      const printed = host.json() as { ok: boolean; url: string; project: string; mode: string; note: string };
      expect(printed).toMatchObject({ ok: true, project: 'live', mode: 'edit' });
      expect(printed.note).toContain('video.json.bak');
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(printed.url);
        request({ host: u.hostname, port: u.port, path: '/api/state', agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
      });
      expect(status).toBe(200);
      stop.abort();
      expect((await running).code).toBe(0);
    } finally {
      await host.cleanup();
    }
  });
});

describe('video scene write: without a model', () => {
  it('says which variables to set, before it reads anything', async () => {
    expect((await runCli(rt, ['video', 'scene', 'write', 'anywhere', '--reference', 'ref.mp4', '--brief', 'x'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('POPOST_LLM_URL');
  });
});

describe.skipIf(!ready)('making commands that draw (Chrome + ffmpeg)', () => {
  it('check --layout opens the page too', async () => {
    expect((await runCli(rt, ['video', 'check', await project('layout', PROJECT), '--layout'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, frames: 40 });
  });

  it('frame writes one PNG and prints its size; a frame the video does not have exits with code 2', async () => {
    const dir = await project('framed', PROJECT);
    expect((await runCli(rt, ['video', 'frame', dir, '--frame', '3', '--out', 'f3.png', '--scale', '0.5'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, out: 'f3.png', frame: 3, width: 90, height: 160 });
    expect(existsSync(path.join(rt.dir, 'f3.png'))).toBe(true);
    expect((await runCli(rt, ['video', 'frame', dir, '--frame', '99', '--out', 'f99.png'])).code).toBe(2);
    expect(String(rt.json().error)).toMatch(/outside the video, which has frames 0\.\.39/);
  });

  it('render writes the MP4 and keeps every fact the old line had', async () => {
    expect((await runCli(rt, ['video', 'render', await project('rendered', PROJECT), '--out', 'out.mp4', '--pages', '1'])).code).toBe(0);
    const r = rt.json();
    expect(r).toMatchObject({ ok: true, out: 'out.mp4', frames: 40, width: 180, height: 320, fps: 30, pages: 1 });
    for (const key of ['seconds', 'msPerFrame', 'reused']) expect(typeof r[key]).toBe('number');
    expect(existsSync(path.join(rt.dir, 'out.mp4'))).toBe(true);
  });

  it('render prints a project\'s problems with exit code 2', async () => {
    const dir = await project('unrendered', { ...PROJECT, segments: [] });
    expect((await runCli(rt, ['video', 'render', dir, '--out', 'never.mp4'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
    expect((rt.json().problems as unknown[]).length).toBeGreaterThan(0);
  });

  it('capture lists a page\'s headings, records it by a plan, and refuses what it cannot record', async () => {
    const tall = '<!doctype html><html><head><title>Tall</title><style>body{margin:0;font:16px sans-serif}section{height:700px}</style></head><body>'
      + '<section><h1>First</h1></section><section><h2>Second</h2></section><section><h2>Third</h2></section></body></html>';
    await writeFile(path.join(rt.dir, 'tall.html'), tall);
    const url = pathToFileURL(path.join(rt.dir, 'tall.html')).href;
    expect((await runCli(rt, ['video', 'capture', url, '--outline', '--size', '320x240'])).code).toBe(0);
    const o = rt.json() as { ok: boolean; title: string; pageHeight: number; maxScroll: number; sections: { text: string }[] };
    expect(o).toMatchObject({ ok: true, title: 'Tall', width: 320, height: 240 });
    expect(o.maxScroll).toBe(o.pageHeight - 240);
    expect(o.sections.map((s) => s.text)).toEqual(['First', 'Second', 'Third']);

    await writeFile(path.join(rt.dir, 'plan.json'), JSON.stringify([{ hold: 2 }, { scroll: { to: 700, frames: 3 } }]));
    expect((await runCli(rt, ['video', 'capture', url, '--out', 'page.mp4', '--size', '320x240', '--fps', '10', '--plan', 'plan.json'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, out: 'page.mp4', frames: 5, width: 320, height: 240, fps: 10, notes: [] });
    expect(existsSync(path.join(rt.dir, 'page.mp4'))).toBe(true);

    expect((await runCli(rt, ['video', 'capture', url])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--out');
    expect((await runCli(rt, ['video', 'capture', url, '--out', 'x.mp4', '--size', 'big'])).code).toBe(2);
    expect((await runCli(rt, ['video', 'capture', 'ftp://x', '--out', 'x.mp4'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('url must start with');
  });

  const SCENE = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#102040}'
    + '#t{position:absolute;left:20px;top:60px;font:700 24px sans-serif;color:#fff;animation:in 0.5s both}@keyframes in{from{opacity:0}to{opacity:1}}</style></head>'
    + '<body><div id="t" data-slot="title">A new title</div></body></html>';
  const SCENE_PROJECT: Project = { version: 1, canvas: { width: 320, height: 180, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'a', frames: 30, base: { scene: 'scenes/shot-01.html' } }] };

  it('check --layout, scene check and render name the picture a scene could not load, at that scene\'s segment, with code 2', async () => {
    const broken = SCENE.replace('</body>', '<img src="../assets/logo.png"></body>');
    const slotted = SCENE.replace('</body>', '<img data-slot="logo" src="../assets/logo.png"></body>');
    const p: Project = { ...SCENE_PROJECT, segments: [
      { id: 'a', frames: 30, base: { scene: 'scenes/shot-01.html' } },
      { id: 'b', frames: 30, base: { scene: 'scenes/broken.html' } },
      { id: 'c', frames: 30, base: { scene: 'scenes/slotted.html', slots: { logo: 'assets/logo.png' } } },
    ] };
    const dir = await project('unloaded', p, { 'scenes/shot-01.html': SCENE, 'scenes/broken.html': broken, 'scenes/slotted.html': slotted });
    await mkdir(path.join(rt.dir, dir, 'assets'));
    // The picture the slot names is in assets/, but the slot's path was written from the project, not from the scene.
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', path.join(rt.dir, dir, 'assets', 'logo-real.png')]);
    p.segments[2] = { id: 'c', frames: 30, base: { scene: 'scenes/slotted.html', slots: { logo: 'assets/logo-real.png' } } };
    await writeFile(path.join(rt.dir, dir, 'video.json'), JSON.stringify(p));
    type Report = { ok: boolean; problems: { level: string; at: string; message: string; fix: string }[] };
    const expectNamed = (r: Report): void => {
      expect(r.ok).toBe(false);
      expect(r.problems.map((x) => x.at)).toEqual(['segments[1].base.scene', 'segments[2].base.slots.logo']);
      const [scene, slot] = r.problems;
      expect(scene?.message).toContain('The picture "../assets/logo.png" of the scene "scenes/broken.html" (segment "b") could not be loaded');
      expect(scene?.message).toContain('relative to the scene file (the folder scenes/), so it leads to "assets/logo.png" in the project, and there is no such file');
      expect(slot?.message).toContain('"assets/logo-real.png" that segment "c" gives the place "logo"');
      expect(slot?.fix).toContain('Write "../assets/logo-real.png"');
    };
    expect((await runCli(rt, ['video', 'check', dir, '--layout'])).code).toBe(2);
    expectNamed(rt.json() as Report);
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(2);
    expectNamed(rt.json() as Report);
    expect((await runCli(rt, ['video', 'render', dir, '--out', 'never.mp4'])).code).toBe(2);
    expectNamed(rt.json() as Report);
  });

  it('scene check opens every scene and keeps three frames of each under the directory typed', async () => {
    const dir = await project('scened', SCENE_PROJECT, { 'scenes/shot-01.html': SCENE });
    expect((await runCli(rt, ['video', 'scene', 'check', dir, '--shots', 'shots'])).code).toBe(0);
    const r = rt.json() as { ok: boolean; opened: number; shots: string[]; scenes: { pictures?: string[]; fill?: number }[] };
    expect(r).toMatchObject({ ok: true, opened: 1, errors: 0 });
    expect(r.shots).toHaveLength(3);
    for (const s of r.shots) {
      expect(s).toMatch(/^shots[\\/]segment-01-f\d+\.png$/);
      expect(existsSync(path.join(rt.dir, s))).toBe(true);
    }
    // Per scene: where it is, its three pictures (the files a warning names) and how much of its middle stands out.
    expect(r.scenes).toMatchObject([{ at: 'segments[0]', id: 'a', scene: 'scenes/shot-01.html', seconds: 1, frames: [7, 15, 22] }]);
    expect(r.scenes[0]?.pictures).toEqual(r.shots);
    expect(r.scenes[0]?.fill).toBeGreaterThan(0.01);
  });

  it('scene write has the configured model write the scene, and prints neither the key nor the address', async () => {
    const asked: { auth: string | null; body: string }[] = [];
    const writer = await createDiskRuntime({
      env: { POPOST_LLM_URL: 'http://model.test/v1', POPOST_LLM_MODEL: 'scene-model', POPOST_LLM_KEY: 'test-key-not-real' },
      fetchHandler: async (req) => {
        asked.push({ auth: req.headers.get('authorization'), body: await req.text() });
        return Response.json({ choices: [{ message: { content: 'Here it is.\n```html\n' + SCENE + '\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      },
    });
    try {
      await mkdir(path.join(writer.dir, 'proj'));
      await writeFile(path.join(writer.dir, 'proj', 'video.json'), JSON.stringify(SCENE_PROJECT));
      await writeFile(path.join(writer.dir, 'brief.txt'), 'Our new feature, in one line');
      await runFfmpegOk(writer, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1', '-pix_fmt', 'yuv420p', path.join(writer.dir, 'ref.mp4')]);
      const r = await runCli(writer, ['video', 'scene', 'write', 'proj', '--reference', 'ref.mp4', '--brief', 'brief.txt', '--rounds', '0']);
      expect(r.code).toBe(0);
      const printed = writer.json() as { ok: boolean; model: string; scenes: { segment: number; file: string; passed: boolean; answers: number; steps: { kind: string; inputTokens: number }[] }[] };
      expect(printed).toMatchObject({ ok: true, model: 'scene-model', problems: [] });
      expect(printed.scenes).toMatchObject([{ segment: 1, file: 'scenes/shot-01.html', passed: true, answers: 1, steps: [{ kind: 'write', inputTokens: 10, outputTokens: 5 }] }]);
      expect(asked[0]?.auth).toBe('Bearer test-key-not-real');
      expect(asked[0]?.body).toContain('Our new feature, in one line');
      expect(r.stderr).toContain('segment 1');
      for (const text of [r.stdout, r.stderr]) {
        expect(text).not.toContain('test-key-not-real');
        expect(text).not.toContain('model.test');
      }
      expect(existsSync(path.join(writer.dir, 'proj', 'scenes', 'shot-01.html'))).toBe(true);
    } finally {
      await writer.cleanup();
    }
  });
});
