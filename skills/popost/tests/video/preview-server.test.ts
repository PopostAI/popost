import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverProcesses } from './make-fixtures';
import { createDiskRuntime } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { buildPage } from '../../src/video/compile/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { parseRange } from '../../src/video/preview/files';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import type { PreviewState } from '../../src/video/preview/protocol';
import { truthMeasure } from '../../src/video/synth/truth';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);
const scorerExists = existsSync(path.join(import.meta.dirname, '..', '..', 'src', 'video', 'score', 'index.ts'));

/** 40 frames: red (0..19), a 6-frame fade into a picture (20..39); a bar on frames 5..14. */
const project = (first = 20): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'pic', kind: 'image', file: 'assets/pic one.png' }],
  segments: [
    { id: 'a', frames: first, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { material: 'pic' }, in: { transition: 'fade', frames: 6 } },
  ],
  tracks: [{ id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'a', from: 5, to: 15 }, enter: { preset: 'fade', frames: 4 } }],
});

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }

/**
 * A raw request on a fresh connection: fetch() would normalise "/project/../x" to "/x" before sending it, and a pooled
 * keep-alive socket would outlive a server the test has closed.
 */
const get = (url: string, pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

const state = async (url: string): Promise<PreviewState> => JSON.parse((await get(url, '/api/state')).body.toString('utf8')) as PreviewState;

/** Opens /api/events, runs trigger once the stream is open, and resolves with the data of the first event named name. */
const nextEvent = (url: string, name: string, trigger: () => Promise<void>, timeoutMs = 5000): Promise<string> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no "' + name + '" event within ' + timeoutMs + ' ms')); }, timeoutMs);
    const req = request({ host: u.hostname, port: u.port, path: '/api/events', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('end', () => {
        clearTimeout(timer);
        reject(new Error('the event stream ended before a "' + name + '" event'));
      });
      res.on('data', (chunk: string) => {
        text += chunk;
        const m = text.match(new RegExp('event: ' + name + '\\ndata: (.*)\\n\\n'));
        if (!m) return;
        clearTimeout(timer);
        req.destroy();
        resolve(m[1] ?? '');
      });
      trigger().catch(reject);
    });
    req.on('error', () => undefined);
    req.end();
  });

describe('preview server', () => {
  let root = '';
  let dir = '';
  let preview: PreviewServer | undefined;
  const url = (): string => preview?.url ?? '';
  const picture = Buffer.from('a stand-in for picture bytes: the server does not decode them');

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'preview-server-'));
    dir = path.join(root, 'project');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'assets', 'pic one.png'), picture);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    await writeFile(path.join(root, 'secret.txt'), 'SECRET-BYTES');
    await symlink(path.join(root, 'secret.txt'), path.join(dir, 'assets', 'link.txt'));
    preview = await startPreview(rt, { projectDir: dir, port: 0 });
  });
  afterAll(async () => {
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves the shell, the state with the resolved timeline, and the page with the runtime', async () => {
    expect(url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const shell = await get(url(), '/');
    expect(shell.status).toBe(200);
    expect(shell.body.toString()).toContain('<div id="app"></div><script>');
    const s = await state(url());
    expect(s.resolved?.frames).toBe(40);
    expect(s.resolved?.segments.map((x) => x.id)).toEqual(['a', 'b']);
    expect(s.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect([s.measure, s.referenceMeasure, s.score, s.notes, s.reference]).toEqual([null, null, null, null, null]);
    const page = await get(url(), '/page');
    expect(page.status).toBe(200);
    const html = page.body.toString();
    expect(html).toContain('id="popost-data"');
    expect(html).toContain('__popostVideo');
    expect(html).toContain('project/assets/pic%20one.png');
    const pic = await get(url(), '/project/assets/pic%20one.png');
    expect([pic.status, pic.headers['content-type']]).toEqual([200, 'image/png']);
    expect(pic.body.equals(picture)).toBe(true);
  });

  it('refuses paths outside the project directory and anything but GET and HEAD', async () => {
    for (const p of ['/project/../secret.txt', '/project/..%2fsecret.txt', '/project/assets/../../secret.txt', '/project/assets/link.txt']) {
      const r = await get(url(), p);
      expect(r.status, p).toBe(403);
      expect(r.body.toString(), p).not.toContain('SECRET-BYTES');
    }
    expect((await get(url(), '/project/assets/missing.png')).status).toBe(404);
    expect((await get(url(), '/', {}, 'POST')).status).toBe(405);
    expect((await get(url(), '/api/state', { host: 'attacker.example:80' })).status).toBe(403);
    expect((await get(url(), '/reference')).status).toBe(404);
  });

  it('reads a byte range like a video element asks for it', () => {
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-64', 1000)).toEqual({ start: 936, end: 999 });
    expect(parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeUndefined();
    expect(parseRange(undefined, 1000)).toBeUndefined();
  });

  it.skipIf(!ffmpeg)('answers a Range request on /reference with 206 and the right bytes', async () => {
    const video = path.join(root, 'reference.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const bytes = await readFile(video);
    const withReference = await startPreview(rt, { projectDir: dir, reference: video });
    try {
      const part = await get(withReference.url, '/reference', { range: 'bytes=100-1123' });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 100-1123/' + bytes.length);
      expect(part.headers['content-type']).toBe('video/mp4');
      expect(part.body.equals(bytes.subarray(100, 1124))).toBe(true);
      const tail = await get(withReference.url, '/reference', { range: 'bytes=-64' });
      expect([tail.status, tail.body.equals(bytes.subarray(bytes.length - 64))]).toEqual([206, true]);
      expect((await get(withReference.url, '/reference', { range: 'bytes=' + bytes.length + '-' })).status).toBe(416);
      const whole = await get(withReference.url, '/reference');
      expect([whole.status, whole.headers['accept-ranges'], whole.body.equals(bytes)]).toEqual([200, 'bytes', true]);
      const head = await get(withReference.url, '/reference', {}, 'HEAD');
      expect([head.status, head.headers['content-length'], head.body.length]).toEqual([200, String(bytes.length), 0]);
      expect((await state(withReference.url)).reference).toEqual({ name: 'reference.mp4' });
    } finally {
      await withReference.close();
    }
  });

  it('lists the problems of a project with errors and sends a page that names them', async () => {
    const bad = path.join(root, 'bad');
    await mkdir(bad);
    await writeFile(path.join(bad, 'video.json'), JSON.stringify({ ...project(), segments: [{ id: 'a', base: { color: '#000' } }], tracks: [], materials: [] }));
    const server = await startPreview(rt, { projectDir: bad });
    try {
      const s = await state(server.url);
      expect(s.resolved).toBeNull();
      const p = s.problems.find((x) => x.at === 'segments[0].frames');
      expect(p?.level).toBe('error');
      const page = await get(server.url, '/page');
      expect(page.status).toBe(422);
      const html = page.body.toString();
      expect(html).toContain('segments[0].frames');
      expect(html).toContain((p?.fix ?? 'no fix').replace(/"/g, '&quot;'));
      expect(html).not.toContain('__popostVideo');
    } finally {
      await server.close();
    }
  });

  it('sends "reload" when video.json or a measurement changes, and the state follows', async () => {
    const before = await state(url());
    const data = await nextEvent(url(), 'reload', () => writeFile(path.join(dir, 'video.json'), JSON.stringify(project(30), null, 2)));
    expect((JSON.parse(data) as { generation: number }).generation).toBeGreaterThan(before.generation);
    const after = await state(url());
    expect(after.resolved?.frames).toBe(50);
    expect(after.generation).toBeGreaterThan(before.generation);
    const resolved = (await buildPage(rt, dir)).resolved;
    if (!resolved) throw new Error('the test project should resolve');
    await nextEvent(url(), 'reload', () => writeFile(path.join(dir, 'measure.json'), JSON.stringify(truthMeasure(resolved))));
    expect((await state(url())).measure?.file).toBe(path.join(dir, 'measure.json'));
  });

  it('still sees video.json after an editor replaced it by a rename', async () => {
    const temp = path.join(dir, '.video.json.tmp');
    await writeFile(temp, JSON.stringify(project(25), null, 2));
    await nextEvent(url(), 'reload', () => rename(temp, path.join(dir, 'video.json')));
    expect((await state(url())).resolved?.frames).toBe(45);
    // Written in place after the rename: Node's recursive watcher alone no longer reports this file.
    await nextEvent(url(), 'reload', () => writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2)));
    expect((await state(url())).resolved?.frames).toBe(40);
  });

  it('loads both measurements and the draft notes, and scores them when the scorer exists', async () => {
    const built = await buildPage(rt, dir);
    if (!built.resolved) throw new Error('the test project should resolve');
    const truth = truthMeasure(built.resolved);
    const outside = path.join(root, 'render.json');
    await writeFile(outside, JSON.stringify(truth));
    await writeFile(path.join(dir, 'reference.measure.json'), JSON.stringify(truth));
    await writeFile(path.join(dir, 'draft-notes.json'), JSON.stringify([{ at: 'segments[1].in', kind: 'inferred', message: 'low confidence' }]));
    const server = await startPreview(rt, { projectDir: dir, measure: outside });
    try {
      const s = await state(server.url);
      expect(s.measure?.file).toBe(outside);
      expect(s.referenceMeasure?.file).toBe(path.join(dir, 'reference.measure.json'));
      expect(s.referenceMeasure?.measure.boundaries).toEqual(truth.boundaries);
      expect(s.notes).toEqual([{ at: 'segments[1].in', kind: 'inferred', message: 'low confidence' }]);
      if (scorerExists) expect(s.score?.composite, s.messages.join(' ')).toBeTypeOf('number');
      else expect([s.score, s.messages.join(' ')]).toEqual([null, 'No score: src/score/index.ts does not exist yet.']);
      await writeFile(path.join(dir, 'reference.measure.json'), JSON.stringify({ version: 1 }));
      await nextEvent(server.url, 'reload', () => writeFile(path.join(dir, 'draft-notes.json'), '[]'));
      const broken = await state(server.url);
      expect(broken.referenceMeasure).toBeNull();
      expect(broken.messages.join(' ')).toContain('is not a measurement');
    } finally {
      await server.close();
      await rm(path.join(dir, 'reference.measure.json'), { force: true });
    }
  });

  it('refuses to start without a project directory, and frees its port on close', async () => {
    await expect(startPreview(rt, { projectDir: path.join(root, 'nowhere') })).rejects.toThrow(/does not exist or is not a directory/);
    await expect(startPreview(rt, { projectDir: dir, reference: path.join(root, 'none.mp4') })).rejects.toThrow(/reference video/);
    const server = await startPreview(rt, { projectDir: dir });
    const events = nextEvent(server.url, 'never', async () => undefined, 3000);
    await new Promise((r) => setTimeout(r, 100));
    await server.close();
    await expect(events).rejects.toThrow(/event stream ended/);
    await expect(get(server.url, '/')).rejects.toThrow(/ECONNREFUSED/);
  });
});
