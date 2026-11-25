import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverProcesses } from './make-fixtures';
import { createDiskRuntime } from '../../src/testing/disk';
import { MOTION_PRESETS, type Project } from '../../src/video/types';
import { hasFfmpeg } from '../../src/video/media/ffmpeg';
import type { EditOp } from '../../src/video/preview/edit/ops';
import { HISTORY_LIMIT } from '../../src/video/preview/edit/editor';
import { MAX_BODY } from '../../src/video/preview/edit/routes';
import { startPreview, type PreviewServer } from '../../src/video/preview/index';
import type { EditAnswer, PreviewState, RenderInfo } from '../../src/video/preview/protocol';
import { findChromium } from '../../src/render/browser';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);
const chrome = findChromium(process.env) ?? undefined;

/** 40 frames: red (0..19), blue (20..39) after a 6-frame fade; a title on 0..29 of a, a bar on 5..14. */
const project = (): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [],
  segments: [
    { id: 'a', frames: 20, base: { color: '#e01010' } },
    { id: 'b', frames: 20, base: { color: '#1030e0' }, in: { transition: 'fade', frames: 6 } },
  ],
  tracks: [
    { id: 'title', type: 'text', text: 'Hello', box: [0.1, 0.2, 0.8, 0.1], during: { segment: 'a', from: 0, to: 30 }, style: { size: 0.05, color: '#ffffff' }, enter: { preset: 'fade', frames: 4 } },
    { id: 'bar', type: 'shape', shape: 'rect', color: '#ffd000', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'a', from: 5, to: 15 } },
  ],
});

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }

/** A raw request on a fresh connection (no pooled socket outlives a closed server). */
const call = (url: string, method: string, pathname: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: pathname, method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });

const post = async (url: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; answer: EditAnswer }> => {
  const r = await call(url, 'POST', pathname, body === undefined ? undefined : JSON.stringify(body), headers);
  return { status: r.status, answer: JSON.parse(r.body.toString('utf8')) as EditAnswer };
};

const editOp = (url: string, op: EditOp | Record<string, unknown>, headers: Record<string, string> = {}) => post(url, '/api/edit', op, headers);

const state = async (url: string): Promise<PreviewState> => JSON.parse((await call(url, 'GET', '/api/state')).body.toString('utf8')) as PreviewState;

const readProject = async (dir: string): Promise<Project> => JSON.parse(await readFile(path.join(dir, 'video.json'), 'utf8')) as Project;

/** Every file under dir with a hash of its content, so a test can tell exactly what was written. */
const snapshot = async (dir: string, rel = ''): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.join(rel, e.name);
    if (e.isDirectory()) Object.assign(out, await snapshot(dir, name));
    else out[name] = createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex').slice(0, 16) + ':' + (await stat(path.join(dir, name))).mtimeMs;
  }
  return out;
};

/** Opens /api/events, runs trigger once it is open, and resolves with the data of the first event named name that passes. */
const nextEvent = (url: string, name: string, trigger: () => Promise<unknown>, pass: (data: string) => boolean = () => true, timeoutMs = 10_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no "' + name + '" event within ' + timeoutMs + ' ms')); }, timeoutMs);
    const req = request({ host: u.hostname, port: u.port, path: '/api/events', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (const m of text.matchAll(new RegExp('event: ' + name + '\\ndata: (.*)\\n\\n', 'g'))) {
          if (!pass(m[1] ?? '')) continue;
          clearTimeout(timer);
          req.destroy();
          return resolve(m[1] ?? '');
        }
      });
      trigger().catch(reject);
    });
    req.on('error', () => undefined);
    req.end();
  });

describe('preview server in edit mode', () => {
  let root = '';
  let dir = '';
  let original = '';
  let preview: PreviewServer | undefined;
  const url = (): string => preview?.url ?? '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'preview-edit-'));
    dir = path.join(root, 'project');
    await mkdir(dir);
    original = JSON.stringify(project(), null, 2) + '\n';
    await writeFile(path.join(dir, 'video.json'), original);
    preview = await startPreview(rt, { projectDir: dir, edit: true });
  });
  afterAll(async () => {
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('applies every operation kind, writes it to video.json and answers with the new state', async () => {
    const set = await editOp(url(), { op: 'set', path: ['tracks', 0, 'box'], value: [0.2, 0.3, 0.6, 0.1] });
    expect(set.status).toBe(200);
    if (!set.answer.ok) throw new Error(JSON.stringify(set.answer));
    expect([set.answer.op, set.answer.label]).toEqual(['set', 'title.box']);
    expect(set.answer.state.resolved?.items.find((i) => i.id === 'title')?.box).toEqual([0.2, 0.3, 0.6, 0.1]);
    expect((await readProject(dir)).tracks[0]).toMatchObject({ box: [0.2, 0.3, 0.6, 0.1] });

    expect((await editOp(url(), { op: 'set', path: 'tracks[0].text', value: 'Second line' })).status).toBe(200);
    expect((await readProject(dir)).tracks[0]).toMatchObject({ text: 'Second line' });

    const extra = { id: 'note1', type: 'text', text: 'Added', box: [0.1, 0.5, 0.8, 0.1], during: { segment: 'b' } };
    const inserted = await editOp(url(), { op: 'insert', path: ['tracks', 2], value: extra });
    expect([inserted.status, inserted.answer.ok && inserted.answer.label]).toEqual([200, 'note1']);
    expect((await readProject(dir)).tracks.map((t) => t.id)).toEqual(['title', 'bar', 'note1']);

    expect((await editOp(url(), { op: 'move', path: ['tracks', 2], to: 0 })).status).toBe(200);
    expect((await readProject(dir)).tracks.map((t) => t.id)).toEqual(['note1', 'title', 'bar']);

    expect((await editOp(url(), { op: 'remove', path: ['tracks', 1, 'enter'] })).status).toBe(200);
    expect((await readProject(dir)).tracks[1]).not.toHaveProperty('enter');
    const removed = await editOp(url(), { op: 'remove', path: ['tracks', 0] });
    expect([removed.status, removed.answer.ok && removed.answer.label]).toEqual([200, 'note1']);
    expect((await readProject(dir)).tracks.map((t) => t.id)).toEqual(['title', 'bar']);

    expect((await editOp(url(), { op: 'set', path: ['segments', 0, 'frames'], value: 26 })).status).toBe(200);
    expect((await state(url())).resolved?.frames).toBe(46);
    // The file keeps its indentation and its final newline.
    expect(await readFile(path.join(dir, 'video.json'), 'utf8')).toMatch(/^\{\n {2}"version": 1,[\s\S]*\}\n$/);
  });

  it('keeps the session\'s first video.json as video.json.bak, written once', async () => {
    expect(await readFile(path.join(dir, 'video.json.bak'), 'utf8')).toBe(original);
    expect((await editOp(url(), { op: 'set', path: ['tracks', 0, 'text'], value: 'Third' })).status).toBe(200);
    expect(await readFile(path.join(dir, 'video.json.bak'), 'utf8')).toBe(original);
    expect((await state(url())).edit?.backup).toBe(true);
  });

  it('writes nothing when check finds an error, and answers with the problems', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    const schemaError = await editOp(url(), { op: 'set', path: ['tracks', 0, 'box', 2], value: 0 });
    expect(schemaError.status).toBe(422);
    if (schemaError.answer.ok) throw new Error('should be refused');
    expect(schemaError.answer.problems.find((p) => p.level === 'error')?.at).toBe('tracks[0].box[2]');
    const checkError = await editOp(url(), { op: 'set', path: ['tracks', 0, 'during', 'segment'], value: 'nowhere' });
    expect(checkError.status).toBe(422);
    if (checkError.answer.ok) throw new Error('should be refused');
    const p = checkError.answer.problems.find((x) => x.level === 'error');
    expect([p?.at, Boolean(p?.message), Boolean(p?.fix)]).toEqual(['tracks[0].during.segment', true, true]);
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
  });

  it('refuses a path that leaves the shape of video.json, and writes nothing', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    const unknown = await editOp(url(), { op: 'set', path: ['tracks', 1, 'colour'], value: '#fff' });
    expect(unknown.status).toBe(400);
    if (unknown.answer.ok) throw new Error('should be refused');
    expect(unknown.answer.problems[0]?.message).toMatch(/Unknown field "colour".*leaves the shape/);
    expect(unknown.answer.problems[0]?.fix).toMatch(/color/);
    for (const op of [
      { op: 'set', path: ['tracks', 9, 'box'], value: [0, 0, 1, 1] },
      { op: 'set', path: ['canvas', 'width', 'x'], value: 1 },
      { op: 'insert', path: ['canvas', 'fps'], value: 1 },
      { op: 'set', path: ['constructor', 'prototype'], value: 1 },
      { op: 'patch', path: ['note'], value: 1 },
    ]) {
      const r = await editOp(url(), op);
      expect(r.status, JSON.stringify(op)).toBe(400);
      expect(r.answer.ok).toBe(false);
    }
    expect((await call(url(), 'POST', '/api/edit', '{not json')).status).toBe(400);
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
  });

  it('undoes and redoes more than 50 steps, and says when there is nothing to undo', async () => {
    const start = await readFile(path.join(dir, 'video.json'), 'utf8');
    const steps = 55;
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(50);
    for (let i = 1; i <= steps; i++) expect((await editOp(url(), { op: 'set', path: ['tracks', 0, 'text'], value: 'Step ' + i })).status).toBe(200);
    for (let i = steps - 1; i >= 1; i--) {
      const r = await post(url(), '/api/undo');
      expect([r.status, r.answer.ok && r.answer.op]).toEqual([200, 'undo']);
      expect((await readProject(dir)).tracks[0]).toMatchObject({ text: 'Step ' + i });
    }
    expect((await post(url(), '/api/undo')).status).toBe(200);
    expect(await readFile(path.join(dir, 'video.json'), 'utf8')).toBe(start);
    const redo = await post(url(), '/api/redo');
    expect([redo.status, redo.answer.ok && redo.answer.op]).toEqual([200, 'redo']);
    expect((await readProject(dir)).tracks[0]).toMatchObject({ text: 'Step 1' });
    expect((await state(url())).edit).toMatchObject({ redo: steps - 1 });
    const fresh = await startPreview(rt, { projectDir: dir, edit: true });
    try {
      const nothing = await post(fresh.url, '/api/undo');
      expect([nothing.status, nothing.answer.ok]).toEqual([409, false]);
      expect((await post(fresh.url, '/api/redo')).status).toBe(409);
    } finally {
      await fresh.close();
    }
  });

  it('takes an edit made outside as the new state and clears redo', async () => {
    expect((await editOp(url(), { op: 'set', path: ['tracks', 0, 'text'], value: 'Mine' })).status).toBe(200);
    expect((await post(url(), '/api/undo')).status).toBe(200);
    expect((await state(url())).edit?.redo).toBe(1);
    const outside = { ...(await readProject(dir)), note: 'edited in another editor' };
    await nextEvent(url(), 'reload', () => writeFile(path.join(dir, 'video.json'), JSON.stringify(outside, null, 2) + '\n'));
    const s = await state(url());
    expect(s.edit?.redo).toBe(0);
    expect((s.source as Project).note).toBe('edited in another editor');
    expect((await editOp(url(), { op: 'set', path: ['tracks', 0, 'text'], value: 'On top' })).status).toBe(200);
    expect(await readProject(dir)).toMatchObject({ note: 'edited in another editor', tracks: [{ text: 'On top' }, {}] });
    // Undo takes back the page's edit, then the outside one.
    await post(url(), '/api/undo');
    expect((await readProject(dir)).note).toBe('edited in another editor');
    await post(url(), '/api/undo');
    expect((await readProject(dir)).note).toBeUndefined();
  });

  it('gives the page the schema of what it edits', async () => {
    const r = await call(url(), 'GET', '/api/schema');
    expect(r.status).toBe(200);
    const schemas = JSON.parse(r.body.toString('utf8')) as { motion: { properties: { preset: { enum: string[] }; frames: { maximum: number } } } };
    expect(schemas.motion.properties.preset.enum).toEqual([...MOTION_PRESETS]);
    expect(schemas.motion.properties.frames.maximum).toBe(600);
  });
});

describe('edit mode safety', () => {
  let root = '';
  let dir = '';
  let preview: PreviewServer | undefined;
  let readOnly: PreviewServer | undefined;
  const url = (): string => preview?.url ?? '';
  const ok = { op: 'set', path: ['tracks', 0, 'text'], value: 'Safe' };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'preview-edit-safety-'));
    dir = path.join(root, 'project');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    await writeFile(path.join(dir, 'assets', 'keep.txt'), 'not touched');
    preview = await startPreview(rt, { projectDir: dir, edit: true });
    readOnly = await startPreview(rt, { projectDir: dir });
  });
  afterAll(async () => {
    await preview?.close();
    await readOnly?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('is offered on the loopback address only', async () => {
    await expect(startPreview(rt, { projectDir: dir, edit: true, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    expect(url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('refuses every POST without --edit', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    for (const p of ['/api/edit', '/api/undo', '/api/redo', '/api/render', '/api/studio/draft', '/api/studio/draft-open']) {
      const r = await call(readOnly?.url ?? '', 'POST', p, JSON.stringify(ok));
      expect(r.status, p).toBe(405);
    }
    expect((await call(readOnly?.url ?? '', 'GET', '/api/schema')).status).toBe(404);
    expect((await state(readOnly?.url ?? '')).edit).toBeUndefined();
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
  });

  it('refuses a POST from another origin or another site, and one with another Host', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    const foreign: Record<string, string>[] = [{ origin: 'http://attacker.example' }, { origin: 'null' }, { origin: url().replace(/\/$/, '').replace('127.0.0.1', '127.0.0.2') }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of foreign) {
      const r = await editOp(url(), ok, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(url(), '/api/undo', undefined, { origin: 'http://attacker.example' })).status).toBe(403);
    expect((await call(url(), 'POST', '/api/edit', JSON.stringify(ok), { host: 'attacker.example:80' })).status).toBe(403);
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
    const same = await editOp(url(), ok, { origin: url().replace(/\/$/, ''), 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(200);
  });

  it('refuses a body over 1 MB', async () => {
    const before = await readFile(path.join(dir, 'video.json'));
    const big = JSON.stringify({ op: 'set', path: ['note'], value: 'x'.repeat(MAX_BODY) });
    const r = await call(url(), 'POST', '/api/edit', big);
    expect(r.status).toBe(413);
    expect((await readFile(path.join(dir, 'video.json'))).equals(before)).toBe(true);
  });

  it('writes nothing in the project directory but video.json and video.json.bak', async () => {
    const before = await snapshot(dir);
    await editOp(url(), { op: 'set', path: ['tracks', 1, 'box'], value: [0.2, 0.6, 0.6, 0.05] });
    await editOp(url(), { op: 'insert', path: ['tracks', 2], value: { id: 'x', type: 'text', text: 'X', box: [0, 0, 1, 0.1], during: { segment: 'b' } } });
    await editOp(url(), { op: 'set', path: ['tracks', 0, 'box', 2], value: -1 });
    await editOp(url(), { op: 'set', path: ['materials'], value: [{ id: 'm', kind: 'image', file: '../outside.png' }] });
    await editOp(url(), { op: 'move', path: ['tracks', 2], to: 0 });
    await post(url(), '/api/undo');
    await post(url(), '/api/redo');
    await editOp(url(), { op: 'remove', path: ['tracks', 0] });
    const after = await snapshot(dir);
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).sort();
    expect(changed).toContain('video.json');
    expect(changed.filter((k) => k !== 'video.json' && k !== 'video.json.bak')).toEqual([]);
    expect(Object.keys(after).sort()).toEqual([...new Set([...Object.keys(before), 'video.json.bak'])].sort());
    expect(await readdir(root)).toEqual(['project']);
  });
});

describe.skipIf(!chrome || !ffmpeg)('render from the page', () => {
  let root = '';
  let dir = '';
  let preview: PreviewServer | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'preview-render-'));
    dir = path.join(root, 'project');
    await mkdir(dir);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    preview = await startPreview(rt, { projectDir: dir, edit: true });
  });
  afterAll(async () => {
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('renders out.mp4 once at a time, with progress and the result as events', async () => {
    const url = preview?.url ?? '';
    let second = 0;
    const done = await nextEvent(url, 'render', async () => {
      const first = await call(url, 'POST', '/api/render');
      expect(first.status).toBe(202);
      second = (await call(url, 'POST', '/api/render')).status;
    }, (data) => (JSON.parse(data) as RenderInfo).state !== 'running', 120_000);
    expect(second).toBe(409);
    const info = JSON.parse(done) as RenderInfo;
    if (info.state !== 'done') throw new Error('render did not finish: ' + done);
    expect([info.frames, info.file]).toEqual([40, path.join(dir, 'out.mp4')]);
    expect(info.seconds).toBeGreaterThan(0);
    expect((await state(url)).edit?.render).toMatchObject({ state: 'done', frames: 40 });
    const video = await call(url, 'GET', info.url, undefined, { range: 'bytes=0-99' });
    expect([video.status, video.headers['content-type']]).toEqual([206, 'video/mp4']);
    expect((await readdir(dir)).sort()).toEqual(['out.mp4', 'video.json']);
  });
});
