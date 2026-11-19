/** `popost cloud push`: export, upload by content hash, sync; against the in-memory platform stub. */
import { describe, expect, it, vi } from 'vitest';
import { assetUrlsOf, pushProject, staleAssetIndexes } from '../src/cloud/push';
import { readCloudRecord } from '../src/cloud/state';
import { CloudError } from '../src/cloud/errors';
import { Project } from '../src/core/project';
import type { DeckSession } from '../src/deck/types';
import { PopostClient } from '../src/providers/api';
import { PopostApiError } from '../src/providers/errors';
import { challengeOf } from '../src/cloud/auth-flow';
import { cloudScene, deckDocument, withSleep } from './cloud-helpers';
import { cli, err, everythingWritten, KEY, type Json } from './image-helpers';

/** The error a promise rejects with; fails the test when it resolves. */
const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to be rejected');
};

const push = (scene: Awaited<ReturnType<typeof cloudScene>>, extra: { force?: boolean; locale?: 'en' | 'zh' } = {}, rt = scene.rt) =>
  pushProject(rt, { dir: 'P', client: new PopostClient(rt), session: scene.session, ...extra });

describe('asset URLs', () => {
  it('finds every ../assets/ URL once, in the places a document writes pictures', () => {
    const html = '<img src="../assets/a.png"><div style="background:url(../assets/b%20c.png)"></div><i style=\'background:url("../assets/sub/d.webp")\'></i><img src="../assets/a.png"><a href="https://x.test/../assets/no.png">';
    expect(assetUrlsOf(html)).toEqual(['../assets/a.png', '../assets/b%20c.png', '../assets/sub/d.webp']);
  });

  it('reads stale upload positions from the issue paths in either spelling', () => {
    const error = new PopostApiError('x', { code: 'INVALID_REQUEST', details: { issues: [{ path: ['assets', 2, 'uploadId'] }, { path: 'assets.0.uploadId' }, { path: ['assets'] }] } });
    expect(staleAssetIndexes(error)).toEqual([2, 0]);
    expect(staleAssetIndexes(new PopostApiError('x', { code: 'FORBIDDEN' }))).toEqual([]);
  });
});

describe('pushProject', () => {
  it('uploads each distinct picture once as material, lists every URL, and creates the deck', async () => {
    const scene = await cloudScene();
    const result = await push(scene);
    expect(result).toMatchObject({ deckId: 'deck-1', version: 1, changed: true, created: true, pages: 1, assets: { uploaded: 2, reused: 0 } });
    expect(result.webUrl).toBe('https://stub.popost.test/en/workspace/projects/deck-1');
    const tickets = scene.stub.calls('POST', '/uploads');
    expect(tickets.map((t) => t.json)).toMatchObject([
      { fileName: 'a.png', mimeType: 'image/png', purpose: 'material' },
      { fileName: 'c.png', mimeType: 'image/png', purpose: 'material' },
    ]);
    expect(tickets[0]!.json!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const body = scene.stub.calls('POST', '/projects/sync')[0]!.json as Json;
    expect(body).toMatchObject({ projectId: scene.project.manifest.projectId, title: 'Cloud test brief', width: 300, height: 400, platform: null, force: false });
    expect(body.locale).toBeUndefined();
    expect(body.assets.map((a: Json) => a.url)).toEqual(['../assets/a.png', '../assets/b.png', '../assets/c.png']);
    expect(body.assets[0].uploadId).toBe(body.assets[1].uploadId);
    expect(body.assets[2].uploadId).not.toBe(body.assets[0].uploadId);
    expect(body.html).toBe(scene.document);
    expect(scene.stub.uploads.size).toBe(2);
  });

  it('a second push reuses the cache: nothing is uploaded and the platform reports no change', async () => {
    const scene = await cloudScene();
    await push(scene);
    const again = await push(scene, { locale: 'zh' });
    expect(again).toMatchObject({ changed: false, created: false, version: 1, assets: { uploaded: 0, reused: 2 } });
    expect(again.webUrl).toContain('/zh/workspace/');
    expect(scene.stub.calls('POST', '/uploads')).toHaveLength(2);
    expect(scene.stub.calls('POST', '/projects/sync')[1]!.json!.locale).toBe('zh');
  });

  it('keeps the state in .popost-editor/cloud.json, without any credential', async () => {
    const scene = await cloudScene();
    const first = await push(scene);
    const record = await readCloudRecord(await Project.load(scene.rt, 'P'));
    expect(record).toMatchObject({ projectId: scene.project.manifest.projectId, deckId: 'deck-1', webUrl: first.webUrl, version: 1 });
    expect(record!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(record!.assets)).toHaveLength(2);
    const raw = await scene.rt.fs.readText('/work/P/.popost-editor/cloud.json');
    expect(raw).not.toContain(KEY);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['assets', 'assetsUrl', 'contentHash', 'deckId', 'fingerprint', 'projectId', 'syncedAt', 'version', 'webUrl']);
  });

  it('re-uploads only the pictures the platform says it lost, and retries once', async () => {
    const scene = await cloudScene();
    await push(scene);
    scene.stub.forgetUploads();
    scene.document = deckDocument(['a.png', 'c.png'], '<p>edited</p>');
    const again = await push(scene);
    expect(again).toMatchObject({ changed: true, assets: { uploaded: 2, reused: 0 } });
    expect(scene.stub.calls('POST', '/projects/sync')).toHaveLength(3);
    expect(scene.stub.calls('POST', '/uploads')).toHaveLength(4);
  });

  it('gives up when the retry still names a stale upload', async () => {
    const scene = await cloudScene();
    scene.stub.set('POST', '/projects/sync', err(400, 'INVALID_REQUEST', 'stale', { issues: [{ path: ['assets', 0, 'uploadId'], message: 'x' }] }));
    await expect(push(scene)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(scene.stub.calls('POST', '/projects/sync')).toHaveLength(2);
  });

  it('waits as long as the platform asks on RATE_LIMITED, capped at a minute, and then continues', async () => {
    const scene = await cloudScene();
    const waited: number[] = [];
    let uploadsSeen = 0;
    scene.stub.set('POST', '/uploads', () => {
      uploadsSeen += 1;
      if (uploadsSeen === 1) return err(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 2 });
      scene.stub.clear('POST', '/uploads');
      return err(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 500 });
    });
    const result = await push(scene, {}, withSleep(scene.rt, waited));
    expect(waited).toEqual([2000, 60000]);
    expect(result.assets.uploaded).toBe(2);
  });

  it('does not retry FORBIDDEN (an upload ticket that hit its cap, or the wrong project)', async () => {
    const scene = await cloudScene();
    const waited: number[] = [];
    scene.stub.set('POST', '/uploads', err(403, 'FORBIDDEN', 'upload cap'));
    await expect(push(scene, {}, withSleep(scene.rt, waited))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(scene.stub.calls('POST', '/uploads')).toHaveLength(1);
    expect(waited).toEqual([]);
    expect(scene.stub.calls('POST', '/projects/sync')).toHaveLength(0);
  });

  it('uploads everything before its single sync request (a ticket dies with the first successful sync)', async () => {
    const scene = await cloudScene();
    await push(scene);
    const order = scene.stub.requests.filter((r) => r.path.endsWith('/uploads') || r.path.endsWith('/projects/sync')).map((r) => r.path.split('/').pop());
    expect(order).toEqual(['uploads', 'uploads', 'sync']);
  });

  it('stops after a few rate-limit waits', async () => {
    const scene = await cloudScene();
    const waited: number[] = [];
    scene.stub.set('POST', '/projects/sync', err(429, 'RATE_LIMITED', 'slow', { retryAfterSeconds: 1 }));
    await expect(push(scene, {}, withSleep(scene.rt, waited))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(waited).toHaveLength(3);
  });

  it('refuses to overwrite web edits, and overwrites with force', async () => {
    const scene = await cloudScene();
    await push(scene);
    scene.stub.editOnWeb(scene.project.manifest.projectId);
    scene.document = deckDocument(['a.png'], '<p>local edit</p>');
    const refused = await failure(push(scene));
    expect(refused).toBeInstanceOf(PopostApiError);
    expect(refused).toMatchObject({ code: 'DECK_CONFLICT', details: { currentVersion: 2 } });
    expect(refused.message).toContain('DECK_CONFLICT');
    const forced = await push(scene, { force: true });
    expect(forced).toMatchObject({ changed: true, version: 3 });
    expect(scene.stub.calls('POST', '/projects/sync').at(-1)!.json!.force).toBe(true);
  });

  it('names the platform refusal codes of a rejected deck and a full storage', async () => {
    const scene = await cloudScene();
    scene.document = deckDocument(['a.png'], '<!-- data-stub-invalid -->');
    const invalid = await failure(push(scene));
    expect(invalid.message).toContain('size_mismatch');
    scene.stub.set('POST', '/projects/sync', err(403, 'STORAGE_FULL', 'full'));
    expect((await failure(push(scene))).message).toContain('STORAGE_FULL');
  });

  it('sends nothing for a picture that is missing, not a picture, or too many', async () => {
    const scene = await cloudScene();
    scene.document = deckDocument(['gone.png']);
    await expect(push(scene)).rejects.toMatchObject({ code: 'ASSET_MISSING' });
    await scene.rt.fs.writeFile('/work/P/assets/notes.png', 'plain text');
    scene.document = deckDocument(['notes.png']);
    await expect(push(scene)).rejects.toMatchObject({ code: 'ASSET_UNSUPPORTED' });
    scene.document = deckDocument(Array.from({ length: 101 }, (_, i) => `p${i}.png`));
    await expect(push(scene)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    scene.document = deckDocument([], 'x'.repeat(2_000_001));
    await expect(push(scene)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(scene.stub.requests).toHaveLength(0);
  });

  it('refuses without a key before exporting anything', async () => {
    const scene = await cloudScene({ env: { POPOST_API_KEY: '' } });
    let exports = 0;
    const session: DeckSession = (fn) => {
      exports += 1;
      return scene.session(fn);
    };
    await expect(pushProject(scene.rt, { dir: 'P', client: new PopostClient(scene.rt), session })).rejects.toBeInstanceOf(CloudError);
    expect(exports).toBe(0);
    expect(scene.stub.requests).toHaveLength(0);
  });

  it('works with an upload ticket as the only credential, and never leaks it', async () => {
    const scene = await cloudScene({ env: { POPOST_API_KEY: '' } });
    const verifier = 'v'.repeat(43);
    const bearer = `pat_push_${'c'.repeat(43)}.${verifier}`;
    scene.stub.expectLogin('c'.repeat(43), challengeOf(verifier), scene.project.manifest.projectId);
    const client = new PopostClient(scene.rt, { bearer });
    expect(client.hasKey()).toBe(true);
    const result = await pushProject(scene.rt, { dir: 'P', client, session: scene.session });
    expect(result.created).toBe(true);
    for (const request of scene.stub.requests.filter((r) => r.path.startsWith('/api/open/v1')))
      expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
    expect(scene.stub.requests.filter((r) => r.method === 'PUT').every((r) => r.headers.authorization === undefined)).toBe(true);
    // the ticket is used up: the same credential now fails, and its text never shows
    const second = await failure(pushProject(scene.rt, { dir: 'P', client, session: scene.session }));
    expect(second).toMatchObject({ code: 'UNAUTHORIZED' });
    for (const written of await everythingWritten(scene.rt)) {
      expect(written).not.toContain(bearer);
      expect(written).not.toContain(verifier);
    }
    expect(second.message).not.toContain(verifier);
  });
});

describe('popost cloud push (CLI)', () => {
  it('prints the contract shape on success', async () => {
    const scene = await cloudScene();
    const { exportDeck } = await import('../src/deck/export-deck');
    vi.spyOn(await import('../src/deck/export-deck'), 'exportDeck').mockImplementation((rt, dir, options) => exportDeck(rt, dir, { ...options, session: scene.session }));
    const { code, data, stdout } = await cli(scene.rt, 'cloud', 'push', '--dir', 'P');
    expect(code).toBe(0);
    expect(Object.keys(data).sort()).toEqual(['assets', 'changed', 'deckId', 'ok', 'pages', 'version', 'webUrl']);
    expect(data).toEqual({ ok: true, deckId: 'deck-1', webUrl: 'https://stub.popost.test/en/workspace/projects/deck-1', version: 1, changed: true, pages: 1, assets: { uploaded: 2, reused: 0 } });
    expect(stdout).not.toContain(KEY);
    const conflict = (scene.stub.editOnWeb(scene.project.manifest.projectId), await cli(scene.rt, 'cloud', 'push', '--dir', 'P'));
    expect(conflict.code).toBe(2);
    expect(conflict.data).toMatchObject({ ok: false, code: 'DECK_CONFLICT', currentVersion: 2 });
    const forced = await cli(scene.rt, 'cloud', 'push', '--dir', 'P', '--force', '--lang', 'zh');
    expect(forced.code).toBe(0);
    expect(forced.data.webUrl).toContain('/zh/');
    vi.restoreAllMocks();
  });

  it('fails with a code and no request when no key is configured', async () => {
    const scene = await cloudScene({ env: { POPOST_API_KEY: '' } });
    const { code, data } = await cli(scene.rt, 'cloud', 'push', '--dir', 'P');
    expect(code).toBe(2);
    expect(data).toMatchObject({ ok: false, code: 'NO_API_KEY' });
    expect(scene.stub.requests).toHaveLength(0);
  });

  it('rejects a language it does not know and lists itself in the help', async () => {
    const scene = await cloudScene();
    expect((await cli(scene.rt, 'cloud', 'push', '--dir', 'P', '--lang', 'fr')).code).toBe(2);
    expect((await cli(scene.rt, 'cloud', '--help')).stdout).toContain('push');
  });
});
