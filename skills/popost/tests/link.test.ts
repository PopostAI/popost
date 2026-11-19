/**
 * `popost link parse|status`: a social post link parsed by the popost.ai platform into pictures and a PostBundle, against
 * the in-memory fake of the open API. Waiting runs on a fake clock (`Runtime.sleep` / `now`), so nothing really waits.
 */
import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { validateBundle } from '../src/workflow/post-bundle';
import { runCli, type FetchHandler } from '../src/testing/memory';
import { cli, err, everythingWritten, KEY, newScene, ok, ORIGIN, refused, tinyPng, BASE_URL, type Json } from './image-helpers';

const TASK = '5f0c9a1e-3b7d-4c52-9a41-2d6e8f7b1c03';
const OUT = '/work/inputs/link-5f0c9a1e';
const LINK = 'https://www.xiaohongshu.com/explore/abc123';
const CHARGE = 13; // an arbitrary fixture value, not a price

const PNG = tinyPng([255, 0, 0], 4);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), ...new Array(16).fill(1)]);

/** Only the header of a PNG of the given size: enough to be recognised and measured. */
const pngHeader = (width: number, height: number): Uint8Array => {
  const out = Buffer.alloc(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)) >>> 0, 29);
  return new Uint8Array(out);
};

type Reply = ReturnType<typeof ok>;
type Poll = 'pending' | 'running' | 'succeeded' | 'failed' | Reply;

interface SceneOptions {
  polls?: Poll[];
  pics?: string[];
  post?: Record<string, unknown>;
  failure?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  fetchHandler?: (stub: Awaited<ReturnType<typeof newScene>>['stub']) => FetchHandler;
}

/** A picture's signed URL, as the platform issues them: the secret part is in the query string. */
const signed = (name: string): string => `${ORIGIN}/files/${name}?sig=SECRETSIG-${name}`;

const postOf = (pics: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'insp_1',
  platform: 'xiaohongshu',
  sourceUrl: LINK,
  author: { name: '小林', handle: '@lin', extra: 'ignored' },
  title: '通勤穿搭一周不重样',
  text: '第一天：白衬衫 + 西裤。',
  tags: ['#穿搭', '通勤', '穿搭', ' '],
  images: pics.map((name) => ({ url: signed(name), mimeType: 'image/png' })),
  stats: { likes: 12, bogus: -1 },
  publishedAt: '2026-10-01T08:00:00+08:00',
  note: null,
  createdAt: '2026-11-10T00:00:00Z',
  ...over,
});

const linkScene = async (options: SceneOptions = {}) => {
  const scene = await newScene({ env: { POPOST_PROVIDER_CONFIG: '/work/no-config.json', ...options.env }, fetchHandler: options.fetchHandler });
  const { stub } = scene;
  stub.files.set('pic1.png', PNG);
  stub.files.set('pic2.webp', WEBP);
  const state = { polls: options.polls ?? (['succeeded'] as Poll[]), next: 0 };
  const pics = options.pics ?? ['pic1.png', 'pic2.webp'];
  const taskFor = (status: string, extra: Record<string, unknown> = {}) => ({
    id: TASK,
    status,
    created: true,
    chargedCredits: status === 'failed' ? 0 : CHARGE,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:01Z',
    ...(status === 'succeeded' ? { post: options.post ?? postOf(pics) } : {}),
    ...(status === 'failed' ? { error: options.failure === undefined ? { code: 'LINK_POST_NOT_FOUND', message: 'the post is gone' } : options.failure } : {}),
    ...extra,
  });
  stub.set('POST', '/links/parse', () => ok({ task: taskFor('pending') }));
  stub.set('GET', '/links/parse', (req) => {
    if (req.query.id !== TASK) return err(404, 'LINK_IMPORT_NOT_FOUND', 'unknown');
    const poll = state.polls[Math.min(state.next++, state.polls.length - 1)]!;
    return typeof poll === 'string' ? ok({ task: taskFor(poll) }) : poll;
  });
  const clock = { now: Date.UTC(2026, 10, 10), sleeps: [] as number[] };
  const rt = {
    ...scene.rt,
    now: () => new Date(clock.now),
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  };
  return { ...scene, rt, state, clock, taskFor, run: (...args: string[]) => cli(rt, 'link', ...args, ...(args[0] === 'parse' && !args.includes('--dry-run') ? ['--confirm', '--max-credits', String(CHARGE)] : [])) };
};

type Scene = Awaited<ReturnType<typeof linkScene>>;

const noKey = async (t: Scene) => {
  for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(KEY);
};
const files = async (t: Scene, dir: string): Promise<string[]> => ((await t.rt.fs.stat(dir)) ? t.rt.fs.readdir(dir) : []);
const gets = (t: Scene) => t.stub.calls('GET', '/links/parse');

describe('inspiration add', () => {
  const supported = [
    ['tiktok', 'https://www.tiktok.com/@creator/video/7347295908340460830'],
    ['douyin', 'https://www.douyin.com/video/7347295908340460830'],
    ['x', 'https://x.com/creator/status/7347295908340460830'],
    ['xiaohongshu', 'https://www.xiaohongshu.com/explore/64f11e6e0000000034028ed6'],
    ['instagram', 'https://www.instagram.com/p/C1AbCdEfG12/'],
  ] as const;

  it.each(supported)('saves a %s post without creating local files or exposing signed picture URLs', async (platform, url) => {
    const t = await linkScene({ post: postOf(['pic1.png', 'pic2.webp'], { platform, sourceUrl: url }) });
    const { code, data } = await cli(t.rt, 'inspiration', 'add', url, '--confirm', '--max-credits', String(CHARGE));
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({
      ok: true,
      task: { id: TASK, status: 'succeeded', created: true, chargedCredits: CHARGE },
      inspiration: { id: 'insp_1', platform, sourceUrl: url, imageCount: 2 },
    });
    expect(t.stub.calls('POST', '/links/parse')[0]?.json).toEqual({ url, maxCredits: CHARGE });
    expect(t.stub.requests.filter((r) => r.path.startsWith('/files/'))).toHaveLength(0);
    expect(await files(t, '/work/inputs')).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('SECRETSIG');
  });

  it('requires authorization and uses the requested charge ceiling', async () => {
    const t = await linkScene();
    const missing = await cli(t.rt, 'inspiration', 'add', LINK);
    expect(missing.code).toBe(2);
    expect(missing.data.error).toContain('inspiration quote');
    const badCeiling = await cli(t.rt, 'inspiration', 'add', LINK, '--confirm', '--max-credits', '-1');
    expect(badCeiling.code).toBe(2);
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(0);
  });

  it('can preview the save without network access or an API key', async () => {
    const t = await linkScene({ env: { POPOST_API_KEY: undefined } });
    const { code, data } = await cli(t.rt, 'inspiration', 'add', LINK, '--dry-run');
    expect(code).toBe(0);
    expect(data).toMatchObject({ ok: true, dryRun: true, download: null, saveTo: 'My Inspirations' });
    expect(t.stub.requests).toHaveLength(0);
  });

  it('resumes an existing task without posting again', async () => {
    const t = await linkScene();
    const { code, data } = await cli(t.rt, 'inspiration', 'status', TASK);
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, inspiration: { id: 'insp_1' } });
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(0);
    expect(gets(t)).toHaveLength(1);
  });

  it('returns the correct resume command for an unfinished save', async () => {
    const t = await linkScene({ polls: ['pending'] });
    const { code, data } = await cli(t.rt, 'inspiration', 'add', LINK, '--confirm', '--max-credits', String(CHARGE), '--timeout', '1');
    expect(code).toBe(1);
    expect(data).toMatchObject({ code: 'WAIT_TIMEOUT', resume: `popost inspiration status ${TASK}` });
  });
});

describe('link parse', () => {
  it('creates the task, polls until it succeeded, downloads the pictures in order and writes a bundle the Skill reads', async () => {
    const t = await linkScene({ polls: ['pending', 'running', 'succeeded'] });
    const { code, data } = await t.run('parse', LINK);
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({
      ok: true,
      task: { id: TASK, status: 'succeeded', created: true, chargedCredits: CHARGE },
      bundle: `${OUT}/postbundle.json`,
      images: [`${OUT}/01.png`, `${OUT}/02.webp`],
      post: { platform: 'xiaohongshu', title: '通勤穿搭一周不重样', sourceUrl: LINK, imageCount: 2, inspirationId: 'insp_1' },
    });
    expect(data.next).toBe(`popost validate --file ${OUT}/postbundle.json && popost import --file ${OUT}/postbundle.json`);

    const posts = t.stub.calls('POST', '/links/parse');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.json).toEqual({ url: LINK, maxCredits: CHARGE });
    expect(posts[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'x-popost-client': 'skill', 'content-type': 'application/json' });
    expect(gets(t).map((r) => r.query.id)).toEqual([TASK, TASK, TASK]);
    expect(t.clock.sleeps).toEqual([2000, 2000, 2000]);
    const pictures = t.stub.requests.filter((r) => r.path.startsWith('/files/'));
    expect(pictures).toHaveLength(2);
    for (const r of pictures) expect(r.headers.authorization).toBeUndefined(); // the picture hosts never see the platform key
    expect(t.rt.err.join('')).toContain(TASK); // the id is on stderr as soon as the task exists

    expect(await t.rt.fs.readFile(`${OUT}/01.png`)).toEqual(PNG);
    expect(await t.rt.fs.readFile(`${OUT}/02.webp`)).toEqual(WEBP);
    const bundle = JSON.parse(await t.rt.fs.readText(`${OUT}/postbundle.json`));
    expect(validateBundle(bundle)).toEqual([true, []]);
    expect(bundle).toMatchObject({
      schema: 'postbundle.v1',
      platform: 'xiaohongshu',
      sourceURL: LINK,
      title: '通勤穿搭一周不重样',
      body: '第一天：白衬衫 + 西裤。',
      tags: ['穿搭', '通勤'],
      pageOrder: [1, 2],
      ratio: '1:1',
      parseStatus: 'ready',
      auth: { required: false, authorized: true },
      errors: [],
      missing: [],
      author: { name: '小林', handle: '@lin' },
      stats: { likes: 12 },
      publishedAt: '2026-10-01T08:00:00+08:00',
      resources: [
        { id: 'img1', kind: 'image', path: '01.png', mimeType: 'image/png', width: 4, height: 4 },
        { id: 'img2', kind: 'image', path: '02.webp', mimeType: 'image/webp' },
      ],
    });
    expect(bundle.author).toEqual({ name: '小林', handle: '@lin' });
    expect(bundle.stats).toEqual({ likes: 12 });
    expect(JSON.stringify(bundle)).not.toContain('SECRETSIG'); // signed URLs are never kept

    // what the rest of the Skill does with it
    expect((await cli(t.rt, 'validate', '--file', `${OUT}/postbundle.json`)).data).toMatchObject({ ok: true, valid: true });
    expect((await cli(t.rt, 'import', '--file', `${OUT}/postbundle.json`)).data).toMatchObject({ ok: true, buildable: true, blockers: [] });
    const plan = await cli(t.rt, 'inspiration', 'import', '--file', `${OUT}/postbundle.json`, '--dry-run');
    expect(plan.code, JSON.stringify(plan.data)).toBe(0);
    expect(plan.data.uploads).toHaveLength(2);
    expect(plan.data.request.body).toMatchObject({ platform: 'xiaohongshu', sourceUrl: LINK, tags: ['穿搭', '通勤'] });
    await noKey(t);
  });

  it('sends the note, and falls back to the link the user gave when the post names no source', async () => {
    const t = await linkScene({ post: postOf(['pic1.png'], { sourceUrl: undefined, note: undefined }) });
    const { code, data } = await t.run('parse', ` ${LINK} `, '--note', ' 参考配色 ', '--out', 'saved/post');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(t.stub.calls('POST', '/links/parse')[0]!.json).toEqual({ url: LINK, note: '参考配色', maxCredits: CHARGE });
    const bundle = JSON.parse(await t.rt.fs.readText('/work/saved/post/postbundle.json'));
    expect(bundle).toMatchObject({ sourceURL: LINK, note: '参考配色' });
    expect(data.bundle).toBe('/work/saved/post/postbundle.json');
    expect(await files(t, OUT)).toEqual([]); // --out replaces the default folder
  });

  it('names the files after the real picture type and takes the ratio from the first picture', async () => {
    const t = await linkScene({ pics: ['wide.png', 'pic2.webp'] });
    t.stub.files.set('wide.png', pngHeader(1079, 1439));
    const { data } = await t.run('parse', LINK);
    expect(data.images).toEqual([`${OUT}/01.png`, `${OUT}/02.webp`]);
    expect(JSON.parse(await t.rt.fs.readText(`${OUT}/postbundle.json`))).toMatchObject({ ratio: '3:4', resources: [{ width: 1079, height: 1439 }, {}] });
  });

  it('reuses a link that is already saved: no polling, no new charge', async () => {
    const t = await linkScene();
    t.stub.set('POST', '/links/parse', ok({ task: t.taskFor('succeeded', { created: false, chargedCredits: 0 }) }));
    const { code, data } = await t.run('parse', LINK);
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.task).toEqual({ id: TASK, status: 'succeeded', created: false, chargedCredits: 0 });
    expect(gets(t)).toEqual([]);
    expect(t.clock.sleeps).toEqual([]);
    expect(t.rt.err.join('')).toBe('');
    expect(data.images).toHaveLength(2);
  });

  it('reports a failed task with the platform code and message', async () => {
    const t = await linkScene({ polls: ['running', 'failed'] });
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toEqual({ ok: false, code: 'LINK_POST_NOT_FOUND', error: 'the post is gone', task: { id: TASK, status: 'failed', chargedCredits: 0 } });
    expect(await files(t, '/work/inputs')).toEqual([]);
    expect(t.stub.requests.some((r) => r.path.startsWith('/files/'))).toBe(false);
  });

  it('words a failed task that has no message from its code, and scrubs a key that the message echoes', async () => {
    const t = await linkScene({ polls: ['failed'], failure: { code: 'LINK_IMAGES_FAILED' } });
    expect((await t.run('parse', LINK)).data).toMatchObject({ code: 'LINK_IMAGES_FAILED', error: '帖子的图片获取失败' });
    const echo = await linkScene({ polls: ['failed'], failure: { code: 'LINK_PARSE_FAILED', message: `bad token ${KEY}` } });
    const { stdout } = await echo.run('parse', LINK);
    expect(stdout).toContain('[REDACTED]');
    await noKey(echo);
  });

  it.each([
    [400, 'LINK_UNSUPPORTED', undefined, '不支持这个链接'],
    [402, 'INSUFFICIENT_CREDITS', { required: 20, balance: 3 }, '积分不足'],
    [429, 'RATE_LIMITED', { retryAfterSeconds: 30 }, '30 秒'],
    [401, 'UNAUTHORIZED', undefined, '账户连接已失效'],
    [426, 'CLI_VERSION_TOO_OLD', { minVersion: '9.9.9' }, '9.9.9'],
  ])('refuses %s %s at once: no task, no polling, nothing sent twice', async (status, errorCode, details, fragment) => {
    const t = await linkScene();
    t.stub.set('POST', '/links/parse', err(status, errorCode, 'server text', details));
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: errorCode });
    expect(data.error).toContain(fragment);
    expect(data).not.toHaveProperty('task');
    expect(data).not.toHaveProperty('resume');
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(1);
    expect(gets(t)).toEqual([]);
    if (errorCode === 'INSUFFICIENT_CREDITS') expect(data.error).not.toContain('报价');
    await noKey(t);
  });

  it.each([
    ['a gateway error without an envelope', () => [504, 'gateway timeout'] as const],
    ['the platform TIMEOUT', () => err(504, 'TIMEOUT', 'slow')],
    ['an answer without a task', () => ok({})],
    ['an answer whose task has no usable id', () => ok({ task: { id: '../x', status: 'pending' } })],
    ['an unreadable body', () => [200, '<html>proxy</html>'] as const],
  ])('does not know the outcome after %s: reports it, never retries, and says rerunning is safe', async (_label, reply) => {
    const t = await linkScene();
    t.stub.set('POST', '/links/parse', reply() as Reply);
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'UNCERTAIN' });
    expect(data.error).toMatch(/不确定|无法确定/);
    expect(data.error).toContain('重新运行同一条命令是安全的');
    expect(data).not.toHaveProperty('task');
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(1);
    expect(gets(t)).toEqual([]);
  });

  it('does not know the outcome after a dropped connection either, but a refused connection is known to charge nothing', async () => {
    const dropped = await linkScene({ fetchHandler: (stub) => async (request) => (request.method === 'POST' ? Promise.reject(new TypeError('fetch failed')) : stub.fetch(request)) });
    let r = await dropped.run('parse', LINK);
    expect([r.code, r.data.code]).toEqual([1, 'UNCERTAIN']);
    const refusedScene = await linkScene({ fetchHandler: () => async () => refused() });
    r = await refusedScene.run('parse', LINK);
    expect([r.code, r.data.code]).toEqual([1, 'NETWORK']);
    expect(r.data.error).toContain('未产生费用');
  });

  it('stops at the timeout with the task id and how to resume; `link status` then finishes it without creating anything', async () => {
    const t = await linkScene({ polls: ['running'] });
    const { code, data } = await t.run('parse', LINK, '--timeout', '10');
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'WAIT_TIMEOUT', task: { id: TASK, status: 'running', chargedCredits: CHARGE }, resume: `popost link status ${TASK}` });
    expect(data.error).toContain(`popost link status ${TASK}`);
    expect(data.error).toContain('仍会在平台完成');
    expect(gets(t)).toHaveLength(5);
    expect(t.clock.sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);

    t.state.polls = ['running', 'succeeded'];
    t.state.next = 0;
    const done = await t.run('status', TASK);
    expect(done.code, JSON.stringify(done.data)).toBe(0);
    expect(done.data).toMatchObject({ ok: true, task: { id: TASK, status: 'succeeded', created: true, chargedCredits: CHARGE }, bundle: `${OUT}/postbundle.json` });
    expect(t.stub.calls('POST', '/links/parse')).toHaveLength(1); // status never creates a task
    expect(await files(t, OUT)).toEqual(['01.png', '02.webp', 'postbundle.json']);
    expect(validateBundle(JSON.parse(await t.rt.fs.readText(`${OUT}/postbundle.json`)))[0]).toBe(true);
  });

  it('keeps the --out of the call in the resume command', async () => {
    const t = await linkScene({ polls: ['running'] });
    const { data } = await t.run('parse', LINK, '--timeout', '2', '--out', 'my posts/a');
    expect(data.resume).toBe(`popost link status ${TASK} --out 'my posts/a'`);
  });

  it('tolerates a few failed polls in a row, then gives up and says the task may still finish', async () => {
    const flaky = await linkScene({ polls: [err(503, 'SERVICE_UNAVAILABLE'), [502, 'bad gateway'], err(429, 'RATE_LIMITED'), 'succeeded'] });
    const done = await flaky.run('parse', LINK);
    expect(done.code, JSON.stringify(done.data)).toBe(0);
    expect(gets(flaky)).toHaveLength(4);

    let drops = 0;
    const lossy = await linkScene({ polls: ['succeeded'], fetchHandler: (stub) => async (request) => (request.method === 'GET' && request.url.includes('/links/parse') && drops++ < 2 ? refused() : stub.fetch(request)) });
    expect((await lossy.run('parse', LINK)).code).toBe(0);

    const down = await linkScene({ polls: [err(503, 'SERVICE_UNAVAILABLE', 'down')] });
    const { code, data } = await down.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'POLL_FAILED', task: { id: TASK, status: 'pending' }, resume: `popost link status ${TASK}` });
    expect(data.error).toContain('5 次');
    expect(data.error).toContain('仍会在平台完成');
    expect(gets(down)).toHaveLength(5);
  });

  it('backs off for as long as a rate-limited poll asks, without counting it as a failure', async () => {
    const limited = err(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 7 });
    const t = await linkScene({ polls: [limited, limited, limited, limited, limited, limited, err(429, 'RATE_LIMITED'), 'succeeded'] });
    const done = await t.run('parse', LINK);
    expect(done.code, JSON.stringify(done.data)).toBe(0);
    expect(gets(t)).toHaveLength(8);
    // the usual interval first, the asked 7 s after each of six refusals, 10 s after the one that names no wait
    expect(t.clock.sleeps).toEqual([2000, 7000, 7000, 7000, 7000, 7000, 7000, 10_000]);

    const stuck = await linkScene({ polls: [err(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 3600 })] });
    const { code, data } = await stuck.run('parse', LINK, '--timeout', '100');
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'WAIT_TIMEOUT', resume: `popost link status ${TASK}` });
    expect(stuck.clock.sleeps).toEqual([2000, 60_000, 38_000]);
  });

  it('stops at once on a poll answer that will not change, naming the task so it can be resumed', async () => {
    const t = await linkScene({ polls: [err(401, 'UNAUTHORIZED', 'revoked')] });
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'UNAUTHORIZED', task: { id: TASK, status: 'pending', chargedCredits: CHARGE }, resume: `popost link status ${TASK}` });
    expect(gets(t)).toHaveLength(1);
    await noKey(t);
  });

  it('keeps what was downloaded when a picture fails, and says link status downloads again', async () => {
    const t = await linkScene({ pics: ['pic1.png', 'gone.png', 'pic2.webp'] });
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'DOWNLOAD_FAILED', task: { id: TASK, status: 'succeeded', chargedCredits: CHARGE }, images: [`${OUT}/01.png`], resume: `popost link status ${TASK}` });
    expect(data.error).toContain('第 2 张图片');
    expect(data.error).toContain('HTTP 404');
    expect(data.error).toContain(`popost link status ${TASK}`);
    expect(data.error).toContain('重新签发');
    expect(await files(t, OUT)).toEqual(['01.png']); // no bundle, no half-written file
    expect(JSON.stringify(data)).not.toContain('sig=');
    expect(JSON.stringify(data)).not.toContain('SECRETSIG');
    expect(t.rt.err.join('')).not.toContain('SECRETSIG');

    t.stub.files.set('gone.png', PNG);
    const again = await t.run('status', TASK);
    expect(again.code, JSON.stringify(again.data)).toBe(0);
    expect(await files(t, OUT)).toEqual(['01.png', '02.png', '03.webp', 'postbundle.json']);
  });

  it('refuses a download that is not a picture, never trusting the name or the URL', async () => {
    const t = await linkScene({ pics: ['pic1.png', 'page.png'] });
    t.stub.files.set('page.png', new TextEncoder().encode('<html>login</html>'));
    const { code, data } = await t.run('parse', LINK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ code: 'DOWNLOAD_FAILED', images: [`${OUT}/01.png`] });
    expect(data.error).toContain('不是 PNG');
    expect(await files(t, OUT)).toEqual(['01.png']);
  });

  it('prints the post with its remote URLs and downloads nothing with --no-download', async () => {
    const t = await linkScene();
    const { code, data } = await t.run('parse', LINK, '--no-download');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, task: { id: TASK, status: 'succeeded' }, post: { platform: 'xiaohongshu', imageCount: 2, text: '第一天：白衬衫 + 西裤。', tags: ['穿搭', '通勤'] } });
    expect(data.post.images.map((i: Json) => [i.index, i.url])).toEqual([[1, signed('pic1.png')], [2, signed('pic2.webp')]]);
    expect(data.note).toContain('很快失效');
    expect(data.note).toContain(`popost link status ${TASK}`);
    expect(data).not.toHaveProperty('bundle');
    expect(await files(t, '/work/inputs')).toEqual([]);
    expect(t.stub.requests.some((r) => r.path.startsWith('/files/'))).toBe(false);
  });

  it('marks a post without pictures missing_resources: valid, but not buildable', async () => {
    const t = await linkScene({ post: postOf([]) });
    const { code, data } = await t.run('parse', LINK);
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ images: [], post: { imageCount: 0 } });
    expect(data.note).toContain('missing_resources');
    const bundle = JSON.parse(await t.rt.fs.readText(`${OUT}/postbundle.json`));
    expect(bundle).toMatchObject({ parseStatus: 'missing_resources', pageOrder: [], ratio: null, resources: [], missing: ['resources'] });
    expect((await cli(t.rt, 'validate', '--file', `${OUT}/postbundle.json`)).code).toBe(0);
    expect((await cli(t.rt, 'import', '--file', `${OUT}/postbundle.json`)).code).toBe(2);
  });

  it.each([
    ['a platform of none of the five', { platform: 'myspace' }, 'platform'],
    ['neither a source URL nor one the user gave', { sourceUrl: 'ftp://x', platform: 'x' }, 'sourceUrl'],
    ['a picture without an address', { images: [{ mimeType: 'image/png' }] }, '第 1 张图片缺少地址'],
  ])('refuses a task result with %s before downloading anything', async (_label, over, fragment) => {
    const t = await linkScene({ post: postOf(['pic1.png'], over) });
    const { code, data } = await t.run('status', TASK);
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 'BAD_RESPONSE', task: { id: TASK } });
    expect(data.error).toContain(fragment);
    expect(t.stub.requests.some((r) => r.path.startsWith('/files/'))).toBe(false);
  });

  it('is offline without a key in a dry run and shows the key as a variable name', async () => {
    const t = await linkScene({ env: { POPOST_API_KEY: undefined } });
    const { code, data } = await t.run('parse', LINK, '--note', '备注', '--dry-run');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, dryRun: true, request: { method: 'POST', url: `${BASE_URL}/links/parse`, body: { url: LINK, note: '备注' } } });
    expect(data.request.headers.Authorization).toBe('Bearer $POPOST_API_KEY');
    expect(data.then.url).toBe(`${BASE_URL}/links/parse?id=<task id>`);
    expect(data.download.dir).toBe('/work/inputs/link-<task id 前 8 位>');
    expect(t.stub.requests).toEqual([]);
    expect(t.clock.sleeps).toEqual([]);
  });

  it.each([
    ['a link that is not http(s)', ['parse', 'ftp://example.com/post'], '链接必须是'],
    ['text that is no link', ['parse', 'not a link'], '链接必须是'],
    ['a note over 2000 characters', ['parse', LINK, '--note', '长'.repeat(2001)], '--note'],
    ['a timeout of zero', ['parse', LINK, '--timeout', '0'], '--timeout'],
    ['a timeout over an hour', ['status', TASK, '--timeout', '3601'], '--timeout'],
    ['an output path that is a file', ['parse', LINK, '--out', '/work/file.txt'], '--out'],
    ['a task id that is no id', ['status', '../etc/passwd'], '任务 id'],
  ])('rejects %s locally (exit 2) before any request', async (_label, args, fragment) => {
    const t = await linkScene();
    await t.rt.fs.writeFile('/work/file.txt', 'x');
    const { code, data } = await t.run(...args);
    expect(code, JSON.stringify(data)).toBe(2);
    expect(data).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(data.error).toContain(fragment);
    expect(data).not.toHaveProperty('task');
    expect(t.stub.requests).toEqual([]);
  });

  it('exits 2 for a missing key or a bad option value, without a request', async () => {
    const t = await linkScene({ env: { POPOST_API_KEY: undefined } });
    const { code, data } = await t.run('parse', LINK);
    expect([code, data.code]).toEqual([2, 'NO_API_KEY']);
    expect(data.error).toContain('POPOST_API_KEY');
    expect((await t.run('status', TASK)).code).toBe(2);
    expect(t.stub.requests).toEqual([]);
    expect((await t.run('parse', LINK, '--timeout', 'soon')).code).toBe(2);
    expect((await t.run('parse')).code).toBe(2);
    expect((await t.run('status')).code).toBe(2);
    expect((await t.run()).code).toBe(2);
    expect((await t.run('watch')).code).toBe(2);
    expect((await t.run('parse', '--help')).code).toBe(0);
  });
});

describe('link status', () => {
  it('looks at once, waits for the task and downloads; an unknown task is reported with its own code', async () => {
    const t = await linkScene({ polls: ['running', 'succeeded'] });
    const { code, data } = await t.run('status', TASK, '--out', 'got');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ ok: true, bundle: '/work/got/postbundle.json' });
    expect(t.clock.sleeps).toEqual([2000]); // no pause before the first look
    expect(t.stub.calls('POST', '/links/parse')).toEqual([]);

    const unknown = await linkScene();
    unknown.stub.set('GET', '/links/parse', err(404, 'LINK_IMPORT_NOT_FOUND', 'no such task'));
    const missing = await unknown.run('status', TASK);
    expect(missing.code).toBe(1);
    expect(missing.data).toMatchObject({ ok: false, code: 'LINK_IMPORT_NOT_FOUND', task: { id: TASK } });
    expect(missing.data.error).toContain('找不到');
    expect(missing.data).not.toHaveProperty('resume');
  });

  it('shows a finished task as it is: failed stays failed, --no-download only lists the pictures', async () => {
    const failed = await linkScene({ polls: ['failed'] });
    expect((await failed.run('status', TASK)).data).toMatchObject({ ok: false, code: 'LINK_POST_NOT_FOUND' });
    const t = await linkScene();
    const { data } = await t.run('status', TASK, '--no-download');
    expect(data.post.images).toHaveLength(2);
    expect(data.note).toContain(`popost link status ${TASK}`);
    expect(await files(t, '/work/inputs')).toEqual([]);
  });

  it('answers a mismatched task id as a bad response', async () => {
    const t = await linkScene();
    t.stub.set('GET', '/links/parse', ok({ task: { ...t.taskFor('succeeded'), id: 'another-task' } }));
    const { code, data } = await t.run('status', TASK);
    expect([code, data.code]).toEqual([1, 'BAD_RESPONSE']);
  });
});

describe('link in the command table', () => {
  it('is listed under sources', async () => {
    const t = await linkScene();
    const { stdout } = await runCli(t.rt, ['--help']);
    expect(stdout).toMatch(/sources:.*\blink\b/);
  });
});
