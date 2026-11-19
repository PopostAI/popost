/** `present` (the host's own editor, or the local editor service) and `serve`, with the service running in this process. */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { handoff } from '../src/editor/handoff';
import { Project } from '../src/core/project';
import { writeCloudRecord } from '../src/cloud/state';
import { run } from '../src/main';
import { findChromium, launchChromium } from '../src/render/browser';
import type { EditorHost, LocalProcesses } from '../src/runtime';
import { createTestRuntime, runCli, type TestRuntime } from '../src/testing/memory';
import { PNG_1X1 } from './workflow-helpers';
import { editorFixture, ORIGIN } from './editor-helpers';
import { BASE_URL, err, KEY, ok, ORIGIN as CLOUD_ORIGIN, PopostStub } from './image-helpers';

/** What `present` prints for the local service. */
interface Handoff {
  url: string;
  projectIdentity: string;
  open: unknown;
  hostAction: unknown;
  [key: string]: unknown;
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const cloudHarness = async () => {
  const platform = new PopostStub();
  platform.set('GET', '/me', ok({ user: { id: 'test-account' } }));
  const harnessForCloud = await harness({
    env: { POPOST_API_KEY: KEY, POPOST_BASE_URL: BASE_URL, CODEX_THREAD_ID: 'test-thread' },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).origin === CLOUD_ORIGIN ? platform.fetch(request) : fetch(request);
    },
    launchBrowser: () => launchChromium(process.env),
  });
  return { ...harnessForCloud, platform };
};

interface Harness {
  readonly rt: TestRuntime;
  /** argv of every detached service the command asked for. */
  readonly spawns: string[][];
}

/**
 * A runtime whose "detached process" is the real `serve` command running in this process on the same file system, with the
 * real network between it and `present`. `behaviour: 'fail'` makes the service report that it could not start.
 */
const harness = async (overrides: Partial<TestRuntime> = {}, behaviour: 'serve' | 'fail' = 'serve'): Promise<Harness> => {
  const { rt: base } = await editorFixture();
  const spawns: string[][] = [];
  const processes: LocalProcesses = {
    createServer,
    selfCommand: ['popost-test'],
    spawnDetached: async (argv, { logFile }) => {
      spawns.push([...argv]);
      let log = '';
      const controller = new AbortController();
      const child = createTestRuntime({
        fs: base.fs,
        ...(overrides.env ? { env: overrides.env } : {}),
        processes,
        signal: controller.signal,
        stdout: (text) => void base.fs.writeFile(logFile, (log += text)),
      });
      if (behaviour === 'fail') {
        await base.fs.writeFile(logFile, '{"ok": false, "error": "EADDRINUSE"}\n');
        return { pid: 1 };
      }
      const done = run(argv.slice(1), child);
      stops.push(async () => {
        controller.abort();
        await done;
      });
      return { pid: 4242 };
    },
  };
  const rt = createTestRuntime({ fs: base.fs, processes, fetch: globalThis.fetch, ...overrides });
  return { rt, spawns };
};

const workbench = (result: Record<string, unknown> = { delivered: 'workbench', deckId: 'd1', version: 3, pages: 1 }) => {
  const calls: string[] = [];
  const host: EditorHost = {
    id: 'web',
    present: async (dir) => {
      calls.push(dir);
      return result;
    },
  };
  return { host, calls };
};

describe('present --host web', () => {
  it('hands the project to the host and prints its answer as the command\'s JSON', async () => {
    const { host, calls } = workbench();
    const { rt } = await harness({ editorHost: host, processes: undefined });
    const result = await runCli(rt, ['present', '--dir', 'P', '--host', 'web']);
    expect(result.code).toBe(0);
    expect(rt.json()).toEqual({ delivered: 'workbench', deckId: 'd1', version: 3, pages: 1 });
    expect(calls).toEqual(['/work/P']);
  });

  it('is also what --host auto and the host\'s own id mean when the host has an editor', async () => {
    const { host, calls } = workbench();
    const { rt } = await harness({ editorHost: host });
    for (const name of ['auto', 'web']) expect((await runCli(rt, ['present', '--dir', 'P', '--host', name])).code).toBe(0);
    expect((await runCli(rt, ['present', '--dir', 'P'])).code).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it('fails with error JSON and exit 2 when the host has no editor of its own', async () => {
    const { rt, spawns } = await harness();
    const result = await runCli(rt, ['present', '--dir', 'P', '--host', 'web']);
    expect(result.code).toBe(2);
    expect(rt.json().ok).toBe(false);
    expect(String(rt.json().error)).toContain('--host web');
    expect(spawns).toEqual([]);
  });

  it('turns a failing host into error JSON, exit 2', async () => {
    const { rt } = await harness({
      editorHost: { id: 'web', present: async () => Promise.reject(new Error('deck is locked')) },
    });
    expect((await runCli(rt, ['present', '--dir', 'P', '--host', 'web'])).code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: 'deck is locked' });
    const { rt: refusing } = await harness({ editorHost: workbench({ ok: false, error: 'no' }).host });
    expect((await runCli(refusing, ['present', '--dir', 'P', '--host', 'web'])).code).toBe(2);
  });

  it('does not start a local service for another host name when the host shows projects itself', async () => {
    const { rt, spawns } = await harness({ editorHost: workbench().host, processes: undefined });
    expect((await runCli(rt, ['present', '--dir', 'P', '--host', 'codex'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--host web');
    expect(spawns).toEqual([]);
  });

  it('says so when there is neither a local service nor an editor of its own', async () => {
    const { rt } = await harness({ processes: undefined });
    expect((await runCli(rt, ['present', '--dir', 'P'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('present is not available');
  });

  it('needs a project (a crash, exit 1, like every command that loads one)', async () => {
    const { rt } = await harness({ editorHost: workbench().host });
    expect((await runCli(rt, ['present', '--dir', 'nowhere', '--host', 'web'])).code).toBe(1);
  });
});

describe('present with the local editor service', () => {
  it('starts one service, describes how a host opens it and writes editor-handoff.json', async () => {
    const { rt, spawns } = await harness();
    const result = await runCli(rt, ['present', '--dir', 'P', '--host', 'codex']);
    expect(result.code, result.stdout).toBe(0);
    const printed = rt.json() as Handoff;
    expect(printed).toMatchObject({
      ok: true,
      host: 'codex',
      schema: 'popost-editor-handoff.v1',
      transport: 'loopback-http',
      reusedService: false,
      requiresHostAction: true,
      opened: false,
      version: '4.1.2',
    });
    expect(printed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/editor\.html$/);
    expect(printed.open).toEqual({ kind: 'web-url', url: printed.url, preferredPlacement: 'side-panel' });
    expect(printed.hostAction).toEqual({
      tool: 'mcp__codex_app__open_in_codex',
      arguments: { target: { type: 'browser', url: printed.url }, placement: 'right' },
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.slice(1, 5)).toEqual(['serve', '--dir', '/work/P', '--port']);
    expect(JSON.parse(await rt.fs.readText('/work/P/editor-handoff.json'))).toEqual(printed);
    const state = JSON.parse(await rt.fs.readText('/work/P/.popost-editor/service.json')) as Record<string, unknown>;
    expect(state).toMatchObject({ pid: 4242, version: '4.1.2', url: printed.url.replace('/editor.html', '') });
    const info = await (await fetch(`${state.url}/api/editor-info`)).json();
    expect(info).toMatchObject({ ok: true, projectIdentity: printed.projectIdentity });
  });

  it('reuses the running service of this project and only changes the host action', async () => {
    const { rt, spawns } = await harness();
    await runCli(rt, ['present', '--dir', 'P', '--host', 'codex']);
    const first = rt.json();
    await runCli(rt, ['present', '--dir', 'P', '--host', 'workbuddy']);
    const again = rt.json() as Handoff;
    expect(spawns).toHaveLength(1);
    expect(again).toMatchObject({ reusedService: true, url: first.url, host: 'workbuddy' });
    expect(again.hostAction).toEqual({ capability: 'open_url_in_panel', url: first.url, placement: 'side-panel', discoverFrom: 'available host tools' });
  });

  it('starts a new service when the recorded one is gone, not loopback, or on another port than asked', async () => {
    const { rt, spawns } = await harness();
    await runCli(rt, ['present', '--dir', 'P']);
    const state = '/work/P/.popost-editor/service.json';
    for (const url of ['http://127.0.0.1:1', 'http://evil.test', 'http://127.0.0.1:9/x?y=1', 'file:///etc']) {
      await rt.fs.writeFile(state, JSON.stringify({ url, pid: 1, version: '4.1.2' }));
      await runCli(rt, ['present', '--dir', 'P']);
      expect(rt.json().reusedService, url).toBe(false);
    }
    expect(spawns).toHaveLength(5);
    const free = await freePort();
    expect((await runCli(rt, ['present', '--dir', 'P', '--port', String(free)])).code).toBe(0); // the running one is on another port
    expect(rt.json()).toMatchObject({ reusedService: false, url: `http://127.0.0.1:${free}/editor.html` });
    expect(spawns).toHaveLength(6);
  });

  it('picks the host from the environment for --host auto, and invents no host API for unknown hosts', async () => {
    const { rt } = await harness({ env: { CODEX_THREAD_ID: 't1' } });
    await runCli(rt, ['present', '--dir', 'P']);
    expect(rt.json().host).toBe('codex');
    const { rt: plain } = await harness();
    await runCli(plain, ['present', '--dir', 'P']);
    expect(plain.json().host).toBe('generic');

    const project = await Project.load(plain, 'P');
    for (const host of ['claude-code', 'doubao', 'generic']) {
      const result = handoff(plain, project, 'http://127.0.0.1:1', host) as { hostAction: Record<string, unknown> };
      expect(result.hostAction, host).not.toHaveProperty('tool');
      expect(result.hostAction.capability).toBe('open_url_in_panel');
    }
  });

  it('reports why the service did not start, with exit 2', async () => {
    const { rt } = await harness({}, 'fail');
    expect((await runCli(rt, ['present', '--dir', 'P'])).code).toBe(2);
    expect(String(rt.json().error)).toMatch(/^editor service did not start: EADDRINUSE; inspect \/work\/P\/\.popost-editor\/server-\d+\.log$/);
  });
});

describe('present and cloud save', () => {
  it('offers Save to Cloud locally without a key', async () => {
    const { rt } = await harness();
    await runCli(rt, ['present', '--dir', 'P']);
    expect(rt.json()).toMatchObject({ cloud: { mode: 'anonymous', state: 'idle' }, capabilities: expect.arrayContaining(['cloud-save']) });
    expect(rt.json().cloud).not.toHaveProperty('webUrl');
    expect(rt.json().transport).toBe('loopback-http');
    const printed = rt.json() as Handoff;
    const started = await fetch(`${new URL(printed.url).origin}/api/cloud/start`, {
      method: 'POST', headers: { origin: new URL(printed.url).origin }, body: JSON.stringify({ lang: 'zh' }),
    });
    expect(started.status).toBe(200);
    const { authorizeUrl } = await started.json();
    expect(new URL(authorizeUrl).pathname).toBe('/zh/workspace/cloud-save');
  });

  it('falls back to a local editor with browser login when the key is rejected', async () => {
    const { rt, platform, spawns } = await cloudHarness();
    platform.set('GET', '/me', err(401, 'UNAUTHORIZED', KEY));
    const result = await runCli(rt, ['present', '--dir', 'P']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(KEY);
    const printed = rt.json() as Handoff;
    expect(printed).toMatchObject({ transport: 'loopback-http', cloud: { mode: 'anonymous', error: { code: 'UNAUTHORIZED' } } });
    expect(spawns[0]!.slice(-2)).toEqual(['--cloud', 'login']);
    expect(platform.calls('POST', '/projects/sync')).toHaveLength(0);
    const origin = new URL(printed.url).origin;
    const response = await fetch(`${origin}/api/cloud/start`, { method: 'POST', headers: { origin } });
    expect(response.status).toBe(200);
    expect(new URL((await response.json()).authorizeUrl).origin).toBe(CLOUD_ORIGIN);
  });

  it.skipIf(!findChromium(process.env))('syncs the editable project and opens its cloud URL, including after a web edit', async () => {
    const { rt, platform, spawns } = await cloudHarness();
    const project = await Project.load(rt, 'P');
    const web = `${CLOUD_ORIGIN}/en/workspace/projects/deck-1`;
    await project.addAssetBytes(PNG_1X1, 'dot.png');
    const html = (copy: string) => `<!doctype html><html><body><div class="post" style="width:300px;height:400px"><h1>${copy}</h1><img src="../assets/dot.png" alt=""></div></body></html>`;
    await project.writePageHtml('p1', html('From the local project'));
    const args = ['present', '--dir', 'P'];
    const first = await runCli(rt, args);
    expect(first.code, first.stdout).toBe(0);
    expect(first.stdout).not.toContain(KEY);
    expect(rt.json()).toMatchObject({
      transport: 'web-http',
      url: web,
      open: { url: web },
      hostAction: { arguments: { target: { type: 'browser', url: web } } },
      cloud: { mode: 'keyed', state: 'saved', deckId: 'deck-1', webUrl: web },
    });
    expect(JSON.parse(await rt.fs.readText('/work/P/editor-handoff.json'))).toEqual(rt.json());
    expect(platform.calls('POST', '/projects/sync')[0]!.json).toMatchObject({ html: expect.stringContaining('From the local project'), assets: [{ url: '../assets/dot.png', uploadId: expect.any(String) }] });
    platform.editOnWeb(project.manifest.projectId);
    expect((await runCli(rt, args)).code).toBe(0);
    expect(rt.json().url).toBe(web);

    platform.set('GET', '/me', ok({ user: { id: 'another-account' } }));
    platform.set('POST', '/projects/sync', err(409, 'DECK_CONFLICT'));
    expect((await runCli(rt, args)).code).toBe(0);
    expect(rt.json()).toMatchObject({ transport: 'loopback-http', cloud: { mode: 'anonymous', error: { code: 'DECK_CONFLICT' } } });
    expect(rt.json().cloud).not.toHaveProperty('webUrl');
    platform.set('GET', '/me', ok({ user: { id: 'test-account' } }));
    platform.clear('POST', '/projects/sync');

    await project.writePageHtml('p1', html('A newer local edit'));
    expect((await runCli(rt, args)).code).toBe(0);
    expect(rt.json()).toMatchObject({ transport: 'loopback-http', cloud: { mode: 'anonymous', error: { code: 'DECK_CONFLICT' } } });
    expect(spawns).toHaveLength(1);
    expect(platform.decks.get(project.manifest.projectId)).toMatchObject({ version: 2, lastSynced: 1 });
    expect(platform.calls('POST', '/projects/sync').every(({ json }) => json?.force === false)).toBe(true);
  }, 60_000);

  it('asks a reused service for its own answer and names the web address once the project was synced', async () => {
    const { rt, spawns } = await harness();
    await runCli(rt, ['present', '--dir', 'P']);
    const project = await Project.load(rt, 'P');
    await writeCloudRecord(project, { projectId: project.manifest.projectId, deckId: 'd1', webUrl: 'https://popost.test/en/workspace/projects/d1', fingerprint: 'x', assets: {} });
    await runCli(rt, ['present', '--dir', 'P']);
    expect(spawns).toHaveLength(1);
    expect(rt.json()).toMatchObject({ reusedService: true, cloud: { mode: 'anonymous', state: 'idle', webUrl: 'https://popost.test/en/workspace/projects/d1' } });
  });

  it('--cloud off reaches the service: no cloud in the handoff, the editor page or the routes', async () => {
    const { rt, platform, spawns } = await cloudHarness();
    platform.set('GET', '/me', err(401, 'UNAUTHORIZED'));
    await runCli(rt, ['present', '--dir', 'P']);
    const result = await runCli(rt, ['present', '--dir', 'P', '--cloud', 'off']);
    expect(result.code, result.stdout).toBe(0);
    expect(spawns[1]!.slice(-2)).toEqual(['--cloud', 'off']);
    expect(platform.calls('GET', '/me')).toHaveLength(1);
    const printed = rt.json() as Handoff;
    expect(printed.cloud).toEqual({ mode: 'off', state: 'idle' });
    const page = await (await fetch(printed.url)).text();
    expect(page).not.toContain('"cloud"');
    const status = (await (await fetch(`${printed.url.replace('/editor.html', '')}/api/cloud/status`)).json()) as { mode: string };
    expect(status.mode).toBe('off');
    expect((await runCli(rt, ['present', '--dir', 'P', '--cloud', 'maybe'])).code).toBe(2);
  });

  it('a handoff written without cloud facts says off', async () => {
    const { rt } = await harness();
    const project = await Project.load(rt, 'P');
    expect(handoff(rt, project, 'http://127.0.0.1:1').cloud).toEqual({ mode: 'off', state: 'idle' });
  });
});

describe('serve', () => {
  const start = async (rt: TestRuntime, port = '0') => {
    const controller = new AbortController();
    const server = createTestRuntime({ fs: rt.fs, processes: rt.processes, signal: controller.signal });
    const done = run(['serve', '--dir', 'P', '--port', port], server);
    stops.push(async () => {
      controller.abort();
      await done;
    });
    await waitFor(() => server.out.length > 0, 'the service to listen');
    return { listening: server.json() as { ok: boolean; listening: string; project: string }, server, done, controller };
  };

  it('listens on loopback, announces itself on stdout and answers HTTP from the project files', async () => {
    const { rt } = await harness();
    const project = await Project.load(rt, 'P');
    await project.addAssetBytes(PNG_1X1, 'dot.png');
    const { listening } = await start(rt);
    expect(listening).toMatchObject({ ok: true, project: '/work/P' });
    expect(listening.listening).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const info = await fetch(`${listening.listening}/api/editor-info`);
    expect(info.status).toBe(200);
    expect(info.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const asset = await fetch(`${listening.listening}/assets/dot.png`);
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(PNG_1X1);
    expect((await fetch(`${listening.listening}/nope`)).status).toBe(404);
    const editor = await fetch(`${listening.listening}/?lang=en`);
    expect(await editor.text()).toContain('__POPOST_LOCAL__');
    expect((await fetch(`${listening.listening}/api/project`, { method: 'PUT' })).status).toBe(501);
  });

  it('refuses writes from other origins and saves from its own', async () => {
    const { rt } = await harness();
    const { listening } = await start(rt);
    const url = `${listening.listening}/api/canvas-notes`;
    const body = JSON.stringify({ ops: [{ op: 'add', note: { id: 'n' } }] });
    expect((await fetch(url, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', body, headers: { origin: 'http://evil.test' } })).status).toBe(403);
    const ok = await fetch(url, { method: 'POST', body, headers: { origin: listening.listening } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ notes: [{ id: 'n' }] });
    expect(ORIGIN).toContain('127.0.0.1');
  });

  it('serializes concurrent saves so each one sees the previous revision', async () => {
    const { rt } = await harness();
    const { listening } = await start(rt);
    const save = (html: string) =>
      fetch(`${listening.listening}/api/project`, {
        method: 'POST',
        headers: { origin: listening.listening },
        body: JSON.stringify({ pages: [{ id: 'p1', width: 300, height: 400, html }] }),
      }).then((response) => response.json() as Promise<{ revision: number }>);
    const revisions = (await Promise.all(['a', 'b', 'c', 'd'].map((x) => save(`<div class="post">${x}</div>`)))).map((r) => r.revision);
    expect([...revisions].sort()).toEqual([1, 2, 3, 4]);
  });

  it('stops when the host asks it to', async () => {
    const { rt } = await harness();
    const { done, controller } = await start(rt);
    controller.abort();
    expect(await done).toBe(0);
  });

  it('needs processes (a host that cannot open ports says so, exit 2) and a project', async () => {
    const { rt } = await harness({ processes: undefined });
    expect((await runCli(rt, ['serve', '--dir', 'P'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('serve is not available');
    expect((await runCli(rt, ['serve', '--dir', 'nowhere'])).code).toBe(1);
    expect((await runCli(rt, ['serve', '--dir', 'P', '--port', 'x'])).code).toBe(2);
  });

  it('fails when the port is taken', async () => {
    const { rt } = await harness();
    const { listening } = await start(rt);
    const port = new URL(listening.listening).port;
    const second = createTestRuntime({ fs: rt.fs, processes: rt.processes });
    expect(await run(['serve', '--dir', 'P', '--port', port], second)).toBe(1);
    expect(String(second.json().error)).toContain('EADDRINUSE');
  });
});
