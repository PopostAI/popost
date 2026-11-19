/**
 * The language of the messages: English by default, Chinese when the user's locale is Chinese (`POPOST_LANG`, then
 * `LC_ALL`, `LC_MESSAGES`, `LANG`). Each case runs the real CLI with the locale in the runtime's environment; nothing
 * here sets a language for the other tests, which build their messages outside `run()` and so always get English.
 */
import { describe, expect, it } from 'vitest';
import { currentLang, msg, resolveLang, withLang } from '../src/i18n';
import { createTestRuntime, mountPackageFiles, runCli, type TestRuntime } from '../src/testing/memory';
import { cli, newScene, tinyPng } from './image-helpers';

const HAN = /[一-鿿]/;
type Env = Record<string, string | undefined>;

/** Each locale and the language it must give. */
const LOCALES: readonly (readonly [string, Env, 'en' | 'zh'])[] = [
  ['POPOST_LANG=zh', { POPOST_LANG: 'zh' }, 'zh'],
  ['LANG=zh_CN.UTF-8', { LANG: 'zh_CN.UTF-8' }, 'zh'],
  ['LANG=en_US.UTF-8', { LANG: 'en_US.UTF-8' }, 'en'],
  ['no locale', {}, 'en'],
];

/** What the earlier Python version, or a raw Node error, would have put into a message. */
const LEFTOVERS = [/Errno/, /ENOENT/, /cannot identify image/, /\bNone\b/, /\bTrue\b/, /\bFalse\b/, /ValueError: /, /ProjectError: /, /KeyError: /, /OSError: /, /TypeError: /, /fetch failed/];

const expectNoLeftovers = (text: string): void => {
  for (const pattern of LEFTOVERS) expect(text).not.toMatch(pattern);
};

const runtime = async (env: Env, files: Record<string, string | Uint8Array> = {}): Promise<TestRuntime> => {
  const rt = createTestRuntime({ env, files });
  await mountPackageFiles(rt.fs, ['assets/project-starter', 'tests/fixtures']);
  return rt;
};

describe('choosing the language', () => {
  it('reads POPOST_LANG, then LC_ALL, LC_MESSAGES and LANG; zh… is Chinese, anything else English', () => {
    expect(resolveLang({})).toBe('en');
    expect(resolveLang({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(resolveLang({ LANG: 'zh-Hant' })).toBe('zh');
    expect(resolveLang({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveLang({ LANG: 'C.UTF-8' })).toBe('en');
    expect(resolveLang({ LC_ALL: 'en_GB.UTF-8', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLang({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(resolveLang({ POPOST_LANG: 'en', LC_ALL: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveLang({ POPOST_LANG: 'zh', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(resolveLang({ POPOST_LANG: ' ', LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });

  it('is English outside run(), and each invocation keeps its own language across awaits', async () => {
    expect(currentLang()).toBe('en');
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const both = await Promise.all([
      withLang('zh', async () => {
        await later(5);
        return msg('hello', '你好');
      }),
      withLang('en', async () => msg('hello', '你好')),
    ]);
    expect(both).toEqual(['你好', 'hello']);
    expect(msg('hello', '你好')).toBe('hello');
  });

  it('runs two invocations with different locales side by side, each in its own language', async () => {
    const [zh, en] = await Promise.all([runtime({ LANG: 'zh_CN.UTF-8' }), runtime({ LANG: 'en_US.UTF-8' })]);
    await Promise.all([runCli(zh, ['image', 'info', '--file', 'inputs/nothing.png']), runCli(en, ['image', 'info', '--file', 'inputs/nothing.png'])]);
    expect(zh.json().error).toBe('没有一个文件是可读取的图片');
    expect(en.json().error).toBe('none of the files is a readable picture');
    expect(currentLang()).toBe('en');
  });
});

describe.each(LOCALES)('messages with %s', (_name, env, lang) => {
  const zh = lang === 'zh';

  it('a missing file names the path, without errno text', async () => {
    const rt = await runtime(env);
    expect((await runCli(rt, ['image', 'info', '--file', 'inputs/nothing.png'])).code).toBe(2);
    const entry = (rt.json().images as { error: string }[])[0]!;
    expect(entry.error).toBe(zh ? '文件不存在：inputs/nothing.png' : 'file not found: inputs/nothing.png');
    expectNoLeftovers(rt.stdoutText());
  });

  it('a file that is not a picture says so, not in the words of an image library', async () => {
    const rt = await runtime(env, { '/work/notes.png': 'just some text' });
    expect((await runCli(rt, ['image', 'info', '--file', 'notes.png'])).code).toBe(2);
    const entry = (rt.json().images as { error: string }[])[0]!;
    expect(entry.error).toBe(zh ? '不是可读取的图片文件：notes.png' : 'not a readable picture file: notes.png');
    expectNoLeftovers(rt.stdoutText());
  });

  it('a bundle that does not validate lists its errors in the language, with the same fields and exit code', async () => {
    const rt = await runtime(env);
    await rt.fs.writeFile('/work/bad.json', JSON.stringify({ schema: 'x' }));
    expect((await runCli(rt, ['validate', '--file', 'bad.json'])).code).toBe(2);
    const doc = rt.json();
    expect(doc).toMatchObject({ ok: false, valid: false });
    const errors = doc.errors as string[];
    expect(errors[0]).toContain("'postbundle.v1'");
    if (zh) expect(errors.every((text) => HAN.test(text))).toBe(true);
    else expect(errors[0]).toBe("schema must be 'postbundle.v1'");
    expectNoLeftovers(rt.stdoutText());
  });

  it('a call without an account says nothing was sent or charged and how to connect', async () => {
    const { rt } = await newScene({ env: { POPOST_API_KEY: undefined, ...env } });
    const r = await cli(rt, 'account');
    expect(r.code).not.toBe(0);
    const error = String(r.data.error);
    expect(error).toContain('POPOST_API_KEY');
    expect(error).toContain(zh ? '未扣费' : 'nothing was charged');
    expect(HAN.test(error)).toBe(zh);
    expectNoLeftovers(r.stdout);
  });

  it('a quote the balance does not cover gives the price, the balance and that nothing was charged', async () => {
    const scene = await newScene({ env: { POPOST_PROVIDER_CONFIG: '/work/private.json', ...env }, files: { '/work/ref.png': tinyPng([1, 2, 3], 3) } });
    await scene.rt.fs.writeFile('/work/private.json', JSON.stringify({ popost: {} }));
    scene.stub.balance = 5;
    const r = await cli(scene.rt, 'provider', 'cli', 'quote', '--quote-dir', '/work/quotes', '--ledger', '/work/ledger.jsonl', '--prompt', 'x');
    expect(r.code).toBe(1);
    const error = String(r.data.error);
    const { totalCredits, balance } = r.data.billing as { totalCredits: string; balance: number };
    expect(error).toContain(totalCredits);
    expect(error).toContain(String(balance));
    expect(error).toContain(zh ? '积分不足' : 'Not enough credits');
    expect(error).toContain(zh ? '未扣费' : 'Nothing was submitted or charged');
    expect(r.data.billing).toMatchObject({ sufficient: false, charged: false });
    expectNoLeftovers(r.stdout);
  });
});

describe('Python leftovers', () => {
  it('a host that cannot be resolved is named with the reason, not as TypeError: fetch failed', async () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND', hostname: 'api.example.test' });
    const { rt } = await newScene({
      env: { POPOST_BASE_URL: 'https://api.example.test/api/v1' },
      fetchHandler: () => async () => {
        throw new TypeError('fetch failed', { cause: dns });
      },
    });
    const r = await cli(rt, 'account');
    expect(r.code).not.toBe(0);
    expect(String(r.data.error)).toContain('the DNS lookup for api.example.test failed');
    expectNoLeftovers(r.stdout);
  });

  it('keeps the error class on the error and leaves its name out of the printed message', async () => {
    const rt = await runtime({});
    expect((await runCli(rt, ['render', '--dir', 'nowhere', '--page', 'all'])).code).not.toBe(0);
    const text = rt.stdoutText() + rt.err.join('');
    expect(text).toMatch(/not a v2 project/);
    expectNoLeftovers(text);
  });
});
