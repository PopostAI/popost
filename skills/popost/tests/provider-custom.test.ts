/**
 * The bring-your-own-key channel (`custom`): OpenAI-compatible and templated HTTP APIs, unknown prices, and what happens
 * when the host refuses the URL. A fake provider API sits behind `rt.fetch`; the key must appear nowhere.
 */
import { describe, expect, it } from 'vitest';
import { CustomHttpProvider } from '../src/providers/custom-http';
import { ImageProviderError } from '../src/providers/errors';
import type { FetchHandler } from '../src/testing/memory';
import { API, b64, BASE_URL, BlockedFetchError, cli, everythingWritten, headersOf, newScene, ORIGIN, restrictTo, tinyPng, type Json, type Scene } from './image-helpers';

const SECRET = 'byok-secret-9876';
const HOST = 'https://custom.example.test';
const FLAGS = ['--quote-dir', '/work/quotes', '--ledger', '/work/ledger.jsonl'];
const PNG = tinyPng([5, 150, 80]);

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  json: Json;
}

/** A provider API: `/v1/models`, `/v1/images/generations`, and a templated submit / poll / download trio. */
const customApi = (seen: Seen[], options: { generations?: () => Response } = {}) => {
  let polls = 0;
  const handler: FetchHandler = async (request) => {
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: headersOf(request.headers), json: text ? JSON.parse(text) : null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'img-1', price: 3 }, { id: 'img-2', credits: 5 }] });
    if (url.pathname === '/v1/images/generations') return options.generations ? options.generations() : json({ data: [{ b64_json: b64(PNG) }] });
    if (url.pathname === '/api/tasks') return json({ data: { task_id: 't1' } });
    if (url.pathname === '/api/tasks/t1') {
      polls += 1;
      return json(polls < 2 ? { data: { status: 'running' } } : { data: { status: 'done', result_url: `${HOST}/out.png` } });
    }
    if (url.pathname === '/out.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    return json({ error: 'no route' }, 404);
  };
  return handler;
};

const setup = async (custom: Record<string, unknown>, options: { handler?: (seen: Seen[]) => FetchHandler; env?: Record<string, string | undefined> } = {}) => {
  const seen: Seen[] = [];
  const handler = options.handler ? options.handler(seen) : customApi(seen);
  const scene: Scene = await newScene({ fetchHandler: () => handler, env: { MY_KEY: SECRET, ...options.env }, files: { '/work/cfg.json': JSON.stringify({ custom }), '/work/ref.png': tinyPng() } });
  const pcli = (...args: string[]) => cli(scene.rt, 'provider', 'cli', '--provider', 'custom', '--config', '/work/cfg.json', ...args);
  const ledger = async () => (await scene.rt.fs.readText('/work/ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...scene, seen, pcli, ledger };
};

const openai = { mode: 'openai-compatible', baseUrl: HOST, auth: { envVar: 'MY_KEY' }, billing: { unit: 'USD' } };

describe('openai-compatible', () => {
  it('quotes from the live model list and sends the key only to the configured host', async () => {
    const t = await setup(openai);
    const { code, data } = await t.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.quote).toMatchObject({ provider: 'custom', model: 'img-1', totalCredits: '3' });
    expect(data.billing).toMatchObject({ unit: 'USD', priceStatus: 'quoted', charged: false, totalAmount: '3' });
    expect(t.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(SECRET);
  });

  it('generates synchronously from base64, settles the ledger and writes the image', async () => {
    const t = await setup(openai);
    const q = (await t.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1')).data;
    const { code, data } = await t.pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', '/work/out');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.taskId).toMatch(/^sync-[0-9a-f]{12}$/);
    expect(await t.rt.fs.readFile(data.materials[0].localPath)).toEqual(PNG);
    expect((await t.ledger()).map((l) => l.state)).toEqual(['reserved', 'consumed']);
    expect(t.seen.find((s) => s.path === '/v1/images/generations')!.json).toMatchObject({ model: 'img-1', prompt: 'a cat', n: 1, size: '1:1' });
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(SECRET);
  });

  it('refuses a zero or unknown price unless the cost was explicitly accepted', async () => {
    const t = await setup({ mode: 'openai-compatible', baseUrl: HOST, model: 'local-test', skipModelDiscovery: true, billing: { unit: 'USD' } });
    const refused = await t.pcli('quote', ...FLAGS, '--prompt', 'test');
    expect(refused.code).not.toBe(0);
    const accepted = await t.pcli('quote', ...FLAGS, '--prompt', 'test', '--accept-unknown-cost');
    expect(accepted.code, JSON.stringify(accepted.data)).toBe(0);
    expect(accepted.data.billing).toMatchObject({ totalAmount: null, priceStatus: 'unknown', unit: 'USD' });
    expect(t.seen).toEqual([]); // no discovery was needed
  });

  it('sends a local reference as its content and only when the profile declares reference support', async () => {
    const { rt } = await newScene({ files: { '/work/ref.png': tinyPng() } });
    const config = { baseUrl: HOST, model: 'test' };
    await expect(new CustomHttpProvider(rt, { config, dryRun: true }).submit('test', { refs: ['/work/ref.png'] })).rejects.toBeInstanceOf(ImageProviderError);
    const withRefs = new CustomHttpProvider(rt, { config: { ...config, capabilities: { referenceImages: true } }, dryRun: true });
    const plan = (await withRefs.submit('test', { refs: ['/work/ref.png'] })) as Json;
    expect(plan.request.body.image[0]).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(plan.request.body)).not.toContain('/work/ref.png');
  });

  it('is a plain refusal on a 4xx answer and an unknown outcome on a 5xx', async () => {
    for (const [status, charged] of [[400, false], [503, undefined]] as const) {
      const t = await setup(openai, { handler: (seen) => customApi(seen, { generations: () => new Response('{}', { status }) }) });
      const q = (await t.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1')).data;
      const { code, data } = await t.pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', '/work/out');
      expect(code).toBe(1);
      expect(data.error).toContain(status === 400 ? 'no order was created' : 'whether the order was accepted is unknown');
      const last = (await t.ledger()).at(-1);
      expect(last.state).toBe('ambiguous');
      expect(last.meta.charged).toBe(charged);
    }
  });
});

describe('http templates', () => {
  const http = {
    mode: 'http',
    baseUrl: HOST,
    model: 'tpl',
    creditsPerRequest: 2,
    auth: { envVar: 'MY_KEY' },
    billing: { unit: 'USD' },
    http: {
      submit: { method: 'POST', url: '{baseUrl}/api/tasks', body: { prompt: '{prompt}', n: '{count}' }, taskIdPath: 'data.task_id' },
      poll: { method: 'GET', url: '{baseUrl}/api/tasks/{taskId}', statusPath: 'data.status', doneValues: ['done'] },
      download: { urlPath: 'data.result_url' },
    },
  };

  it('submits, polls until done and downloads the result', async () => {
    const t = await setup(http);
    const q = (await t.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1')).data;
    expect(q.quote.model).toBe('tpl');
    const { code, data } = await t.pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', '/work/out', '--poll-interval', '0.01');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.taskId).toBe('t1');
    expect(await t.rt.fs.readFile(data.materials[0].localPath)).toEqual(PNG);
    expect(t.seen.find((s) => s.path === '/api/tasks')!.json).toEqual({ prompt: 'a cat', n: '1' });
    expect((await t.ledger()).at(-1).state).toBe('consumed');
  });

  it('reads status of an existing task id without submitting', async () => {
    const t = await setup(http);
    const first = await t.pcli('status', '--task-id', 't1');
    expect([first.code, first.data.status]).toEqual([0, 'running']);
    const second = await t.pcli('status', '--task-id', 't1', '--raw');
    expect(second.data.status).toBe('completed');
    expect(second.data.raw.raw.data.result_url).toBe(`${HOST}/out.png`);
    expect(t.seen.every((s) => s.method === 'GET')).toBe(true);
  });
});

describe('a host that restricts the network', () => {
  const restricted = (seen: Seen[]) => restrictTo(customApi(seen), [BASE_URL]);

  it('fails a custom provider pointed elsewhere with the normal error JSON, not a crash', async () => {
    const skip = await setup({ ...openai, model: 'img-1', skipModelDiscovery: true, creditsPerRequest: 3 }, { handler: restricted });
    const q = (await skip.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1')).data;
    const { code, data } = await skip.pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', '/work/out');
    expect(code).toBe(1);
    expect(data).toMatchObject({ ok: false, code: 1 });
    expect(data.error).toContain('does not allow connections');
    expect(data.error).not.toContain(SECRET);
    const last = (await skip.ledger()).at(-1);
    expect([last.state, last.meta.charged]).toEqual(['ambiguous', false]); // refused before anything was sent
    expect(skip.seen).toEqual([]);

    const discover = await setup(openai, { handler: restricted });
    const refused = await discover.pcli('quote', ...FLAGS, '--prompt', 'a cat');
    expect(refused.code).toBe(1);
    expect(refused.data.error).toContain('GET /v1/models failed');
    const check = await discover.pcli('check');
    expect(check.code).toBe(0);
    expect(check.data.checks.custom.ok).toBe(false);
  });

  it('is not a crash when the refusal comes from fetch itself', async () => {
    const t = await setup({ ...openai, model: 'img-1', skipModelDiscovery: true, creditsPerRequest: 3 }, { handler: () => async () => { throw new BlockedFetchError('blocked'); } });
    const r = await t.pcli('models');
    expect(r.code).toBe(0); // skipModelDiscovery needs no request
    expect(r.data.models[0]).toMatchObject({ value: 'img-1', credits: 3, known: true });
  });

  it('keeps the official channel working under the same restriction (only the open API prefix is used)', async () => {
    const scene = await newScene({ fetchHandler: (stub) => restrictTo(stub.fetch, [`${ORIGIN}${API}/`, `${ORIGIN}/fonts/`]), files: { '/work/cfg.json': '{}' } });
    const r = await cli(scene.rt, 'provider', 'cli', '--config', '/work/cfg.json', 'quote', ...FLAGS, '--prompt', 'x', '--aspect-ratio', '3:4');
    expect(r.code, JSON.stringify(r.data)).toBe(0);
    expect(scene.stub.requests.map((q) => q.path).every((p) => p.startsWith(API))).toBe(true);
  });
});

describe('credentials', () => {
  it('scrubs the key out of a network error before it is shown or written to the ledger', async () => {
    const t = await setup({ ...openai, model: 'img-1', skipModelDiscovery: true, creditsPerRequest: 3 }, {
      handler: () => async () => {
        throw new Error(`proxy refused request with Authorization: Bearer ${SECRET}`);
      },
    });
    const q = (await t.pcli('quote', ...FLAGS, '--prompt', 'a cat', '--aspect-ratio', '1:1')).data;
    const { code, data } = await t.pcli('generate', '--quote-id', q.quote.quoteId, '--confirm', ...FLAGS, '--out-dir', '/work/out');
    expect(code).toBe(1);
    expect(data.error).toContain('[REDACTED]');
    for (const blob of await everythingWritten(t.rt)) expect(blob).not.toContain(SECRET);
  });

  it('reaches the real parser through the adapter and names a missing variable without a value', async () => {
    const t = await setup({ mode: 'openai-compatible', baseUrl: HOST, model: 'local-test', skipModelDiscovery: true, creditsPerRequest: 2, billing: { unit: 'USD' } });
    const { code, data } = await cli(t.rt, 'provider', 'quote', '--prompt', 'local parser test', '--provider', 'custom', '--config', '/work/cfg.json');
    expect(code, JSON.stringify(data)).toBe(0);
    expect(data.delegated.quote.model).toBe('local-test');
    const missing = await setup(openai, { env: { MY_KEY: undefined } });
    const r = await missing.pcli('quote', ...FLAGS, '--prompt', 'a cat');
    expect(r.code).toBe(1);
    expect(r.data.error).toContain('MY_KEY');
  });
});
