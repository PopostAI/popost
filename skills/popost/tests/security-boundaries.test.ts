import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../src/node-runtime';
import { readProjectFile } from '../src/render/offline';
import { originAllowed } from '../src/editor/request-security';
import { cloudEditor } from './cloud-helpers';
import { bodyJson, editorFixture, get, ORIGIN, post, PORT } from './editor-helpers';

describe('local editor security boundaries', () => {
  it('rejects rebound hosts on reads and writes, including a matching Origin', async () => {
    const { rt, state } = await editorFixture();
    const headers = { host: `foreign.example:${PORT}`, origin: `http://foreign.example:${PORT}` };
    for (const route of ['/api/project', '/editor.html', '/pages/p1.html'])
      expect((await get(rt, state, route, { headers })).status).toBe(403);
    expect((await post(rt, state, '/api/project', {}, headers)).status).toBe(403);
    expect(originAllowed({ host: `localhost:${PORT}`, origin: `https://localhost:${PORT}` }, PORT)).toBe(false);
    expect(originAllowed({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }, PORT)).toBe(true);
  });

  it('sandboxes raw HTML and SVG without restricting trusted editor scripts', async () => {
    const { rt, state } = await editorFixture();
    for (const file of ['evil.html', 'evil.svg']) {
      await rt.fs.writeFile(`${state.root}/${file}`, '<script>fetch("/api/project")</script>');
      const response = await get(rt, state, `/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers['Content-Security-Policy']).toContain('sandbox;');
      expect(response.headers['Content-Security-Policy']).not.toContain('allow-scripts');
      expect(response.headers['X-Content-Type-Options']).toBe('nosniff');
    }
    expect((await get(rt, state, '/_editor/assets/app.js')).headers['Content-Security-Policy']).toBeUndefined();
  });

  it('rejects file and directory symlinks escaping the real project root', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'editor-boundary-'));
    try {
      const root = path.join(dir, 'project');
      await mkdir(root);
      await mkdir(path.join(dir, 'outside'));
      await writeFile(path.join(dir, 'outside', 'marker.txt'), 'private marker');
      await symlink(path.join(dir, 'outside', 'marker.txt'), path.join(root, 'file.txt'));
      await symlink(path.join(dir, 'outside'), path.join(root, 'dir'));
      await writeFile(path.join(root, 'safe.txt'), 'safe');
      const rt = createNodeRuntime();
      expect(await readProjectFile(rt, root, '/file.txt')).toBeNull();
      expect(await readProjectFile(rt, root, '/dir/marker.txt')).toBeNull();
      expect(new TextDecoder().decode((await readProjectFile(rt, root, '/safe.txt'))?.data)).toBe('safe');
      // A symlink to the project itself is valid, including platforms where /tmp is a symlink.
      await symlink(root, path.join(dir, 'alias'));
      expect(await readProjectFile(rt, path.join(dir, 'alias'), '/safe.txt')).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cloud save boundaries', () => {
  const CODE = 'C'.repeat(43);

  it('the callback needs a state this service issued, whatever else the request carries', async () => {
    const { rt, state, stub } = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const callback = async (query: string, headers: Record<string, string> = {}) => get(rt, state, '/api/cloud/callback', { query, headers });
    expect((await callback(`code=${CODE}`)).status).toBe(400);
    expect((await callback(`code=${CODE}&state=${'A'.repeat(43)}`)).status).toBe(400);
    expect((await callback(`code=${CODE}&state=${'A'.repeat(43)}`, { origin: 'https://evil.test' })).status).toBe(400);
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects rebound hosts on every cloud route, including the callback of a live login', async () => {
    const { rt, state } = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    const started = bodyJson(await post(rt, state, '/api/cloud/start', {})) as { authorizeUrl: string };
    const live = new URL(started.authorizeUrl).searchParams.get('state')!;
    const headers = { host: `foreign.example:${PORT}`, origin: `http://foreign.example:${PORT}` };
    expect((await get(rt, state, '/api/cloud/status', { headers })).status).toBe(403);
    expect((await get(rt, state, '/api/cloud/callback', { query: `code=${CODE}&state=${live}`, headers })).status).toBe(403);
    expect((await get(rt, state, '/cloud-done.html', { headers })).status).toBe(403);
    for (const route of ['/api/cloud/start', '/api/cloud/push']) expect((await post(rt, state, route, {}, headers)).status).toBe(403);
    // the live login was not consumed by the rejected callback
    expect(bodyJson(await get(rt, state, '/api/cloud/status')).state).toBe('waiting');
  });

  it('the writing cloud routes still require a same-origin Origin header', async () => {
    const { rt, state } = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    for (const route of ['/api/cloud/start', '/api/cloud/push']) {
      expect((await post(rt, state, route, {}, {})).status, `${route} without Origin`).toBe(403);
      expect((await post(rt, state, route, {}, { origin: 'https://evil.test' })).status, `${route} cross-site`).toBe(403);
      expect((await post(rt, state, route, {}, { origin: ORIGIN })).status, `${route} same origin`).not.toBe(403);
    }
  });

  it('the cloud routes accept only their own method', async () => {
    const { rt, state } = await cloudEditor({ env: { POPOST_API_KEY: '' } });
    expect((await get(rt, state, '/api/cloud/start')).status).toBe(404);
    expect((await get(rt, state, '/api/cloud/push')).status).toBe(404);
    expect((await post(rt, state, '/api/cloud/status', {})).status).toBe(404);
    expect((await post(rt, state, '/api/cloud/callback', {})).status).toBe(404);
  });
});
