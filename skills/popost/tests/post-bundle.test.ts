/** `ticket`, `validate`, `import` and the PostBundle gate (ports of test_post_bundle.py and test_cli_exit_codes.py). */
import { describe, expect, it } from 'vitest';
import * as bundles from '../src/workflow/post-bundle';
import { runCli, type TestRuntime } from '../src/testing/memory';
import { FIXTURES, newProject, newRuntime } from './workflow-helpers';

const ASSET = `${FIXTURES}/sample-asset.png`;

const readyBundle = (over: Record<string, unknown> = {}, path: string | null = ASSET, authorized = true) => ({
  schema: 'postbundle.v1',
  platform: 'xiaohongshu',
  sourceURL: 'https://example.com/p/123',
  title: '真实标题',
  body: '正文',
  tags: ['a', 'b'],
  music: { title: '', url: '' },
  pageOrder: [1, 2],
  ratio: '3:4',
  resources: [{ id: 'r1', kind: 'image', path, url: null, license: '' }],
  parseStatus: 'ready',
  auth: { required: true, authorized, note: '' },
  errors: [],
  missing: [],
  ...over,
});

const put = (rt: TestRuntime, path: string, value: unknown) => rt.fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));

describe('pending ticket', () => {
  it('only records the URL and platform: pending, nothing fetched, not authorized', async () => {
    const rt = await newRuntime();
    const ticket = bundles.makePendingTicket(rt, ' https://x.com/post/1 ', ' X ');
    expect(ticket).toMatchObject({ schema: 'postbundle.v1', platform: 'x', sourceURL: 'https://x.com/post/1', parseStatus: 'pending', resources: [], ratio: null, pageOrder: [1] });
    expect(ticket.auth).toEqual({ required: true, authorized: false, note: 'future parse service not connected; ticket only, nothing fetched' });
    expect((ticket.errors as string[])[0]).toContain('parse service pending');
    expect(ticket.missing).toEqual(['title', 'body', 'resources']);
    expect(ticket.createdAt).toBe('2026-11-05T00:00:00+00:00');
    expect(() => bundles.makePendingTicket(rt, 'https://x.com', 'wechat')).toThrow("platform must be one of tiktok/xiaohongshu/instagram/douyin/x/youtube, got 'wechat'");
    expect(() => bundles.makePendingTicket(rt, '  ', 'x')).toThrow('sourceURL must not be empty');
  });

  it('writes the file with --out and prints the bundle', async () => {
    const rt = await newRuntime();
    const { code } = await runCli(rt, ['ticket', '--url', 'https://v.douyin.com/AbC/', '--platform', 'douyin', '--out', 'out/ticket.json']);
    expect(code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, route: 'pending-ticket', bundle: { parseStatus: 'pending', platform: 'douyin' } });
    expect(JSON.parse(await rt.fs.readText('/work/out/ticket.json'))).toMatchObject({ parseStatus: 'pending' });
  });

  it('takes only a post link of the platform it names, short links and sub-domains included', async () => {
    const rt = await newRuntime();
    const links: readonly (readonly [string, string])[] = [
      ['https://www.tiktok.com/@a/photo/1', 'tiktok'],
      ['https://vm.tiktok.com/ZM1/', 'tiktok'],
      ['http://xhslink.com/a/b', 'xiaohongshu'],
      ['https://www.xiaohongshu.com/explore/1', 'xiaohongshu'],
      ['https://www.iesdouyin.com/share/note/1', 'douyin'],
      ['https://www.instagram.com/p/x/', 'instagram'],
      ['https://twitter.com/a/status/1', 'x'],
      ['https://www.youtube.com/watch?v=AbCdEfGhIj0', 'youtube'],
      ['https://youtu.be/AbCdEfGhIj0', 'youtube'],
      ['https://m.youtube.com/shorts/AbCdEfGhIj0', 'youtube'],
    ];
    for (const [url, platform] of links) expect(bundles.makePendingTicket(rt, url, platform).platform).toBe(platform);
    expect(() => bundles.makePendingTicket(rt, 'https://www.tiktok.com/@a/video/1', 'douyin')).toThrow(
      'https://www.tiktok.com/@a/video/1 is a tiktok link, not douyin: pass --platform tiktok',
    );
    expect(() => bundles.makePendingTicket(rt, 'https://example.com/x', 'tiktok')).toThrow(
      'https://example.com/x is not a tiktok link (expected a host under tiktok.com)',
    );
    expect(() => bundles.makePendingTicket(rt, 'https://notx.com/1', 'x')).toThrow('is not a x link');
    expect(() => bundles.makePendingTicket(rt, 'ftp://x.com/1', 'x')).toThrow("--url must be a web link (https://…), got 'ftp://x.com/1'");
    expect((await runCli(rt, ['ticket', '--url', 'https://example.com/x', '--platform', 'tiktok'])).code).toBe(2);
  });

  it('exits 2 on a platform outside the five, a blank URL or missing flags', async () => {
    const rt = await newRuntime();
    expect((await runCli(rt, ['ticket', '--url', 'u', '--platform', 'wechat'])).code).toBe(2);
    expect((await runCli(rt, ['ticket', '--x'])).code).toBe(2);
    expect((await runCli(rt, ['ticket'])).stderr).toContain('--url, --platform');
    expect((await runCli(rt, ['ticket', '--url', ' ', '--platform', 'x'])).code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, error: { code: 'BAD_ARGS', msg: 'sourceURL must not be empty' } });
  });
});

describe('validate', () => {
  it('accepts a good bundle and names what is wrong with a bad one', () => {
    expect(bundles.validateBundle(readyBundle())).toEqual([true, []]);
    const [ok, errors] = bundles.validateBundle(readyBundle({ schema: 'nope' }));
    expect(ok).toBe(false);
    expect(errors).toEqual(["schema must be 'postbundle.v1'"]);
    expect(bundles.validateBundle([1])).toEqual([false, ['the bundle must be a JSON object']]);
  });

  it('checks every field the way the Python module did', () => {
    const bad = readyBundle({
      platform: 'wechat',
      sourceURL: ' ',
      parseStatus: 'weird',
      title: 1,
      tags: ['a', 2],
      music: { title: 1 },
      pageOrder: [0, 'x'],
      ratio: 3,
      auth: { required: 'yes' },
      resources: [1, { id: '', kind: 'doc' }, { id: 'd', kind: 'image' }, { id: 'd', kind: 'image' }],
      errors: 'x',
      missing: [1],
    });
    expect(bundles.validateBundle(bad)[1]).toEqual([
      "platform must be one of tiktok/xiaohongshu/instagram/douyin/x/youtube, got 'wechat'",
      'sourceURL must be a non-empty string',
      'parseStatus must be one of pending/ready/auth_failed/missing_resources/error',
      'title must be a string',
      'tags must be an array of strings',
      'music must be {title:str, url:str}',
      'pageOrder must be an array of positive integers',
      "ratio must be a 'W:H' string or null",
      'auth must be {required:bool, authorized:bool, note:str}',
      'resources[0] must be an object',
      'resources[1].id must be a non-empty string',
      'resources[1].kind must be one of image/video/music',
      "resources[3].id is a duplicate: 'd'",
      'errors must be an array of strings',
      'missing must be an array of strings',
    ]);
    expect(bundles.validateBundle(readyBundle({ resources: 'nope' }))[1]).toEqual(['resources must be an array']);
    // absent optional fields are fine, an explicit null is not
    expect(bundles.validateBundle(readyBundle({ tags: undefined, music: undefined, errors: undefined }))[0]).toBe(true);
    expect(bundles.validateBundle(readyBundle({ tags: null, music: null, auth: null }))[1]).toEqual([
      'tags must be an array of strings',
      'music must be {title:str, url:str}',
      'auth must be {required:bool, authorized:bool, note:str}',
    ]);
  });

  it('prints {ok, valid, errors} and exits 0 or 2', async () => {
    const rt = await newRuntime();
    await put(rt, '/work/good.json', readyBundle());
    expect((await runCli(rt, ['validate', '--file', 'good.json'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, valid: true, errors: [] });
    await put(rt, '/work/bad.json', readyBundle({ schema: 'x' }));
    expect((await runCli(rt, ['validate', '--file', 'bad.json'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, valid: false, errors: ["schema must be 'postbundle.v1'"] });
  });
});

describe('buildable gate', () => {
  const evaluate = async (bundle: Record<string, unknown>, baseDir: string | null = null) => {
    const rt = await newRuntime();
    return bundles.evaluateBuildable(rt, bundle, baseDir);
  };

  it('does not treat a pending ticket as buildable', async () => {
    const rt = await newRuntime();
    const verdict = await bundles.evaluateBuildable(rt, bundles.makePendingTicket(rt, 'https://x.com/1', 'x'));
    expect(verdict.buildable).toBe(false);
    expect(verdict.blockers).toEqual([
      "parseStatus='pending' is not ready (the parse is not finished; a build would be fake)",
      'auth.required is set and authorized=false (authorization is missing; do not build)',
      'the bundle still declares a missing item: title',
      'the bundle still declares a missing item: body',
      'the bundle still declares a missing item: resources',
    ]);
  });

  it('blocks a missing authorization, a missing image and a url without a licence', async () => {
    expect((await evaluate(readyBundle({}, ASSET, false))).blockers).toEqual(['auth.required is set and authorized=false (authorization is missing; do not build)']);
    const missing = await evaluate(readyBundle({}, '/nonexistent/missing.png'), FIXTURES);
    expect(missing).toEqual({ buildable: false, blockers: ["resource r1 has no picture: the local file '/nonexistent/missing.png' does not exist"] });
    const resources = [
      { id: 'a', kind: 'image', url: 'http://x/y.png' },
      { id: 'b', kind: 'video', url: 'http://x/y', license: 'cc' },
      { id: 'c', kind: 'music' },
    ];
    expect((await evaluate(readyBundle({ resources }))).blockers).toEqual([
      'resource a has only a url and no license or attribution: authorization is missing',
      'resource c has neither a path nor a url: the picture is missing, which blocks the build',
    ]);
  });

  it('is buildable when ready, authorized and every file is there (relative to the bundle)', async () => {
    const verdict = await evaluate(readyBundle({}, 'sample-asset.png'), FIXTURES);
    expect(verdict).toEqual({ buildable: true, blockers: [] });
    expect((await evaluate(readyBundle({ auth: { required: false } }, 'sample-asset.png'), FIXTURES)).buildable).toBe(true);
  });

  it('keeps the future parse service a placeholder: no endpoint, no client', () => {
    expect(bundles.serviceConfig()).toMatchObject({ status: 'pending', endpoint: null, authEnv: null });
  });
});

describe('import', () => {
  it('exits 2 for a pending ticket and prints what blocks it', async () => {
    const rt = await newRuntime();
    await runCli(rt, ['ticket', '--url', 'https://x.com/1', '--platform', 'x', '--out', 't.json']);
    expect((await runCli(rt, ['import', '--file', 't.json'])).code).toBe(2); // pending cannot build
    expect(rt.json()).toMatchObject({ ok: true, buildable: false });
    expect((rt.json().blockers as string[])[0]).toContain('parseStatus');
  });

  it('exits 0 for a ready bundle, resolving files relative to the bundle', async () => {
    const rt = await newRuntime();
    await rt.fs.writeFile('/work/img.png', 'x');
    await put(rt, '/work/sub/b.json', readyBundle({}, '../img.png'));
    expect((await runCli(rt, ['import', '--file', 'sub/b.json'])).code).toBe(0);
    expect(rt.json()).toEqual({ ok: true, buildable: true, blockers: [] });
  });

  it('exits 2 with errors for a structurally invalid bundle', async () => {
    const rt = await newRuntime();
    await put(rt, '/work/b.json', readyBundle({ schema: 'x' }));
    expect((await runCli(rt, ['import', '--file', 'b.json'])).code).toBe(2);
    expect(rt.json()).toEqual({ ok: false, buildable: false, errors: ["schema must be 'postbundle.v1'"] });
  });

  it('reports a missing file, a directory and malformed JSON as error codes, exit 2', async () => {
    const rt = await newRuntime();
    expect((await runCli(rt, ['import', '--file', '/tmp/__nope_xyz__.json'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect((await runCli(rt, ['validate', '--file', '/tmp/__nope_xyz__.json'])).code).toBe(2);
    await rt.fs.mkdir('/work/dir');
    expect((await runCli(rt, ['import', '--file', 'dir'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, error: { code: 'NOT_A_FILE' } });
    await put(rt, '/work/bad.json', '{not json');
    expect((await runCli(rt, ['import', '--file', 'bad.json'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
  });
});

describe('a bundle attached to a project', () => {
  const attach = async (rt: TestRuntime, bundle: unknown) => {
    await put(rt, '/work/bundle.json', bundle);
    expect((await runCli(rt, ['attach-bundle', '--dir', 'project', '--bundle', 'bundle.json'])).code).toBe(0);
    await runCli(rt, ['build', '--dir', 'project', '--concept-off']);
    return (rt.json().build as { blockers: string[] }).blockers;
  };
  const prepared = async () => {
    const rt = await newRuntime();
    const project = await newProject(rt);
    await project.appendDesignNote('observed');
    await rt.fs.writeFile('/work/img.png', 'x');
    return rt;
  };

  it('blocks build while the bundle is pending, unauthorized or missing images', async () => {
    const rt = await prepared();
    const pending = await attach(rt, bundles.makePendingTicket(rt, 'https://x.com/1', 'x'));
    expect(pending).toContain("parseStatus='pending' is not ready (the parse is not finished; a build would be fake)");
  });

  it('lets a ready, authorized bundle through, and reports a deleted or invalid bundle file', async () => {
    const rt = await prepared();
    expect((await attach(rt, readyBundle({}, 'img.png'))).filter((b) => /parseStatus|auth|resource|bundle|schema/.test(b))).toEqual([]);
    await put(rt, '/work/bundle.json', { schema: 'x' });
    await runCli(rt, ['build', '--dir', 'project', '--concept-off']);
    expect((rt.json().build as { blockers: string[] }).blockers).toContain("schema must be 'postbundle.v1'");
    await rt.fs.rm('/work/bundle.json');
    await runCli(rt, ['build', '--dir', 'project', '--concept-off']);
    expect((rt.json().build as { blockers: string[] }).blockers).toContain('the post_bundle file is missing');
  });

  it('does not let a pending URL block a ready local reference', async () => {
    const rt = await prepared();
    await rt.fs.writeFile('/work/ref.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    await runCli(rt, ['reference', '--dir', 'project', '--file', 'ref.png']);
    const blockers = await attach(rt, bundles.makePendingTicket(rt, 'https://x.com/1', 'x'));
    expect(blockers.some((b) => b.includes('parseStatus'))).toBe(false);
  });
});
