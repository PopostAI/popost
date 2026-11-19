/** Cloud save in the local editor service: routes, login flow, status phases and the background pushes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { challengeOf, SECRET_PATTERN } from '../src/cloud/auth-flow';
import { cloudEditor, settled, type CloudEditor } from './cloud-helpers';
import { bodyJson, bodyText, get, post, PORT } from './editor-helpers';
import { err, KEY, type Json } from './image-helpers';
import { Project } from '../src/core/project';

afterEach(() => {
  vi.useRealTimers();
});

const status = async (e: CloudEditor): Promise<Json> => bodyJson(await get(e.rt, e.state, '/api/cloud/status'));
const syncCalls = (e: CloudEditor) => e.stub.calls('POST', '/projects/sync');
const projectId = (e: CloudEditor) => e.project.manifest.projectId;

/** Save through the route, like the editor does. */
const save = async (e: CloudEditor, html: string) => {
  const { canvasRev } = bodyJson(await get(e.rt, e.state, '/api/project')) as { canvasRev: string };
  return post(e.rt, e.state, '/api/project', { pages: [{ id: 'p1', name: 'P1', width: 300, height: 400, html }], canvasRev });
};

const CODE = 'C'.repeat(43);

/** Start a login, then play the site: register the credential for this login's challenge and return to the callback. */
const login = async (e: CloudEditor, code = CODE, lang: 'en' | 'zh' = 'en') => {
  const started = bodyJson(await post(e.rt, e.state, '/api/cloud/start', { lang })) as { authorizeUrl: string };
  const query = new URL(started.authorizeUrl).searchParams;
  e.stub.expectLogin(code, query.get('challenge')!, projectId(e));
  const callback = await get(e.rt, e.state, '/api/cloud/callback', { query: `code=${code}&state=${query.get('state')}` });
  return { started, query, callback };
};

const phase = async (e: CloudEditor): Promise<string> => (await status(e)).state as string;
const untilPhase = (e: CloudEditor, expected: string) => settled(async () => (await phase(e)) === expected, `phase ${expected}`);

describe('the editor page', () => {
  it('tells the editor which cloud mode this service is in, or nothing when cloud save is off', async () => {
    const anonymous = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    expect(bodyText(await get(anonymous.rt, anonymous.state, '/'))).toContain('"cloud":{"mode":"anonymous"}');
    const keyed = await cloudEditor();
    expect(bodyText(await get(keyed.rt, keyed.state, '/'))).toContain('"cloud":{"mode":"keyed"}');
    const off = await cloudEditor({ enabled: false });
    expect(bodyText(await get(off.rt, off.state, '/'))).not.toContain('"cloud"');
    expect((await status(off)).mode).toBe('off');
    expect((await post(off.rt, off.state, '/api/cloud/start', {})).status).toBe(409);
    expect((await post(off.rt, off.state, '/api/cloud/push', {})).status).toBe(409);
  });
});

describe('start', () => {
  it('builds the authorize URL from the site, the integer port and the project, and waits', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    expect(await status(e)).toEqual({ ok: true, mode: 'anonymous', state: 'idle', dirty: true });
    const response = await post(e.rt, e.state, '/api/cloud/start', { lang: 'zh' });
    expect(response.status).toBe(200);
    const body = bodyJson(response) as { ok: boolean; authorizeUrl: string; expiresAt: string };
    expect(body.ok).toBe(true);
    const url = new URL(body.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://stub.popost.test/zh/workspace/cloud-save');
    const q = url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ v: '1', port: String(PORT), project: projectId(e), title: 'Cloud test brief', pages: '1' });
    expect(q.get('state')).toMatch(SECRET_PATTERN);
    expect(q.get('challenge')).toMatch(SECRET_PATTERN);
    expect(Math.abs(Date.parse(body.expiresAt) - e.rt.now().getTime() - 600_000)).toBeLessThan(120_000);
    expect(await status(e)).toMatchObject({ state: 'waiting', mode: 'anonymous' });
  });

  it('chooses language, host and port by itself: nothing in the request redirects the login', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const forged = { lang: '../evil', host: 'evil.test', port: 80, redirect: 'http://evil.test', site: 'https://evil.test' };
    const body = bodyJson(await post(e.rt, e.state, '/api/cloud/start', forged)) as { authorizeUrl: string };
    const url = new URL(body.authorizeUrl);
    expect(url.origin).toBe('https://stub.popost.test');
    expect(url.pathname).toBe('/en/workspace/cloud-save');
    expect(url.searchParams.get('port')).toBe(String(PORT));
    expect(body.authorizeUrl).not.toContain('evil');
  });

  it('never carries the verifier or any credential, and truncates a long title to 80 characters', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const project = await Project.load(e.rt, 'P');
    project.manifest.brief = `  ${'题'.repeat(120)}\n`;
    await project.saveManifest();
    const body = bodyJson(await post(e.rt, e.state, '/api/cloud/start', {})) as { authorizeUrl: string };
    expect(Array.from(new URL(body.authorizeUrl).searchParams.get('title')!)).toHaveLength(80);
    expect(body.authorizeUrl).not.toContain('pat_push');
    expect(body.authorizeUrl).not.toContain(KEY);
  });

  it('is refused when a key is configured (the project syncs without a login)', async () => {
    const e = await cloudEditor();
    expect((await post(e.rt, e.state, '/api/cloud/start', {})).status).toBe(409);
  });

  it('refuses a port that cannot be a redirect target', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    await expect(e.state.cloud.start('en', 80)).rejects.toMatchObject({ code: 'BAD_PORT' });
    await expect(e.state.cloud.start('en', 70000)).rejects.toMatchObject({ code: 'BAD_PORT' });
    await expect(e.state.cloud.start('en', 4321.5)).rejects.toMatchObject({ code: 'BAD_PORT' });
  });
});

describe('callback', () => {
  it('answers 303 to the done page without caching, and uploads the project with the new credential', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const { callback, query } = await login(e);
    expect(callback.status).toBe(303);
    expect(callback.headers.Location).toBe('/cloud-done.html');
    expect(callback.headers['Cache-Control']).toBe('no-store');
    expect(callback.headers['Referrer-Policy']).toBe('no-referrer');
    await untilPhase(e, 'saved');
    const saved = await status(e);
    expect(saved).toMatchObject({ ok: true, mode: 'anonymous', state: 'saved', dirty: false, deckId: 'deck-1', webUrl: 'https://stub.popost.test/en/workspace/projects/deck-1' });
    expect(saved.syncedAt).toBeTruthy();
    // the credential on the wire is pat_push_<code>.<verifier>, and the verifier hashes to the challenge sent to the site
    const auth = syncCalls(e)[0]!.headers.authorization!;
    const [, verifier] = /^Bearer pat_push_([^.]+)\.(.+)$/.exec(auth)!.slice(1);
    expect(auth.startsWith(`Bearer pat_push_${CODE}.`)).toBe(true);
    expect(challengeOf(verifier!)).toBe(query.get('challenge'));
    expect(e.stub.calls('POST', '/uploads').every((r) => r.json!.purpose === 'material')).toBe(true);
    expect(syncCalls(e)[0]!.json!.locale).toBe('en');
    // the finished page of the browser
    const done = await get(e.rt, e.state, '/cloud-done.html');
    expect(done.status).toBe(200);
    expect(done.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(bodyText(done)).toContain('popost');
  });

  it('rejects a missing or malformed code or state, an unknown state and a reused one', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const started = bodyJson(await post(e.rt, e.state, '/api/cloud/start', {})) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    e.stub.expectLogin(CODE, new URL(started.authorizeUrl).searchParams.get('challenge')!, projectId(e));
    const bad = async (query: string) => (await get(e.rt, e.state, '/api/cloud/callback', { query })).status;
    expect(await bad('')).toBe(400);
    expect(await bad(`state=${state}`)).toBe(400);
    expect(await bad(`code=${CODE}`)).toBe(400);
    expect(await bad(`code=short&state=${state}`)).toBe(400);
    expect(await bad(`code=${CODE}&state=${'x'.repeat(43)}`)).toBe(400);
    expect(await bad(`code=${CODE}&state=${state}x`)).toBe(400);
    expect(syncCalls(e)).toHaveLength(0);
    // wrong attempts did not consume the real login
    expect(await phase(e)).toBe('waiting');
    expect(await bad(`code=${CODE}&state=${state}`)).toBe(303);
    await untilPhase(e, 'saved');
    expect(await bad(`code=${CODE}&state=${state}`)).toBe(400);
    expect(syncCalls(e)).toHaveLength(1);
    const refused = await get(e.rt, e.state, '/api/cloud/callback', { query: '' });
    expect(refused.headers['Cache-Control']).toBe('no-store');
    expect(refused.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('rejects a login that waited longer than ten minutes', async () => {
    let clock = Date.UTC(2026, 10, 14, 12);
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' }, now: () => new Date(clock) });
    const started = bodyJson(await post(e.rt, e.state, '/api/cloud/start', {})) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    clock += 10 * 60_000 + 1;
    expect((await get(e.rt, e.state, '/api/cloud/callback', { query: `code=${CODE}&state=${state}` })).status).toBe(400);
    expect(await phase(e)).toBe('idle');
  });

  it('forgets started logins when another project is served', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const started = bodyJson(await post(e.rt, e.state, '/api/cloud/start', {})) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await Project.create(e.rt, 'Q', 'other', 'original', 300, 400);
    e.state.root = '/work/Q';
    expect((await get(e.rt, e.state, '/api/cloud/callback', { query: `code=${CODE}&state=${state}` })).status).toBe(400);
    expect(await phase(e)).toBe('idle');
  });
});

describe('anonymous phases', () => {
  it('a failed upload keeps the credential for a retry, and the retry uses it without a new login', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    e.stub.set('POST', '/projects/sync', err(403, 'STORAGE_FULL', 'full'));
    await login(e);
    await untilPhase(e, 'failed');
    expect(await status(e)).toMatchObject({ state: 'failed', error: { code: 'STORAGE_FULL' }, dirty: true });
    e.stub.clear('POST', '/projects/sync');
    const retried = bodyJson(await post(e.rt, e.state, '/api/cloud/push', {}));
    expect(retried).toMatchObject({ ok: true, state: 'saved', dirty: false });
    expect(syncCalls(e)).toHaveLength(2);
  });

  it('a push without a login answers LOGIN_REQUIRED', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const response = await post(e.rt, e.state, '/api/cloud/push', {});
    expect(response.status).toBe(409);
    expect(bodyJson(response)).toMatchObject({ ok: false, mode: 'anonymous', state: 'idle', error: { code: 'LOGIN_REQUIRED' } });
    expect(e.stub.requests).toHaveLength(0);
  });

  it('after a save the project is idle again with local changes, and nothing is uploaded on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    await login(e);
    await untilPhase(e, 'saved');
    expect((await save(e, '<div class="post">changed</div>')).status).toBe(200);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await status(e)).toMatchObject({ state: 'idle', dirty: true, deckId: 'deck-1' });
    expect(syncCalls(e)).toHaveLength(1);
  });

  it('web edits surface as a conflict, and an upload credential never overwrites them', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    await login(e);
    await untilPhase(e, 'saved');
    e.stub.editOnWeb(projectId(e));
    await save(e, '<div class="post">local</div>');
    await login(e, 'D'.repeat(43));
    await untilPhase(e, 'conflict');
    expect(await status(e)).toMatchObject({ state: 'conflict', error: { code: 'DECK_CONFLICT' }, webUrl: expect.stringContaining('/projects/deck-1') });
    // only a key may overwrite edits made on the web: the forced push goes out unforced and stays a conflict
    const forced = bodyJson(await post(e.rt, e.state, '/api/cloud/push', { force: true }));
    expect(forced).toMatchObject({ state: 'conflict' });
    expect(syncCalls(e).at(-1)!.json!.force).not.toBe(true);
  });

  it('an expired or used credential ends in failed UNAUTHORIZED and the next push asks for a login', async () => {
    const e = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const { query } = await login(e);
    await untilPhase(e, 'saved');
    await save(e, '<div class="post">more</div>');
    // the first credential is used up: simulate a second callback reusing the first code's login
    e.stub.set('POST', '/projects/sync', err(401, 'UNAUTHORIZED', 'used'));
    expect(query.get('state')).toBeTruthy();
    await login(e, 'E'.repeat(43));
    await untilPhase(e, 'failed');
    expect(await status(e)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(bodyJson(await post(e.rt, e.state, '/api/cloud/push', {}))).toMatchObject({ ok: false, error: { code: 'LOGIN_REQUIRED' } });
  });
});

describe('keyed mode', () => {
  it('pushes on demand and reports the deck', async () => {
    const e = await cloudEditor();
    expect(await status(e)).toMatchObject({ mode: 'keyed', state: 'idle', dirty: true });
    const pushed = bodyJson(await post(e.rt, e.state, '/api/cloud/push', { lang: 'zh' }));
    expect(pushed).toMatchObject({ ok: true, mode: 'keyed', state: 'saved', dirty: false, deckId: 'deck-1' });
    expect(String(pushed.webUrl)).toContain('/zh/');
    expect(syncCalls(e)[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(pushed)).not.toContain(KEY);
  });

  it('syncs once after saves go quiet for three seconds, never inside a save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = await cloudEditor();
    await post(e.rt, e.state, '/api/cloud/push', {});
    expect(syncCalls(e)).toHaveLength(1);
    const first = await save(e, '<div class="post">one</div>');
    expect(first.status).toBe(200);
    expect(syncCalls(e)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await save(e, '<div class="post">two</div>');
    await vi.advanceTimersByTimeAsync(2999);
    expect(syncCalls(e)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await untilPhase(e, 'saved');
    expect(syncCalls(e)).toHaveLength(2);
    expect(await status(e)).toMatchObject({ dirty: false });
  });

  it('serializes pushes: a save during an upload waits its turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let open: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    let running = 0;
    let peak = 0;
    const e = await cloudEditor({
      fetchHandler: (stub) => async (request) => {
        if (!new URL(request.url).pathname.endsWith('/projects/sync')) return stub.fetch(request);
        running += 1;
        peak = Math.max(peak, running);
        if (gate) await gate;
        const response = await stub.fetch(request);
        running -= 1;
        return response;
      },
    });
    gate = new Promise<void>((resolve) => (open = resolve));
    await save(e, '<div class="post">one</div>');
    await vi.advanceTimersByTimeAsync(3000);
    await settled(() => running === 1);
    await save(e, '<div class="post">two</div>');
    await vi.advanceTimersByTimeAsync(3000);
    open();
    gate = null;
    await settled(async () => syncCalls(e).length === 2 && (await phase(e)) === 'saved');
    expect(peak).toBe(1);
    expect(await status(e)).toMatchObject({ dirty: false });
  });

  it('a failing sync never fails a save; the next save tries again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = await cloudEditor();
    e.stub.set('POST', '/projects/sync', err(500, 'INTERNAL_ERROR', 'boom'));
    expect((await save(e, '<div class="post">one</div>')).status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    await untilPhase(e, 'failed');
    e.stub.clear('POST', '/projects/sync');
    expect((await save(e, '<div class="post">two</div>')).status).toBe(200);
    await vi.advanceTimersByTimeAsync(3000);
    await untilPhase(e, 'saved');
  });

  it('stops syncing on its own after a conflict until the user overwrites', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = await cloudEditor();
    await post(e.rt, e.state, '/api/cloud/push', {});
    e.stub.editOnWeb(projectId(e));
    await save(e, '<div class="post">local</div>');
    await vi.advanceTimersByTimeAsync(3000);
    await untilPhase(e, 'conflict');
    const before = syncCalls(e).length;
    await save(e, '<div class="post">local again</div>');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncCalls(e)).toHaveLength(before);
    const forced = bodyJson(await post(e.rt, e.state, '/api/cloud/push', { force: true }));
    expect(forced).toMatchObject({ state: 'saved' });
  });

  it('syncs once when the service starts if the project changed since the last sync, and not otherwise', async () => {
    const e = await cloudEditor();
    e.state.cloud.autoStart();
    await untilPhase(e, 'saved');
    expect(syncCalls(e)).toHaveLength(1);
    e.state.cloud.autoStart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(syncCalls(e)).toHaveLength(1);
  });

  it('does not sync by itself without a key or with cloud save off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const options of [{ env: { POPOST_API_KEY: '' } }, { enabled: false }]) {
      const e = await cloudEditor(options);
      e.state.cloud.autoStart();
      await save(e, '<div class="post">x</div>');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(e.stub.requests).toHaveLength(0);
    }
  });
});
