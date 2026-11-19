/** `popost auth`, the stored key file, its place in the key resolution order, and the key guidance in errors. */
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStoredCredentials, credentialsFile, keyPageUrl, parseCredentials, writeStoredCredentials } from '../src/credentials';
import { createNodeRuntime } from '../src/node-runtime';
import { PopostClient } from '../src/providers/api';
import { secretValues } from '../src/providers/secrets';
import { createTestRuntime, runCli, type TestRuntime } from '../src/testing/memory';

const KEY = 'sk-live-FULL-KEY-must-never-print-0123456789';
const FILE = '/home/u/.popost/credentials.json';

const scene = (overrides: Parameters<typeof createTestRuntime>[0] = {}, stdin?: string) =>
  createTestRuntime({ homeDir: '/home/u', stdin: stdin === undefined ? undefined : async () => stdin, ...overrides });

describe('auth set', () => {
  it('redeems a connection once at the selected origin and never prints the secret or code', async () => {
    const code = 'a'.repeat(43);
    let count = 0;
    const rt = scene({ fetch: async (url, init) => {
      expect(String(url)).toBe('https://self.example/api/skill-connect');
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(String(init?.body))).toEqual({ code });
      count++;
      return new Response(JSON.stringify(count === 1 ? { success: true, data: { key: KEY } } : { success: false }), { status: count === 1 ? 200 : 404 });
    } });
    const args = ['auth', 'set', '--connect', code, '--base-url', 'https://self.example/api/open/v1'];
    const first = await runCli(rt, args);
    expect(first.code).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(KEY);
    expect(first.stdout + first.stderr).not.toContain(code);
    expect(JSON.parse(await rt.fs.readText(FILE)).apiKey).toBe(KEY);
    expect((await runCli(rt, args)).code).toBe(2);
  });

  it('reads the key from stdin, trims it, stores it and prints it masked', async () => {
    const rt = scene({}, `  ${KEY}\r\n`);
    const r = await runCli(rt, ['auth', 'set', '--stdin']);
    expect(r.code).toBe(0);
    expect(JSON.parse(await rt.fs.readText(FILE))).toEqual({ apiKey: KEY });
    const out = rt.json();
    expect(out).toMatchObject({ ok: true, action: 'set', key: 'sk-live-....', credentialsFile: FILE, keyPageUrl: 'https://popost.ai/account/api-keys', baseUrl: null });
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(r.stdout + r.stderr).not.toContain(KEY.slice(0, 20));
  });

  it('takes --key and an https --base-url (loopback http is allowed)', async () => {
    const rt = scene();
    expect((await runCli(rt, ['auth', 'set', '--key', KEY, '--base-url', 'https://self.example/api/open/v1/'])).code).toBe(0);
    expect(JSON.parse(await rt.fs.readText(FILE))).toEqual({ apiKey: KEY, baseUrl: 'https://self.example/api/open/v1' });
    expect(rt.json().keyPageUrl).toBe('https://self.example/account/api-keys');
    expect((await runCli(rt, ['auth', 'set', '--key', KEY, '--base-url', 'http://127.0.0.1:3000/api/open/v1'])).code).toBe(0);
  });

  it('replaces the stored base URL when none is given again', async () => {
    const rt = scene({}, KEY);
    await runCli(rt, ['auth', 'set', '--key', KEY, '--base-url', 'https://self.example/api/open/v1']);
    await runCli(rt, ['auth', 'set', '--stdin']);
    expect(JSON.parse(await rt.fs.readText(FILE))).toEqual({ apiKey: KEY });
  });

  it.each([
    ['empty', ''],
    ['blank', '   \n'],
    ['with a space', 'sk-abc def-ghijklmnopqrstuvwx'],
    ['an env assignment', `POPOST_API_KEY=${KEY}`],
    ['an exported assignment', `export POPOST_API_KEY=${KEY}`],
    ['an address', 'https://popost.ai/account/api-keys'],
    ['too short', 'abc123'],
    ['non-ASCII', 'sk-密钥密钥密钥密钥密钥密钥密钥密钥密钥'],
  ])('rejects %s without echoing it and writes nothing', async (_name, input) => {
    const rt = scene({}, input);
    const r = await runCli(rt, ['auth', 'set', '--stdin']);
    expect(r.code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
    expect(r.stdout + r.stderr).not.toContain(input.trim() || '\u0000');
    expect(await rt.fs.stat(FILE)).toBeNull();
  });

  it('rejects a base URL that is not https', async () => {
    const rt = scene();
    const r = await runCli(rt, ['auth', 'set', '--key', KEY, '--base-url', 'http://popost.example/api']);
    expect(r.code).toBe(2);
    expect(await rt.fs.stat(FILE)).toBeNull();
  });

  it('needs exactly one of --key and --stdin', async () => {
    const rt = scene({}, KEY);
    expect((await runCli(rt, ['auth', 'set'])).code).toBe(2);
    expect((await runCli(rt, ['auth', 'set', '--key', KEY, '--stdin'])).code).toBe(2);
    expect(await rt.fs.stat(FILE)).toBeNull();
  });

  it('honours POPOST_HOME', async () => {
    const rt = scene({ env: { POPOST_HOME: '/data/popost' } });
    await runCli(rt, ['auth', 'set', '--key', KEY]);
    expect(await rt.fs.stat('/data/popost/credentials.json')).not.toBeNull();
  });

  it('warns when an environment key will shadow the stored one', async () => {
    const rt = scene({ env: { POPOST_API_KEY: 'sk-from-env-0123456789abcdef' } });
    await runCli(rt, ['auth', 'set', '--key', KEY]);
    expect(String(rt.json().warning)).toContain('POPOST_API_KEY');
  });

  it('refuses on a host without a home directory', async () => {
    const rt = scene({ homeDir: undefined });
    const r = await runCli(rt, ['auth', 'set', '--key', KEY]);
    expect(r.code).toBe(2);
    expect(String(rt.json().error)).toContain('POPOST_API_KEY');
    expect((await runCli(rt, ['auth', 'clear'])).code).toBe(2);
  });
});

describe('auth status and clear', () => {
  it('reports none without a key, no network involved', async () => {
    const rt = scene();
    expect((await runCli(rt, ['auth', 'status'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, source: 'none', key: null, fileStatus: 'absent', credentialsFile: FILE, baseUrl: 'https://popost.ai/api/open/v1', baseUrlSource: 'default', keyPageUrl: 'https://popost.ai/account/api-keys' });
    expect(String(rt.json().next)).toContain('popost auth login');
  });

  it('reports env, with the key masked', async () => {
    const rt = scene({ env: { POPOST_API_KEY: KEY, POPOST_BASE_URL: 'https://self.example/api/open/v1' } });
    const r = await runCli(rt, ['auth', 'status']);
    expect(rt.json()).toMatchObject({ source: 'env', key: 'sk-live-....', baseUrl: 'https://self.example/api/open/v1', baseUrlSource: 'env', keyPageUrl: 'https://self.example/account/api-keys' });
    expect(r.stdout).not.toContain(KEY);
  });

  it('reports file when the runtime took the key from the file', async () => {
    const stored = { apiKey: KEY, baseUrl: 'https://self.example/api/open/v1' };
    const rt = scene({ files: { [FILE]: JSON.stringify(stored) }, env: { ...applyStoredCredentials({}, stored) } });
    await runCli(rt, ['auth', 'status']);
    expect(rt.json()).toMatchObject({ source: 'file', fileStatus: 'ok', baseUrlSource: 'file', key: 'sk-live-....' });
  });

  it('reports a corrupt file instead of failing', async () => {
    const rt = scene({ files: { [FILE]: '{not json' } });
    expect((await runCli(rt, ['auth', 'status'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ source: 'none', fileStatus: 'corrupt' });
    expect(String(rt.json().warning)).toContain('auth set');
  });

  it('reports env only on a host without a home directory', async () => {
    const rt = scene({ homeDir: undefined, env: { POPOST_API_KEY: KEY } });
    await runCli(rt, ['auth', 'status']);
    expect(rt.json()).toMatchObject({ source: 'env', credentialsFile: null, fileStatus: 'unsupported' });
  });

  it('clear removes the file and is idempotent', async () => {
    const rt = scene({ files: { [FILE]: JSON.stringify({ apiKey: KEY }) } });
    expect((await runCli(rt, ['auth', 'clear'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, removed: true });
    expect(await rt.fs.stat(FILE)).toBeNull();
    expect((await runCli(rt, ['auth', 'clear'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, removed: false });
  });

  it('clear tells that an environment key is still in use', async () => {
    const rt = scene({ env: { POPOST_API_KEY: KEY } });
    await runCli(rt, ['auth', 'clear']);
    expect(String(rt.json().warning)).toContain('still set');
  });
});

describe('credentials file', () => {
  it('parses tolerant of blanks and rejects non-objects and wrong types', () => {
    expect(parseCredentials('{"apiKey":" k ","baseUrl":""}')).toEqual({ apiKey: 'k' });
    expect(parseCredentials('{}')).toEqual({});
    for (const bad of ['', '[]', '"x"', 'null', '{"apiKey":5}', '{"baseUrl":true}']) expect(parseCredentials(bad)).toBeNull();
  });

  it('the environment wins over the file; blanks count as unset', () => {
    const stored = { apiKey: 'file-key', baseUrl: 'https://file.example/api' };
    expect(applyStoredCredentials({}, stored)).toEqual({ POPOST_API_KEY: 'file-key', POPOST_BASE_URL: 'https://file.example/api' });
    expect(applyStoredCredentials({ POPOST_API_KEY: 'env-key' }, stored)).toMatchObject({ POPOST_API_KEY: 'env-key', POPOST_BASE_URL: 'https://file.example/api' });
    expect(applyStoredCredentials({ POPOST_API_KEY: '  ' }, stored).POPOST_API_KEY).toBe('file-key');
    expect(applyStoredCredentials({ HOME: '/h' }, null)).toEqual({ HOME: '/h' });
  });

  it('locates the file under home, or POPOST_HOME (relative to cwd)', () => {
    const rt = scene();
    expect(credentialsFile(rt)).toBe(FILE);
    expect(credentialsFile(scene({ env: { POPOST_HOME: 'rel' } }))).toBe('/work/rel/credentials.json');
    expect(credentialsFile(scene({ homeDir: undefined }))).toBeUndefined();
  });

  it('derives the key page from the API origin', () => {
    expect(keyPageUrl()).toBe('https://popost.ai/account/api-keys');
    expect(keyPageUrl('http://127.0.0.1:3000/api/open/v1')).toBe('http://127.0.0.1:3000/account/api-keys');
    expect(keyPageUrl('not a url')).toBe('https://popost.ai/account/api-keys');
  });

  it('a key from the file is scrubbed like an environment key', () => {
    const rt = scene({ env: applyStoredCredentials({}, { apiKey: KEY }) });
    expect(secretValues(rt, {})).toEqual([KEY]);
  });
});

describe('key guidance in errors', () => {
  const failure = async (rt: TestRuntime, baseUrl?: string) => {
    try {
      await new PopostClient(rt, { baseUrl }).request('GET', '/models');
    } catch (error) {
      return error as Error & { code?: string };
    }
    throw new Error('expected a failure');
  };

  it('NO_API_KEY names the key page of the base URL in use and popost auth set', async () => {
    const custom = await failure(scene(), 'https://self.example/api/open/v1');
    expect(custom.code).toBe('NO_API_KEY');
    for (const part of ['https://self.example/account/api-keys', 'popost auth login', 'POPOST_API_KEY', 'nothing was sent', 'nothing was charged'])
      expect(custom.message).toContain(part);
    expect((await failure(scene())).message).toContain('https://popost.ai/account/api-keys');
    expect((await failure(scene({ env: { POPOST_BASE_URL: 'http://127.0.0.1:3000/api/open/v1' } }))).message).toContain('http://127.0.0.1:3000/account/api-keys');
  });

  it('UNAUTHORIZED gives the same next step', async () => {
    const rt = scene({
      env: { POPOST_API_KEY: KEY },
      fetchHandler: () => Response.json({ success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'bad key' } }, { status: 401 }),
    });
    const error = await failure(rt, 'https://self.example/api/open/v1');
    expect(error.code).toBe('UNAUTHORIZED');
    for (const part of ['https://self.example/account/api-keys', 'popost auth login', 'POPOST_API_KEY']) expect(error.message).toContain(part);
    expect(error.message).not.toContain(KEY);
  });
});

describe('node runtime', () => {
  const touched = ['POPOST_HOME', 'POPOST_API_KEY', 'POPOST_BASE_URL'] as const;
  const saved = Object.fromEntries(touched.map((name) => [name, process.env[name]]));
  const dirs: string[] = [];
  afterEach(() => {
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const home = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'popost-auth-'));
    dirs.push(dir);
    process.env.POPOST_HOME = path.join(dir, 'state');
    delete process.env.POPOST_API_KEY;
    delete process.env.POPOST_BASE_URL;
    return process.env.POPOST_HOME;
  };

  it('exposes the stored key and base URL as env, the environment first', async () => {
    const state = home();
    const rt = createNodeRuntime();
    await writeStoredCredentials(rt, path.join(state, 'credentials.json'), { apiKey: KEY, baseUrl: 'https://self.example/api/open/v1' });
    expect(createNodeRuntime().env).toMatchObject({ POPOST_API_KEY: KEY, POPOST_BASE_URL: 'https://self.example/api/open/v1' });
    process.env.POPOST_API_KEY = 'sk-env-wins-0123456789abcdef';
    expect(createNodeRuntime().env.POPOST_API_KEY).toBe('sk-env-wins-0123456789abcdef');
    expect(createNodeRuntime().env.POPOST_BASE_URL).toBe('https://self.example/api/open/v1');
  });

  it.skipIf(process.platform === 'win32')('writes the file owner-only in an owner-only directory', async () => {
    const state = home();
    const rt = createNodeRuntime();
    const file = path.join(state, 'credentials.json');
    await writeStoredCredentials(rt, file, { apiKey: KEY });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    await writeStoredCredentials(rt, file, { apiKey: `${KEY}-2` }); // an update keeps the mode
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('ignores a corrupt or unreadable file', () => {
    const state = home();
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, 'credentials.json'), '{broken');
    expect(createNodeRuntime().env.POPOST_API_KEY).toBeUndefined();
    rmSync(path.join(state, 'credentials.json'));
    mkdirSync(path.join(state, 'credentials.json')); // a directory where the file should be
    expect(createNodeRuntime().env.POPOST_API_KEY).toBeUndefined();
  });
});


describe('private terminal setup', () => {
  it('stores a hidden-input key through the same private credential writer without printing it', async () => {
    const rt = scene();
    const r = await runCli({ ...rt, readSecret: async () => KEY }, ['auth', 'set', '--prompt']);
    expect(r.code).toBe(0);
    expect(JSON.parse(await rt.fs.readText(FILE)).apiKey).toBe(KEY);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
  it('does not fall back to stdin or overwrite credentials when private input is unavailable or cancelled', async () => {
    for (const readSecret of [undefined, async (): Promise<string> => { throw new Error(KEY); }]) {
      const rt = scene({ files: { [FILE]: JSON.stringify({ apiKey: KEY }) } }, 'another-secret-never-read');
      const r = await runCli({ ...rt, readSecret }, ['auth', 'set', '--prompt']);
      expect(r.code).toBe(2);
      expect(JSON.parse(await rt.fs.readText(FILE)).apiKey).toBe(KEY);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    }
  });
  it('refuses conflicting input modes before requesting a secret', async () => {
    const rt = scene();
    const r = await runCli({ ...rt, readSecret: async () => { throw new Error('must not run'); } }, ['auth', 'set', '--prompt', '--stdin']);
    expect(r.code).toBe(2);
    expect(await rt.fs.stat(FILE)).toBeNull();
  });
});
