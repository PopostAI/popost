/**
 * `provider cli --mock`, manual / host channels and the provider adapter (ports of test_provider.py, test_mock_e2e.py,
 * test_provider_adapter.py and the exit-code cases of test_cli_exit_codes.py). Nothing reaches a network or charges.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkChannels, confirmGenerate, importHostAsset, normalizeRoleRefs, quoteSlot, refsToProviderArgs, registerManual, type CliRunner } from '../src/providers/adapter';
import { cli, newScene, tinyPng, type Json } from './image-helpers';

const MOCK_FLAGS = ['--mock', '--mock-dir', '/work/mock', '--quote-dir', '/work/quotes', '--ledger', '/work/ledger.jsonl'];
const PROMPT = '/skill/tests/fixtures/prompt.txt';

const mockScene = async (env: Record<string, string | undefined> = {}) => {
  const scene = await newScene({ env, files: { '/work/a.png': tinyPng() } });
  const { rt } = scene;
  await rt.fs.mkdir('/work/mock');
  for (const name of ['mock_models.json', 'mock_result.png']) await rt.fs.writeFile(`/work/mock/${name}`, await rt.fs.readFile(`/skill/assets/mock/${name}`));
  const pcli = (...args: string[]) => cli(rt, 'provider', 'cli', ...args);
  const ledgerStates = async () => ((await rt.fs.readText('/work/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l).state) as string[]);
  return { ...scene, pcli, ledgerStates };
};

describe('provider cli --mock', () => {
  it('quotes without charging and marks the quote as a mock', async () => {
    const { pcli } = await mockScene();
    const { code, data } = await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16', '--count', '1');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.quote).toMatchObject({ mock: true, model: 'mock-image-model' });
    expect(data.billing).toMatchObject({ totalCredits: '30', charged: false });
  });

  it('refuses to generate without --confirm (exit 3)', async () => {
    const { pcli } = await mockScene();
    const q = (await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16')).data;
    const { code, data } = await pcli('generate', '--quote-id', q.quote.quoteId, ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16', '--out-dir', '/work/out');
    expect(code).toBe(3);
    expect(data.ok).toBe(false);
  });

  it('enforces the 200 credit cap per request and the platform count limit', async () => {
    const { pcli } = await mockScene();
    let r = await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '1:1', '--count', '7'); // 30 x 7 = 210
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('200');
    r = await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '1:1', '--count', '10');
    expect(r.code, JSON.stringify(r.data)).toBe(2);
    expect(r.data.error).toContain('1–8');
    r = await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--model', 'does-not-exist');
    expect(r.code).toBe(1);
  });

  it('plans a dry run without a ledger entry, output folder or charge', async () => {
    const { pcli, rt } = await mockScene();
    const q = (await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16')).data;
    const { code, data } = await pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', '--dry-run', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16', '--out-dir', '/work/out');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ dryRun: true, charged: false });
    expect(data.plan.request.body).toMatchObject({ model: 'mock-image-model', maxCredits: 30 });
    expect(data.plan.request.body.idempotencyKey).toMatch(/^skill-/);
    expect(await rt.fs.stat('/work/ledger.jsonl')).toBeNull();
    expect(await rt.fs.stat('/work/out')).toBeNull();
  });

  it('runs the full loop: consumed once, materialized byte for byte, a second submission refused', async () => {
    const { pcli, rt, ledgerStates } = await mockScene();
    const q = (await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16', '--count', '1')).data;
    const qid = q.quote.quoteId;
    const gen = await pcli('generate', '--quote-id', qid, '--confirm', ...MOCK_FLAGS, '--out-dir', '/work/out');
    expect(gen.code, JSON.stringify(gen.data)).toBe(0);
    expect(gen.data.billing.charged).toBe(true);
    const files = (await rt.fs.readdir('/work/out')).filter((n) => n.endsWith('.png'));
    expect(files).toHaveLength(1);
    const sha = async (p: string) => createHash('sha256').update(await rt.fs.readFile(p)).digest('hex');
    expect(await sha(`/work/out/${files[0]}`)).toBe(await sha('/skill/assets/mock/mock_result.png'));
    const states = await ledgerStates();
    expect(states).toContain('reserved');
    expect(states.at(-1)).toBe('consumed');
    expect(states.filter((s) => s === 'consumed')).toHaveLength(1);
    const again = await pcli('generate', '--quote-id', qid, '--confirm', ...MOCK_FLAGS, '--out-dir', '/work/out');
    expect(again.code).toBe(1);
    expect(again.data.error.toLowerCase()).toContain('ledger');
  });

  it('reuses the quote prompt and rejects a different one', async () => {
    const { pcli, rt } = await mockScene();
    await rt.fs.writeFile('/work/other.txt', '完全不同的另一套文案');
    const q = (await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16')).data;
    const bad = await pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...MOCK_FLAGS, '--prompt-file', '/work/other.txt', '--out-dir', '/work/out');
    expect(bad.code).toBe(1);
    expect(bad.data.error).toContain('differs from the quote');
    const good = await pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...MOCK_FLAGS, '--out-dir', '/work/out');
    expect(good.code, JSON.stringify(good.data)).toBe(0);
  });

  it('locks the model, honours an explicit override and a pinned default', async () => {
    const { pcli, rt } = await mockScene();
    let r = await pcli('quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--model', 'mock-image-model-alt', '--aspect-ratio', '1:1');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('locked');
    await rt.fs.writeFile('/work/private.json', JSON.stringify({ popost: { providerOverrides: [{ provider: 'popost', model: 'mock-image-model-alt' }] } }));
    r = await pcli('--config', '/work/private.json', 'quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--model', 'mock-image-model-alt', '--aspect-ratio', '1:1');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    const gen = await pcli('--config', '/work/private.json', 'generate', '--quote-id', r.data.quote.quoteId, '--confirm', ...MOCK_FLAGS, '--out-dir', '/work/out');
    expect(gen.code, JSON.stringify(gen.data)).toBe(0);
    await rt.fs.writeFile('/work/pinned.json', JSON.stringify({ popost: { defaultModel: 'mock-image-model-alt' } }));
    r = await pcli('--config', '/work/pinned.json', 'quote', ...MOCK_FLAGS, '--prompt-file', PROMPT, '--aspect-ratio', '9:16');
    expect(r.data.quote.model).toBe('mock-image-model-alt');
    expect(r.data.billing.totalCredits).toBe('18');
  });

  it('keeps run-time state in the caller directory, never in the package', async () => {
    const { pcli, rt } = await mockScene();
    const flags = ['--mock', '--quote-dir', '/work/quotes', '--ledger', '/work/ledger.jsonl'];
    const q = (await pcli('quote', ...flags, '--prompt-file', PROMPT, '--aspect-ratio', '9:16')).data;
    const gen = await pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...flags, '--out-dir', '/work/out');
    expect(gen.code, JSON.stringify(gen.data)).toBe(0);
    expect((await rt.fs.stat('/work/.sps-mock/mock_tasks.json'))?.isFile).toBe(true);
    expect(await rt.fs.stat('/skill/assets/mock/mock_tasks.json')).toBeNull();
  });
});

describe('manual and host channels', () => {
  it('registers manual files with their hash and rejects a missing one (exit 1)', async () => {
    const { pcli } = await mockScene();
    let r = await pcli('inventory', '--file', '/work/a.png');
    expect(r.code).toBe(0);
    expect(r.data).toMatchObject({ charged: false, channel: 'manual' });
    expect(r.data.items[0]).toMatchObject({ kind: 'local', value: '/work/a.png' });
    expect(r.data.items[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    r = await pcli('inventory', '--file', '/work/missing.png');
    expect(r.code).toBe(1);
  });

  it('never calls a channel measured when it was only mocked or declared', async () => {
    const { pcli } = await mockScene();
    let r = await pcli('--provider', 'popost', 'check', '--mock', '--mock-dir', '/work/mock');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.checks.popost.measured).toBe(false);
    r = await pcli('--provider', 'host', 'check');
    expect(r.data.checks.host).toMatchObject({ ok: false, measured: false });
    r = await pcli('--provider', 'manual', 'check');
    expect(r.data.checks.manual).toMatchObject({ ok: true, measured: false, generative: false });
  });

  it('refuses quoting a non-generative channel and an unknown provider', async () => {
    const { pcli } = await mockScene();
    let r = await pcli('--provider', 'manual', 'quote', '--prompt', 'x');
    expect(r.code).toBe(1);
    r = await pcli('--provider', 'nope', 'models');
    expect([r.code, r.data.error]).toEqual([2, expect.stringContaining('unknown provider')]);
  });

  it('lists the live models as protocol rows', async () => {
    const { pcli } = await mockScene();
    const { code, data } = await pcli('--provider', 'popost', 'models', '--mock', '--mock-dir', '/work/mock');
    expect(code).toBe(0);
    expect(data.models.map((m: { value: string }) => m.value)).toEqual(['mock-image-model', 'mock-image-model-alt']);
  });
});

describe('usage errors', () => {
  it('exits 2 on a missing sub-command, an unknown one and a bad value', async () => {
    const { rt } = await mockScene();
    expect((await cli(rt, 'provider', 'cli')).code).toBe(2);
    expect((await cli(rt, 'provider', 'cli', 'nope')).code).toBe(2);
    const bad = await cli(rt, 'provider', 'cli', 'quote', '--prompt', 'x', '--aspect-ratio', 'wide');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('the ratio must be W:H');
    expect((await cli(rt, 'provider', 'cli', 'generate')).code).toBe(2); // --quote-id is required
    expect((await cli(rt, 'provider', 'nope')).code).toBe(2);
  });

  it('takes a prompt that starts with a dash as a value, like argparse does for text with a space', async () => {
    const { pcli } = await mockScene();
    const { code, data } = await pcli('quote', ...MOCK_FLAGS, '--aspect-ratio', '1:1', '--prompt', '- a bullet style prompt');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.quote.prompt).toBe('- a bullet style prompt');
  });
});

class FakeRunner {
  readonly calls: (readonly string[])[] = [];
  readonly injected = true;
  constructor(
    private readonly code = 0,
    private readonly out = '{}',
  ) {}
  run: CliRunner = Object.assign(
    async (argv: readonly string[]) => {
      this.calls.push(argv);
      return { code: this.code, stdout: this.out, stderr: '' };
    },
    { injected: true },
  );
}

describe('provider adapter', () => {
  it('normalizes roles and keeps identity and style apart', () => {
    const n = normalizeRoleRefs([{ path: '/id.png', role: 'identity' }, ['/st.png', 'style']]);
    expect(n.hasIdentity).toBe(true);
    expect(n.identityRefs[0]!.path).toBe('/id.png');
    expect(Object.fromEntries(n.refs.map((r) => [r.role, r.path]))).toEqual({ identity: '/id.png', style: '/st.png' });
    expect(() => normalizeRoleRefs([{ path: '/a.png', role: 'logo' }])).toThrow();
  });

  it('passes each reference file once, in order', () => {
    const n = normalizeRoleRefs([{ path: '/a.png', role: 'identity' }, { path: '/a.png', role: 'style' }, { path: '/b.png', role: 'action' }]);
    expect(refsToProviderArgs(n.refs)).toEqual(['--ref', '/a.png', '--ref', '/b.png']);
  });

  it('declares the channels without probing, and labels an injected probe', async () => {
    const plain = (await checkChannels()) as Json;
    expect(plain.channels.popost).toMatchObject({ status: 'not_tested', measured: false, defaultModel: null });
    expect(plain.channels.host.status).toBe('declared');
    const r = new FakeRunner(0, '{"ok":true}');
    const probed = (await checkChannels(r.run)) as Json;
    expect(probed.channels.popost).toMatchObject({ status: 'measured', injected: true });
    expect(r.calls[0]).toContain('check');
  });

  it('delegates a quote with its references, and a confirm only when confirmed', async () => {
    const { rt } = await mockScene();
    const r = new FakeRunner(0, '{"ok":true,"quote":{"quoteId":"q_test"}}');
    const res = (await quoteSlot(rt, { prompt: 'prompt text', aspect: '9:16', count: 1, refs: [{ path: '/work/a.png', role: 'identity' }] }, r.run)) as Json;
    expect(res.ok).toBe(true);
    expect(r.calls[0]).toEqual(expect.arrayContaining(['quote', '--provider', 'popost', '--ref', '/work/a.png']));
    expect(res.refsNormalized.identityRefs[0].path).toBe('/work/a.png');
    const blockedRunner = new FakeRunner();
    const blocked = (await confirmGenerate(rt, 'q_x', '/out', {}, blockedRunner.run)) as Json;
    expect([blocked.ok, blocked.exit]).toEqual([false, 3]);
    expect(blockedRunner.calls).toEqual([]); // nothing was ever submitted
    const go = new FakeRunner(0, '{"ok":true}');
    expect(((await confirmGenerate(rt, 'q_x', '/out', { confirm: true }, go.run)) as Json).ok).toBe(true);
    expect(go.calls[0]).toContain('--confirm');
  });

  it('registers host and manual assets without claiming they were measured', async () => {
    const { rt } = await mockScene();
    const host = (await importHostAsset(rt, '/work/a.png', 'CC-BY', 'host')) as Json;
    expect(host).toMatchObject({ ok: true, status: 'declared', measured: false });
    expect(((await importHostAsset(rt, '/nope.png')) as Json).status).toBe('blocked');
    const r = new FakeRunner();
    expect(((await registerManual(rt, '/nope.png', r.run)) as Json).ok).toBe(false);
    expect(r.calls).toEqual([]); // a missing file is not delegated
  });

  it('has the exit codes of the Python adapter: confirm without the flag 3, check 0, a missing host file 1', async () => {
    const { rt } = await mockScene();
    let r = await cli(rt, 'provider', 'confirm', '--quote-id', 'q_x', '--out-dir', '/tmp');
    expect([r.code, r.data.ok, r.data.error.code]).toEqual([3, false, 'UNCONFIRMED']);
    r = await cli(rt, 'provider', 'check');
    expect([r.code, r.data.channels.popost.status]).toEqual([0, 'not_tested']);
    r = await cli(rt, 'provider', 'host-import', '--file', '/tmp/__nope__.png');
    expect([r.code, r.data.ok, r.data.status]).toEqual([1, false, 'blocked']);
    r = await cli(rt, 'provider', 'quote', '--prompt', 'x', '--ref', 'no-role');
    expect([r.code, r.data.status]).toEqual([1, 'blocked']);
  });
});
