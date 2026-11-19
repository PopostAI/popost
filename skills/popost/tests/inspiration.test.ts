/**
 * `popost inspiration import`: a reference post (PostBundle) saved to the popost.ai inspiration library, with uploads
 * (port of test_inspiration_import.py, against an in-memory fake of the open API).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { planImport } from '../src/providers/inspiration-plan';
import { API, cli, err, everythingWritten, KEY, newScene, ORIGIN, restrictTo, tinyPng } from './image-helpers';

const IMG1 = tinyPng([255, 0, 0], 4);
const IMG2 = tinyPng([0, 0, 255], 3);

const bundleOf = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'postbundle.v1',
  platform: 'xiaohongshu',
  sourceURL: 'https://www.xiaohongshu.com/explore/abc123',
  title: '通勤穿搭一周不重样',
  body: '第一天：白衬衫 + 西裤。',
  tags: ['#穿搭', '通勤', '穿搭', ' '],
  music: { title: '', url: '' },
  pageOrder: [2, 1, 3],
  ratio: '3:4',
  resources: [
    { id: 'r1', kind: 'image', path: 'shots/p1.png', alt: '封面' },
    { id: 'r2', kind: 'image', path: '/work/p2.png' },
    { id: 'r3', kind: 'image', url: 'https://cdn.example.com/p3.jpg', license: 'user-provided', width: 1080, height: 1440 },
    { id: 'v1', kind: 'video', url: 'https://cdn.example.com/v.mp4' },
  ],
  parseStatus: 'ready',
  auth: { required: false, authorized: true, note: '' },
  errors: [],
  missing: [],
  author: { name: '小林', handle: '@lin', extra: 'ignored' },
  stats: { likes: 1200, comments: 34, bogus: -1, views: true },
  publishedAt: '2026-10-01T08:00:00+08:00',
  ...changes,
});

const setup = async (changes: Record<string, unknown> = {}, options: Parameters<typeof newScene>[0] = {}) => {
  const scene = await newScene({ ...options, env: { POPOST_PROVIDER_CONFIG: '/work/no-config.json', ...options.env }, files: { '/work/shots/p1.png': IMG1, '/work/p2.png': IMG2, '/work/bundle.json': JSON.stringify(bundleOf(changes)) } });
  const run = (...args: string[]) => cli(scene.rt, 'inspiration', 'import', '--file', '/work/bundle.json', ...args);
  return { ...scene, run };
};

describe('inspiration import', () => {
  it('uploads the local images, then creates the inspiration with a content-derived client id', async () => {
    const t = await setup();
    const { code, data } = await t.run('--note', '参考配色');
    expect(code, JSON.stringify(data)).toBe(0);
    const tickets = t.stub.calls('POST', '/uploads');
    expect(tickets).toHaveLength(2);
    const byName = Object.fromEntries(tickets.map((r) => [r.json!.fileName, r]));
    for (const [name, raw] of [['p1.png', IMG1], ['p2.png', IMG2]] as const) {
      expect(byName[name]!.json).toEqual({ fileName: name, mimeType: 'image/png', bytes: raw.length, purpose: 'inspiration', sha256: createHash('sha256').update(raw).digest('hex') });
      expect(byName[name]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(byName[name]!.headers['x-popost-client']).toBe('skill');
    }
    const puts = t.stub.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      const uid = put.path.split('/').pop()!;
      expect(put.headers.authorization).toBeUndefined(); // the storage upload carries no platform key
      expect(put.headers['x-popost-client']).toBeUndefined();
      expect(put.headers['x-stub-signature']).toBe(`sig-${uid}`);
      expect(put.headers['content-type']).toBe('image/png');
    }
    expect([...t.stub.uploads.values()].map((b) => Buffer.from(b).toString('hex')).sort()).toEqual([IMG1, IMG2].map((b) => Buffer.from(b).toString('hex')).sort());

    const created = t.stub.calls('POST', '/inspirations');
    expect(created).toHaveLength(1);
    const body = created[0]!.json!;
    expect(body).toMatchObject({ platform: 'xiaohongshu', sourceUrl: 'https://www.xiaohongshu.com/explore/abc123', title: '通勤穿搭一周不重样', text: '第一天：白衬衫 + 西裤。', tags: ['穿搭', '通勤'], author: { name: '小林', handle: '@lin' }, stats: { likes: 1200, comments: 34 }, publishedAt: '2026-10-01T08:00:00+08:00', note: '参考配色' });
    expect(body.author).toEqual({ name: '小林', handle: '@lin' });
    expect(body.clientId).toMatch(/^pb-[0-9a-f]{40}$/);
    // pageOrder [2, 1, 3]: the second local image comes first; the https image is referenced as it is
    const urls = body.images.map((i: { url: string }) => i.url);
    const firstTicket = tickets.find((r) => r.json!.fileName === 'p2.png')!;
    expect(urls[0]).toBe(`${ORIGIN}/files/up_${tickets.indexOf(firstTicket) + 1}`);
    expect(urls[2]).toBe('https://cdn.example.com/p3.jpg');
    expect(body.images[1]).toMatchObject({ alt: '封面', width: 4, height: 4 });
    expect(body.images[2]).toMatchObject({ width: 1080, height: 1440 });
    expect(data.inspiration).toMatchObject({ id: 'insp_1', imageCount: 3 });
    expect(data.skipped.map((s: { resourceId: string }) => s.resourceId)).toEqual(['v1']);
    expect(data.uploaded).toHaveLength(2);
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(KEY);
  });

  it('derives the client id from the content only, so a re-run (or another note) saves nothing twice', async () => {
    const { rt } = await setup();
    const bundle = bundleOf();
    const a = (await planImport(rt, bundle, '/work')).clientId;
    expect((await planImport(rt, bundle, '/work', { note: '另一条备注' })).clientId).toBe(a);
    expect((await planImport(rt, { ...bundle, title: '换个标题' }, '/work')).clientId).not.toBe(a);
    expect((await planImport(rt, bundle, '/work', { clientId: 'mine-1' })).clientId).toBe('mine-1');
    await expect(planImport(rt, bundle, '/work', { clientId: 'x'.repeat(65) })).rejects.toThrow('64');
  });

  it('is offline without a key in a dry run and shows the key as a variable name', async () => {
    const t = await setup({}, { env: { POPOST_API_KEY: undefined, POPOST_BASE_URL: 'http://127.0.0.1:1/api/open/v1' } });
    const { code, data } = await t.run('--dry-run');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.dryRun).toBe(true);
    expect(data.uploads).toHaveLength(2);
    expect(data.uploads[0].request.body.purpose).toBe('inspiration');
    expect(data.request.headers.Authorization).toBe('Bearer $POPOST_API_KEY');
    expect(data.request.body.images).toHaveLength(3);
    expect(t.stub.requests).toEqual([]);
  });

  it('needs --allow-incomplete for a bundle that is not ready, then saves what is there', async () => {
    const pending = bundleOf({ platform: 'x', sourceURL: 'https://x.com/someone/status/1', title: '', body: '', tags: [], pageOrder: [1], ratio: null, resources: [], parseStatus: 'pending', auth: { required: true, authorized: false, note: '' }, errors: ['parse service pending; nothing was fetched'], missing: ['title', 'body', 'resources'], author: undefined, stats: undefined, publishedAt: undefined });
    const t = await setup(pending);
    let r = await t.run();
    expect(r.code, JSON.stringify(r.data)).toBe(2);
    expect(r.data.error.msg).toContain('--allow-incomplete');
    expect(t.stub.requests).toEqual([]);
    r = await t.run('--allow-incomplete');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    const body = t.stub.calls('POST', '/inspirations')[0]!.json!;
    expect([body.platform, body.sourceUrl, body.images]).toEqual(['x', 'https://x.com/someone/status/1', []]);
  });

  it.each([
    ['a title over 500 characters', { title: '长'.repeat(501) }, 'title'],
    ['more than 50 tags', { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }, 'tags'],
    ['a publishedAt without a zone', { publishedAt: '2026-10-01T08:00:00' }, 'time zone'],
    ['a publishedAt that is no date', { publishedAt: 'yesterday' }, 'ISO'],
    ['a missing local image', { resources: [{ id: 'r1', kind: 'image', path: 'missing.png' }] }, 'does not exist'],
    ['an http image url', { resources: [{ id: 'r1', kind: 'image', url: 'http://insecure.example/a.png' }] }, 'https'],
    ['a local file that is not an image', { resources: [{ id: 'r1', kind: 'image', path: '/work/bundle.json' }] }, 'is not a PNG'],
    ['a wrong schema', { schema: 'nope' }, 'schema'],
  ])('rejects %s locally (exit 2) before any request', async (_label, changes, fragment) => {
    const t = await setup(changes as Record<string, unknown>);
    const { code, data } = await t.run();
    expect(code, JSON.stringify(data)).toBe(2);
    expect(data.error).toMatchObject({ code: 'BAD_BUNDLE' });
    expect(data.error.msg).toContain(fragment);
    expect(t.stub.requests).toEqual([]);
  });

  it('reports a missing, unreadable or malformed bundle file with its own code', async () => {
    const t = await setup();
    let r = await cli(t.rt, 'inspiration', 'import', '--file', '/work/nope.json');
    expect([r.code, r.data.error.code]).toEqual([2, 'FILE_NOT_FOUND']);
    r = await cli(t.rt, 'inspiration', 'import', '--file', '/work/shots');
    expect([r.code, r.data.error.code]).toEqual([2, 'NOT_A_FILE']);
    await t.rt.fs.writeFile('/work/broken.json', '{ nope');
    r = await cli(t.rt, 'inspiration', 'import', '--file', '/work/broken.json');
    expect([r.code, r.data.error.code]).toEqual([2, 'BAD_JSON']);
    expect((await cli(t.rt, 'inspiration')).code).toBe(2);
    expect((await cli(t.rt, 'inspiration', 'export')).code).toBe(2);
  });

  it('reports platform errors with their code and the files that already went up, never the key', async () => {
    const t = await setup();
    t.stub.set('POST', '/uploads', err(401, 'UNAUTHORIZED', 'revoked'));
    let r = await t.run();
    expect([r.code, r.data.error.code]).toEqual([1, 'UNAUTHORIZED']);
    expect(t.stub.calls('POST', '/inspirations')).toEqual([]);
    t.stub.clear('POST', '/uploads');
    t.stub.set('POST', '/inspirations', err(429, 'RATE_LIMITED', 'slow', { retryAfterSeconds: 30 }));
    r = await t.run();
    expect(r.code).toBe(1);
    expect(r.data.error.msg).toContain('30 seconds');
    expect(r.data.uploaded).toHaveLength(2); // what did go up is reported
    const noKey = await setup({}, { env: { POPOST_API_KEY: undefined } });
    r = await noKey.run();
    expect([r.code, r.data.error.code]).toEqual([2, 'NO_API_KEY']);
    expect(noKey.stub.requests).toEqual([]);
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(KEY);
  });

  it('fails an upload that the host refuses with a normal error (the storage URL is outside the open API)', async () => {
    const t = await setup({}, { fetchHandler: (stub) => restrictTo(stub.fetch, [`${ORIGIN}${API}/`]) });
    const { code, data } = await t.run();
    expect(code).toBe(1);
    expect(data.error.code).toBe('UPLOAD_FAILED');
    expect(data.error.msg).toContain('does not allow connections');
    expect(t.stub.calls('POST', '/inspirations')).toEqual([]);
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(KEY);
  });

  it('is a plain error, not a crash, when the answer lacks the inspiration id', async () => {
    const t = await setup();
    t.stub.set('POST', '/inspirations', [200, { success: true, data: { inspiration: {} }, error: null }]);
    const { code, data } = await t.run();
    expect([code, data.error.code]).toEqual([1, 'BAD_RESPONSE']);
  });
});
