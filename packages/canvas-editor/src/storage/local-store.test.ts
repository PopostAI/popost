import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../contracts';
import { HttpError, createLocalStore } from './local-store';
import type { LocalStoreOptions } from './local-store';

const ORIGIN = 'http://127.0.0.1:9';
const boot = { projectId: 'proj', width: 1080, height: 1350, name: 'Brief' };

const pageHtml = (name: string): string =>
  `<!doctype html><html><head></head><body style="margin:0"><div class="slide" data-popost-page="p1" data-popost-width="1080" data-popost-height="1350" data-popost-name="${name}" style="width:1080px;height:1350px;position:relative;overflow:hidden"><p>hi</p></div></body></html>`;

const manifest = (rev = 1): { pages: Array<Record<string, unknown>> } => ({
  pages: [{ id: 'p1', name: 'One', width: 1080, height: 1350, role: 'cover', htmlPath: 'pages/p1.html', html: pageHtml('One') + `<!-- ${rev} -->` }],
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
  cache?: RequestCache;
}

function server(handlers: Record<string, (call: Call) => Response | Promise<Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, cache: init?.cache };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.url}`];
    return handler ? handler(call) : json({ ok: false, error: 'not found' }, 404);
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function make(handlers: Parameters<typeof server>[0], extra: LocalStoreOptions = {}): { store: ReturnType<typeof createLocalStore>; calls: Call[] } {
  const s = server(handlers);
  return { store: createLocalStore(boot, { fetch: s.fetch, origin: ORIGIN, ...extra }), calls: s.calls };
}

const base: Parameters<typeof server>[0] = {
  'GET /api/project': () => json({ ok: true, manifest: manifest(), canvasRev: 'rev1' }),
  'GET /api/canvas-initial': () => json({ ok: true, manifest: manifest(0), createdAt: '2026-01-01T00:00:00Z' }),
};

describe('local store', () => {
  it('load: reads project, ensures the initial snapshot, compiles; rev = canvasRev', async () => {
    const { store, calls } = make(base);
    const doc = await store.load();
    expect(doc.rev).toBe('rev1');
    expect(doc.path).toBe('pages/proj.html');
    expect(doc.name).toBe('Brief');
    expect(doc.content).toContain('data-popost-page="p1"');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/project', 'GET /api/canvas-initial']);
    expect(calls.every((c) => c.cache === 'no-store')).toBe(true);
  });

  it('initial: compiles canvas-initial', async () => {
    const { store } = make(base);
    const initial = await store.initial();
    expect(initial).toMatchObject({ available: true, reliable: true, source: 'local-open', createdAt: '2026-01-01T00:00:00Z' });
    expect(initial.content).toContain('data-popost-page="p1"');
  });

  it('save: splits, POSTs pages with canvasRev and force, reloads the project, returns the new rev', async () => {
    let projectRev = 'rev1';
    const { store, calls } = make({
      ...base,
      'GET /api/project': () => json({ ok: true, manifest: manifest(), canvasRev: projectRev }),
      'POST /api/project': () => {
        projectRev = 'rev2';
        return json({ ok: true, canvasRev: 'rev2', saved: [], revision: 2 });
      },
    });
    const { content } = await store.load();
    const saved = await store.save(content, { rev: 'rev1' });
    expect(saved).toEqual({ rev: 'rev2' });
    const post = calls.find((c) => c.method === 'POST')!;
    const body = post.body as { pages: Array<{ id: string; name: string; role: string; width: number }>; canvasRev: string; force: boolean };
    expect(body.canvasRev).toBe('rev1');
    expect(body.force).toBe(false);
    expect(body.pages[0]).toMatchObject({ id: 'p1', name: 'One', role: 'cover', width: 1080 });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', url: '/api/project' });
    await store.save(content, { rev: 'rev2', force: true });
    expect((calls.filter((c) => c.method === 'POST').at(-1)!.body as { force: boolean }).force).toBe(true);
  });

  it('save: 409 becomes ConflictError, other failures keep status and message', async () => {
    let status = 409;
    const { store } = make({ ...base, 'POST /api/project': () => json({ ok: false, error: '工程已被修改' }, status) });
    const { content } = await store.load();
    await expect(store.save(content, { rev: 'old' })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.save(content, { rev: 'old' })).rejects.toThrow('工程已被修改');
    status = 400;
    await expect(store.save(content, { rev: 'old' })).rejects.toMatchObject({ status: 400, message: '工程已被修改' });
    await expect(store.save(content, { rev: 'old' })).rejects.toBeInstanceOf(HttpError);
  });

  it('treats ok:false in a 200 reply as an error and falls back to HTTP status text', async () => {
    const { store } = make({ 'GET /api/project': () => json({ ok: false, error: 'bad' }) });
    await expect(store.load()).rejects.toThrow('bad');
    const { store: other } = make({ 'GET /api/project': () => new Response('{}', { status: 500 }) });
    await expect(other.load()).rejects.toThrow('HTTP 500');
  });

  it('preview posts content and nonce and returns the url', async () => {
    const { store, calls } = make({ 'POST /api/canvas-preview': () => json({ ok: true, url: '/_preview/u.html' }) });
    expect(await store.preview('<html></html>', 'a'.repeat(32))).toBe('/_preview/u.html');
    expect(calls[0]!.body).toEqual({ content: '<html></html>', nonce: 'a'.repeat(32) });
  });

  it('fonts: palette, install with resourceOnly and canvasRev, css texts', async () => {
    const { store, calls } = make({
      'GET /api/font-palette': () => json({ ok: true, roles: [{ id: 'inter', family: 'Inter Variable', label: 'Inter', group: 'Sans', fallback: 'sans-serif' }] }),
      'POST /api/font-install': () => json({ ok: true, installed: {}, canvasRev: 'rev9' }),
      'GET /css/inter.css': () => new Response('@font-face{}'),
      'GET /css/cjk-sans.css': () => new Response('@font-face{cjk}'),
    });
    expect((await store.fontPalette()).roles[0]!.id).toBe('inter');
    const result = await store.fontCSS(['inter', 'cjk-sans'], { rev: 'rev1' });
    expect(result).toEqual({ css: { inter: '@font-face{}', 'cjk-sans': '@font-face{cjk}' }, rev: 'rev9' });
    expect(calls.find((c) => c.url === '/api/font-install')!.body).toEqual({ roles: 'inter,cjk-sans', resourceOnly: true, canvasRev: 'rev1' });
  });

  it('downloadAll: forced save, then export zip saved as popost-images.zip', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob);
      return 'blob:zip';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const { store, calls } = make({
      ...base,
      'POST /api/project': () => json({ ok: true, canvasRev: 'rev5' }),
      'GET /api/export?page=all': () => new Response('ZIPDATA', { headers: { 'Content-Type': 'application/zip' } }),
    });
    const { content } = await store.load();
    expect(await store.downloadAll(content, { rev: 'rev1' })).toEqual({ rev: 'rev5' });
    const order = calls.map((c) => `${c.method} ${c.url}`);
    expect(order.indexOf('POST /api/project')).toBeLessThan(order.indexOf('GET /api/export?page=all'));
    expect((calls.find((c) => c.method === 'POST')!.body as { force: boolean }).force).toBe(true);
    expect(names).toEqual(['popost-images.zip']);
    expect(await created[0]!.text()).toBe('ZIPDATA');
    click.mockRestore();
  });

  it('downloadAll surfaces the server error of the export', async () => {
    const { store } = make({
      ...base,
      'POST /api/project': () => json({ ok: true, canvasRev: 'r' }),
      'GET /api/export?page=all': () => json({ error: 'render failed' }, 500),
    });
    const { content } = await store.load();
    await expect(store.downloadAll(content, { rev: 'rev1' })).rejects.toThrow('render failed');
  });
});

describe('local store cloud adapter', () => {
  const status = (extra: Record<string, unknown> = {}) => ({ ok: true, mode: 'anonymous', state: 'idle', dirty: true, ...extra });

  it('has none unless the boot object offers cloud save', () => {
    expect(createLocalStore(boot, { origin: ORIGIN }).cloud).toBeUndefined();
    expect(createLocalStore({ ...boot, cloud: { mode: 'keyed' } }, { origin: ORIGIN }).cloud?.mode).toBe('keyed');
  });

  it('status, start and push call the local routes with the documented bodies', async () => {
    const s = server({
      'GET /api/cloud/status': () => json(status()),
      'POST /api/cloud/start': () => json({ ok: true, authorizeUrl: 'https://popost.ai/en/workspace/cloud-save?v=1', expiresAt: '2026-11-14T12:10:00Z' }),
      'POST /api/cloud/push': () => json(status({ state: 'saved', dirty: false })),
    });
    const cloud = createLocalStore({ ...boot, cloud: { mode: 'anonymous' } }, { fetch: s.fetch, origin: ORIGIN }).cloud!;
    expect(await cloud.status()).toMatchObject({ state: 'idle', dirty: true });
    expect(await cloud.start('zh')).toEqual({ authorizeUrl: 'https://popost.ai/en/workspace/cloud-save?v=1', expiresAt: '2026-11-14T12:10:00Z' });
    expect(await cloud.push({ force: true, lang: 'en' })).toMatchObject({ state: 'saved' });
    await cloud.push();
    expect(s.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/cloud/status', undefined],
      ['POST', '/api/cloud/start', { lang: 'zh' }],
      ['POST', '/api/cloud/push', { force: true, lang: 'en' }],
      ['POST', '/api/cloud/push', { force: false }],
    ]);
    expect(s.calls.every((c) => c.cache === 'no-store')).toBe(true);
  });

  it('a push that needs a login resolves with the status body instead of throwing; a refused start throws', async () => {
    const s = server({
      'POST /api/cloud/push': () => json(status({ ok: false, error: { code: 'LOGIN_REQUIRED', message: 'log in' } }), 409),
      'POST /api/cloud/start': () => json({ ok: false, error: 'a popost key is configured' }, 409),
    });
    const cloud = createLocalStore({ ...boot, cloud: { mode: 'anonymous' } }, { fetch: s.fetch, origin: ORIGIN }).cloud!;
    expect(await cloud.push()).toMatchObject({ ok: false, error: { code: 'LOGIN_REQUIRED' } });
    await expect(cloud.start('en')).rejects.toMatchObject({ status: 409, message: 'a popost key is configured' });
  });
});
