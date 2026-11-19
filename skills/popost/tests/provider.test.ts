/**
 * `popost provider cli`: the two-step quote / generate flow against the fake platform (port of the CLI half of
 * test_popost_provider.py), with the ledger, price re-check, idempotency, and the rule that the key is never written down.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { endpointBinding, recordIntegrityHash, requestHash } from '../src/providers/cli-config';
import { API, cli, err, everythingWritten, KEY, newScene, tinyPng, type Json, type Scene } from './image-helpers';

const OUT = '/work/out';
const FLAGS = ['--quote-dir', '/work/quotes', '--ledger', '/work/ledger.jsonl'];

interface Flow extends Scene {
  pcli: (...args: string[]) => ReturnType<typeof cli>;
  quote: (...extra: string[]) => Promise<Json>;
  writeCfg: (popost: Record<string, unknown>) => Promise<void>;
  ledger: () => Promise<Json[]>;
}

const flow = async (popost: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}): Promise<Flow> => {
  const scene = await newScene({ env: { POPOST_PROVIDER_CONFIG: '/work/private.json', ...env }, files: { '/work/ref.png': tinyPng([1, 2, 3], 3) } });
  const writeCfg = (config: Record<string, unknown>) => scene.rt.fs.writeFile('/work/private.json', JSON.stringify({ popost: config }));
  await writeCfg(popost);
  const pcli = (...args: string[]) => cli(scene.rt, 'provider', 'cli', ...args);
  const quote = async (...extra: string[]) => {
    const { code, data } = await pcli('quote', ...FLAGS, '--prompt', 'a quiet desk at dawn', '--aspect-ratio', '3:4', ...extra);
    expect(code, JSON.stringify(data)).toBe(0);
    return data;
  };
  const ledger = async () =>
    (await scene.rt.fs.stat('/work/ledger.jsonl')) ? (await scene.rt.fs.readText('/work/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...scene, pcli, quote, writeCfg, ledger };
};

const noSecret = async (f: Flow) => {
  for (const blob of await everythingWritten(f.rt)) expect(blob).not.toContain(KEY);
};

describe('quote then generate', () => {
  it('runs end to end: quote, generate with inline references, materialize, status, download', async () => {
    const f = await flow();
    const q = await f.quote('--count', '2', '--ref', '/work/ref.png', '--ref-url', 'https://cdn.example.com/style.png');
    const rec = q.quote;
    expect(rec.model).toBe('stub-model-a'); // the platform's isDefault
    expect(q.billing).toMatchObject({ totalCredits: '24', balance: 500, charged: false, unit: 'credits' });
    expect(f.stub.calls('POST', '/images/generations')).toEqual([]);
    expect(f.stub.calls('POST', '/images/quote')[0]!.json).toEqual({ n: 2, aspectRatio: '3:4', referenceImageCount: 2, model: 'stub-model-a' });
    expect(rec.requestHash).toMatch(/^[0-9a-f]{64}$/);

    const { code, data } = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(code, JSON.stringify(data)).toBe(0);
    const gens = f.stub.calls('POST', '/images/generations');
    expect(gens).toHaveLength(1);
    const body = gens[0]!.json!;
    expect(body).toMatchObject({ maxCredits: 24, model: 'stub-model-a', n: 2, aspectRatio: '3:4', idempotencyKey: data.idempotencyKey });
    expect(body.idempotencyKey).toMatch(/^skill-/);
    expect(Buffer.from(body.referenceImages[0].data, 'base64')).toEqual(Buffer.from(await f.rt.fs.readFile('/work/ref.png')));
    expect(body.referenceImages[0].mimeType).toBe('image/png');
    expect(body.referenceImages[1]).toEqual({ url: 'https://cdn.example.com/style.png' });
    expect(JSON.stringify(body)).not.toContain('/work/ref.png'); // content, never a path
    expect(gens[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const mats = data.materials;
    expect(mats).toHaveLength(2);
    expect(await f.rt.fs.readFile(mats[0].localPath)).toEqual(f.stub.inlinePng);
    expect(mats[0].url).toBeNull();
    expect(await f.rt.fs.readFile(mats[1].localPath)).toEqual(f.stub.files.get('gen-1.png'));
    expect(mats[1].url).toMatch(/\/files\/gen-1\.png$/);
    for (const m of mats) expect(m.sha256).toBe(createHash('sha256').update(await f.rt.fs.readFile(m.localPath)).digest('hex'));
    expect(data.billing).toMatchObject({ actualCredits: 24, balance: 476, charged: true });
    const states = await f.ledger();
    expect(states.map((s) => s.state)).toEqual(['reserved', 'consumed']);
    expect(states[0].meta.idempotencyKey).toBe(body.idempotencyKey);
    expect(data.taskRecord).toBe(`/work/tasks/${data.taskId}.json`);
    const record = JSON.parse(await f.rt.fs.readText(data.taskRecord));
    expect(record.status).toBe('completed');
    expect(JSON.stringify(data) + JSON.stringify(record)).not.toContain('SomeUpstreamVendor');

    // the same quote cannot be submitted twice; no second POST goes out
    const again = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(again.code).toBe(1);
    expect(again.data.error).toContain('ledger');
    expect(f.stub.calls('POST', '/images/generations')).toHaveLength(1);

    // status and download read the local task record; only the URL image is fetched again
    const before = f.stub.requests.length;
    const st = await f.pcli('status', '--task-id', data.taskId, ...FLAGS);
    expect([st.code, st.data.status]).toEqual([0, 'completed']);
    const dl = await f.pcli('download', '--task-id', data.taskId, ...FLAGS, '--out-dir', '/work/again');
    expect(dl.code, JSON.stringify(dl.data)).toBe(0);
    expect(dl.data.materials).toHaveLength(2);
    expect(f.stub.requests.length - before).toBe(1);
    await noSecret(f);
  });

  it('does nothing without --confirm (exit 3)', async () => {
    const f = await flow();
    const q = await f.quote();
    const { code, data } = await f.pcli('generate', '--quote-id', q.quote.quoteId, ...FLAGS, '--out-dir', OUT);
    expect(code).toBe(3);
    expect(data).toMatchObject({ ok: false, code: 3 });
    expect(f.stub.calls('POST', '/images/generations')).toEqual([]);
    expect(await f.ledger()).toEqual([]);
  });

  it('plans a dry run without a key, without network and without touching the ledger', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    const dead = 'http://127.0.0.1:1/api/open/v1';
    const offline = { ...f.rt, env: { ...f.rt.env, POPOST_API_KEY: undefined, POPOST_BASE_URL: dead } };
    const before = f.stub.requests.length;
    const { code, data } = await cli(offline, 'provider', 'cli', 'generate', '--quote-id', rec.quoteId, '--confirm', '--dry-run', ...FLAGS, '--out-dir', OUT);
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data).toMatchObject({ dryRun: true, charged: false });
    const req = data.plan.request;
    expect(req.url).toBe(`${dead}/images/generations`);
    expect(req.headers.Authorization).toBe('Bearer $POPOST_API_KEY');
    expect(req.headers['x-popost-client']).toBe('skill');
    expect(req.body.maxCredits).toBe(12);
    expect(req.body.idempotencyKey).toMatch(/^skill-/);
    expect(await f.ledger()).toEqual([]);
    expect(await f.rt.fs.stat(OUT)).toBeNull();
    const plan = await cli(offline, 'provider', 'cli', 'quote', ...FLAGS, '--prompt', 'x', '--dry-run');
    expect(plan.code, JSON.stringify(plan.data)).toBe(0);
    expect(plan.data.plan.request.url).toBe(`${dead}/images/quote`);
    expect(f.stub.requests.length).toBe(before);
    await noSecret(f);
  });

  it('records a timeout as ambiguous (with the key and the retry hint) and never retries', async () => {
    const f = await flow({ generationTimeoutSec: 0.05 });
    const rec = (await f.quote()).quote;
    f.stub.delays.set(`POST ${API}/images/generations`, 400);
    const { code, data } = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(code, JSON.stringify(data)).toBe(1);
    const key = (await f.ledger())[0].meta.idempotencyKey;
    expect(data.error).toContain('ambiguous');
    expect(data.error).toContain(key);
    expect(data.error).toContain('--idempotency-key');
    expect((await f.ledger()).at(-1).state).toBe('ambiguous');
    expect(f.stub.calls('POST', '/images/generations')).toHaveLength(1);
    const retry = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(retry.code).toBe(1);
    expect(f.stub.calls('POST', '/images/generations')).toHaveLength(1);
    await noSecret(f);
  });

  it('reuses a given idempotency key for a manual retry and rejects a malformed one', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    const run = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', '--idempotency-key', 'skill-retry-key-123456', ...FLAGS, '--out-dir', OUT);
    expect(run.code, JSON.stringify(run.data)).toBe(0);
    expect(f.stub.calls('POST', '/images/generations')[0]!.json!.idempotencyKey).toBe('skill-retry-key-123456');
    const two = (await f.quote('--count', '2')).quote;
    const before = f.stub.requests.length;
    const bad = await f.pcli('generate', '--quote-id', two.quoteId, '--confirm', '--idempotency-key', 'bad key!', ...FLAGS, '--out-dir', OUT);
    expect(bad.code).toBe(2);
    expect(f.stub.requests.length).toBe(before);
  });

  it('turns a CREDIT_LIMIT_EXCEEDED answer into a rejection and settles the ledger as not charged', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    f.stub.set('POST', '/images/generations', err(409, 'CREDIT_LIMIT_EXCEEDED', 'over', { required: 40, balance: 500, maxCredits: 12 }));
    const { code, data } = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(code).toBe(1);
    expect(data.error).toContain('未扣费');
    expect(data.error).toContain('CREDIT_LIMIT_EXCEEDED');
    const last = (await f.ledger()).at(-1);
    expect(last.state).toBe('ambiguous');
    expect(last.meta.charged).toBe(false);
  });
});

describe('quote refusals', () => {
  it('reports an invalid key and an outdated Skill at quote time and writes no quote', async () => {
    const f = await flow();
    f.stub.set('GET', '/models', err(401, 'UNAUTHORIZED', 'bad key'));
    let r = await f.pcli('quote', ...FLAGS, '--prompt', 'x');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('POPOST_API_KEY');
    f.stub.set('GET', '/models', err(426, 'CLI_VERSION_TOO_OLD', 'old', { minVersion: '99.0.0' }));
    r = await f.pcli('quote', ...FLAGS, '--prompt', 'x');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('更新 popost Skill');
    expect(await f.rt.fs.stat('/work/quotes')).toBeNull();
    await noSecret(f);
  });

  it('reports rate limiting and insufficient credits', async () => {
    const f = await flow();
    f.stub.set('POST', '/images/quote', err(429, 'RATE_LIMITED', 'slow', { retryAfterSeconds: 9 }));
    let r = await f.pcli('quote', ...FLAGS, '--prompt', 'x');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('9 秒');
    f.stub.clear('POST', '/images/quote');
    f.stub.balance = 5;
    r = await f.pcli('quote', ...FLAGS, '--prompt', 'x');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('积分不足');
  });

  it('stops generation when the live price moved since the quote', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    f.stub.models[0]!.creditsPerImage = 15;
    const { code, data } = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(code).toBe(1);
    expect(data.error).toContain('价格已变动');
    expect(f.stub.calls('POST', '/images/generations')).toEqual([]);
    expect(await f.ledger()).toEqual([]);
  });

  it('rejects unsupported capabilities before asking for a quote (exit 2)', async () => {
    const f = await flow();
    let r = await f.pcli('quote', ...FLAGS, '--prompt', 'x', '--aspect-ratio', '16:9');
    expect(r.code).toBe(2);
    expect(r.data.error).toContain('16:9');
    r = await f.pcli('quote', ...FLAGS, '--prompt', 'x', '--count', '6');
    expect(r.code).toBe(2);
    expect(f.stub.calls('POST', '/images/quote')).toEqual([]);
  });

  it('locks the model to the default unless the private config allows another, and lets the platform choose when none is fixed', async () => {
    const f = await flow();
    let r = await f.pcli('quote', ...FLAGS, '--prompt', 'x', '--model', 'stub-model-b');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('锁定');
    await f.writeCfg({ providerOverrides: [{ provider: 'popost', model: 'stub-model-b' }] });
    r = await f.pcli('quote', ...FLAGS, '--prompt', 'x', '--model', 'stub-model-b', '--aspect-ratio', '1:1');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(r.data.billing.totalCredits).toBe('20');
    await f.writeCfg({});
    for (const m of f.stub.models) delete m.isDefault;
    r = await f.pcli('quote', ...FLAGS, '--prompt', 'x', '--aspect-ratio', '1:1');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(f.stub.calls('POST', '/images/quote').at(-1)!.json).not.toHaveProperty('model');
    expect(r.data.quote.model).toBe('stub-model-a');
    const gen = await f.pcli('generate', '--quote-id', r.data.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(gen.code, JSON.stringify(gen.data)).toBe(0);
    expect(f.stub.calls('POST', '/images/generations')[0]!.json!.model).toBe('stub-model-a');
  });

  it('is an environment error (exit 2) without a key, and sends nothing', async () => {
    const f = await flow({}, { POPOST_API_KEY: undefined });
    const { code, data } = await f.pcli('quote', ...FLAGS, '--prompt', 'x');
    expect(code).toBe(2);
    expect(data.error).toContain('POPOST_API_KEY');
    expect(f.stub.requests).toEqual([]);
  });

  it('checks without leaking: unmeasured without a key, measured with one', async () => {
    const noKey = await flow({}, { POPOST_API_KEY: undefined });
    let r = await noKey.pcli('--provider', 'popost', 'check');
    expect(r.data.checks.popost).toMatchObject({ ok: false, measured: false });
    expect(noKey.stub.requests).toEqual([]);
    const f = await flow();
    r = await f.pcli('--provider', 'popost', 'check');
    expect(r.code).toBe(0);
    expect(r.data.checks.popost.measured).toBe(true);
    expect(r.data.checks.popost.message).toContain('stub-model-a');
    await noSecret(f);
  });
});

describe('quote files and the ledger', () => {
  it('refuses a quote file that was edited, an unknown quote id, and an expired quote', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    const path = `/work/quotes/${rec.quoteId}.json`;
    const original = await f.rt.fs.readText(path);
    await f.rt.fs.writeFile(path, original.replace('"totalCredits": "12"', '"totalCredits": "1"'));
    let r = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('完整性');
    r = await f.pcli('generate', '--quote-id', 'q_nope', '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(r.data.error).toContain('不存在');
    await f.rt.fs.writeFile(path, '{ not json');
    r = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect([r.code, r.data.error]).toEqual([1, expect.stringContaining('不是合法 JSON')]);
    await f.rt.fs.writeFile(path, original);
    const later = { ...f.rt, now: () => new Date(Date.UTC(2027, 0, 1)) };
    r = await cli(later, 'provider', 'cli', 'generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('已过期');
    expect(f.stub.calls('POST', '/images/generations')).toEqual([]);
  });

  it('refuses a changed prompt, changed model and changed reference bytes', async () => {
    const f = await flow();
    const rec = (await f.quote('--ref', '/work/ref.png')).quote;
    const base = ['generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT];
    let r = await f.pcli(...base, '--prompt', 'something else entirely');
    expect([r.code, r.data.error]).toEqual([1, expect.stringContaining('不一致')]);
    r = await f.pcli(...base, '--model', 'stub-model-b');
    expect(r.code).toBe(1);
    await f.rt.fs.writeFile('/work/ref.png', tinyPng([9, 9, 9], 3));
    r = await f.pcli(...base);
    expect([r.code, r.data.error]).toEqual([1, expect.stringContaining('reference bytes changed')]);
    expect(f.stub.calls('POST', '/images/generations')).toEqual([]);
  });

  it('refuses when the endpoint changed after the quote', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    await f.writeCfg({ defaultModel: 'stub-model-a' });
    const r = await f.pcli('generate', '--quote-id', rec.quoteId, '--confirm', ...FLAGS, '--out-dir', OUT);
    expect([r.code, r.data.error]).toEqual([1, expect.stringContaining('端点')]);
  });

  it('accepts a request that quotes, and the quote file has no secrets and a stable shape', async () => {
    const f = await flow();
    const rec = (await f.quote()).quote;
    expect(rec).toMatchObject({ schemaVersion: 'quote.v1', provider: 'popost', status: 'quoted', confirmRequired: true, mock: false, totalCredits: '12', unknownCostAcknowledged: false });
    expect(rec.pricingSnapshot).toMatchObject({ unitCredits: '12', billingUnit: 'credits', priceSource: 'popost.ai /images/quote' });
    expect(rec.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(rec.quoteId).toMatch(/^q_\d{14}_[0-9a-f]{8}$/);
    await noSecret(f);
  });

  it('computes the binding hashes exactly as the Python Skill did, so a stored quote still verifies', async () => {
    const { rt } = await newScene({ env: { POPOST_BASE_URL: undefined, POPOST_API_KEY: undefined } });
    const binding = endpointBinding(rt, 'popost', { baseUrl: 'https://stub.popost.test/api/open/v1/', defaultModel: 'm' });
    expect(binding).toBe('e9dd26d7659d0bc1');
    const snapshot = { unitCredits: '12', label: 'Stub model A', billingUnit: 'credits', priceFetchedAt: '2026-11-05T00:00:00+00:00', priceSource: 'popost.ai /images/quote', pricingVersion: null, endpointBinding: binding };
    const refs = [{ kind: 'local', value: '/work/ref.png', sha256: 'ab'.repeat(32) }, { kind: 'url', value: 'https://cdn.example.com/s.png', sha256: null }];
    const payload = { provider: 'popost', model: 'stub-model-a', prompt: 'a  quiet desk\nat dawn – 晨光', aspect: '3:4', count: 2, refs, pricingSnapshot: snapshot };
    expect(requestHash(payload)).toBe('0150cb7ac40c8ad50cd98e016a822e05f345f1d3c3ff33749c7ee3da2128f304');
    const record = { schemaVersion: 'quote.v1', quoteId: 'q_x', provider: 'popost', model: 'stub-model-a', prompt: payload.prompt, aspect: '3:4', count: 2, refs, pricingSnapshot: snapshot, totalCredits: '24', expiresAt: '2026-11-05T00:10:00+00:00', endpointBinding: binding, unknownCostAcknowledged: false };
    expect(recordIntegrityHash(record)).toBe('67d7ab81c569b5abcfce2380f571469c3fc369c579871bd4c2f072a61cbdb9cd');
    const custom = { mode: 'http', baseUrl: 'https://x.test', model: 'm', auth: { envVar: 'K' }, billing: { unit: 'USD', b: 1 }, capabilities: { aspects: ['1:1'], referenceImages: true }, referenceTransport: 'data-uri' };
    expect(endpointBinding(rt, 'custom', custom)).toBe('2142efd5ca4b3765');
    expect(endpointBinding(rt, 'custom', { baseUrl: 'https://x.test' })).toBe('e27340f6fbb7d692');
    expect(endpointBinding(rt, 'manual', {})).toBe('38e52d5df36cc3de');
  });
});


describe('quote account binding', () => {
  it('refuses an old quote after the effective Key changes without submitting or printing either key', async () => {
    const f = await flow();
    const q = await f.quote();
    const otherKey = 'another-account-placeholder';
    const rt = { ...f.rt, env: { ...f.rt.env, POPOST_API_KEY: otherKey } };
    const r = await cli(rt, 'provider', 'cli', 'generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS);
    expect(r.code).not.toBe(0);
    expect(f.stub.calls('POST', '/images/generations')).toHaveLength(0);
    expect(r.stdout + r.stderr).not.toContain(otherKey);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
});
