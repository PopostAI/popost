/**
 * The popost.ai platform channel at provider level: client, envelope errors, quote and generation, safety rules
 * (port of the client / provider half of test_popost_provider.py, against an in-memory fake of the open API).
 */
import { describe, expect, it } from 'vitest';
import { PopostClient } from '../src/providers/api';
import { AmbiguousSubmitError, CapabilityError, ImageProviderError, PopostApiError } from '../src/providers/errors';
import { PopostProvider } from '../src/providers/popost';
import { VERSION } from '../src/version';
import { API, BASE_URL, BlockedFetchError, err, KEY, newScene, ORIGIN, refused, restrictTo, tinyPng } from './image-helpers';

const provider = async (config: Record<string, unknown> = {}) => {
  const scene = await newScene();
  const p = new PopostProvider(scene.rt, { config: { baseUrl: BASE_URL, ...config } });
  p.taskDir = '/work/tasks';
  return { ...scene, p };
};

const failure = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
};

describe('client and model list', () => {
  it('sends the platform headers and keeps upstream vendor details out of the rows', async () => {
    const { p, stub } = await provider();
    const rows = await p.models();
    expect(rows.map((r) => r.value)).toEqual(['stub-model-a', 'stub-model-b']);
    expect(rows[0]).toMatchObject({ label: 'Stub model A', credits: 12, known: true, isDefault: true, aspectRatios: ['1:1', '3:4', '9:16'] });
    expect(JSON.stringify(rows)).not.toMatch(/SomeUpstreamVendor|vendor/);
    const req = stub.requests[0]!;
    expect([req.method, req.path, req.query]).toEqual(['GET', `${API}/models`, { kind: 'image' }]);
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers['x-popost-client']).toBe('skill');
    expect(req.headers['x-popost-client-version']).toBe(VERSION);
    expect(req.headers['user-agent']).toContain(`popost-skill/${VERSION}`);
    expect(req.headers['content-type']).toBeUndefined(); // a GET has no body
  });

  it('puts a JSON content type on a POST and sends the capability fields', async () => {
    const { p, stub } = await provider();
    await p.quote({ aspect: '3:4', count: 2 });
    const req = stub.calls('POST', '/images/quote')[0]!;
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.json).toEqual({ n: 2, aspectRatio: '3:4', referenceImageCount: 0, model: 'stub-model-a' });
  });

  it.each([
    [401, 'UNAUTHORIZED', undefined, ['账户连接已失效', 'POPOST_API_KEY']],
    [403, 'FORBIDDEN', undefined, ['无权']],
    [402, 'INSUFFICIENT_CREDITS', { required: 24, balance: 5 }, ['积分不足', '24', '5']],
    [409, 'CREDIT_LIMIT_EXCEEDED', { required: 30, balance: 99, maxCredits: 24 }, ['上限', '30', '24']],
    [429, 'RATE_LIMITED', { retryAfterSeconds: 17 }, ['17 秒']],
    [426, 'CLI_VERSION_TOO_OLD', { minVersion: '9.0.0' }, ['更新', '9.0.0', VERSION]],
    [400, 'INVALID_REQUEST', { issues: [{ path: ['aspectRatio'], message: 'bad ratio' }] }, ['aspectRatio', 'bad ratio']],
    [422, 'CONTENT_REJECTED', undefined, ['审核']],
    [503, 'SERVICE_UNAVAILABLE', undefined, ['不可用']],
    [501, 'NOT_IMPLEMENTED', undefined, ['尚未开放']],
  ])('maps the %i %s envelope to a clear message, never to "ambiguous"', async (status, code, details, fragments) => {
    const { p, stub } = await provider();
    stub.set('POST', '/images/quote', err(status, code, 'srv says no', details));
    const error = (await failure(() => p.quote())) as PopostApiError;
    expect(error).toBeInstanceOf(PopostApiError);
    expect(error).not.toBeInstanceOf(AmbiguousSubmitError);
    expect(error.code).toBe(code);
    for (const fragment of [...fragments, code]) expect(error.message).toContain(fragment);
    expect(error.message).not.toContain(KEY);
  });

  it('trusts the envelope code over the HTTP status', async () => {
    const { p, stub } = await provider();
    stub.set('GET', '/models', err(200, 'UNAUTHORIZED'));
    expect(((await failure(() => p.models())) as PopostApiError).code).toBe('UNAUTHORIZED');
    stub.set('GET', '/models', err(500, 'RATE_LIMITED', 'x', { retryAfterSeconds: 3 }));
    expect(((await failure(() => new PopostProvider(p.rt, { config: { baseUrl: BASE_URL } }).models())) as PopostApiError).code).toBe('RATE_LIMITED');
  });

  it('treats a malformed body on a read as a plain error', async () => {
    const { p, stub } = await provider();
    stub.set('GET', '/models', [200, '<<not json']);
    const error = (await failure(() => p.models())) as PopostApiError;
    expect(error.code).toBe('BAD_RESPONSE');
    expect(error).not.toBeInstanceOf(AmbiguousSubmitError);
  });

  it('sends nothing without a key', async () => {
    const scene = await newScene({ env: { POPOST_API_KEY: undefined } });
    const p = new PopostProvider(scene.rt, { config: { baseUrl: BASE_URL } });
    const error = (await failure(() => p.models())) as PopostApiError;
    expect(error.code).toBe('NO_API_KEY');
    expect(error.message).toContain('POPOST_API_KEY');
    expect(await p.check()).toEqual([false, false, expect.stringContaining('POPOST_API_KEY')]);
    expect(scene.stub.requests).toEqual([]);
  });

  it('reads the key from the variable the config names', async () => {
    const scene = await newScene({ env: { MY_POPOST_KEY: 'sk-other-env' } });
    await new PopostProvider(scene.rt, { config: { baseUrl: BASE_URL, auth: { envVar: 'MY_POPOST_KEY' } } }).models();
    expect(scene.stub.requests[0]!.headers.authorization).toBe('Bearer sk-other-env');
  });

  it('applies the base URL rules: https (or loopback http), config > POPOST_BASE_URL > default', async () => {
    const { rt } = await newScene({ env: { POPOST_BASE_URL: undefined } });
    expect(() => new PopostClient(rt, { baseUrl: 'http://example.com/api/open/v1' })).toThrow(PopostApiError);
    expect(() => new PopostClient(rt, { baseUrl: 'http://127.0.0.1:3000/api/open/v1' })).not.toThrow();
    expect(() => new PopostClient(rt, { baseUrl: 'http://localhost:3000/api/open/v1' })).not.toThrow();
    expect(new PopostClient(rt).baseUrl).toBe('https://popost.ai/api/open/v1');
    const withEnv = await newScene({ env: { POPOST_BASE_URL: `${BASE_URL}/` } });
    expect(new PopostClient(withEnv.rt).baseUrl).toBe(BASE_URL);
    await new PopostProvider(withEnv.rt, { config: {} }).models();
    expect(withEnv.stub.calls('GET', '/models')).toHaveLength(1);
  });

  it('refuses a key written into the config and never echoes it', async () => {
    const { rt } = await newScene();
    const error = (() => {
      try {
        new PopostProvider(rt, { config: { apiKey: KEY } });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a failure');
    })();
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.message).not.toContain(KEY);
    expect(() => new PopostProvider(rt, { config: { auth: { token: 'x' } } })).toThrow(ImageProviderError);
  });
});

describe('capabilities and generation', () => {
  it('checks the model limits before any quote request', async () => {
    const { p, stub, rt } = await provider();
    await rt.fs.writeFile('/work/r.png', tinyPng());
    await rt.fs.writeFile('/work/r.txt', 'hello');
    await expect(p.quote({ aspect: '16:9' })).rejects.toBeInstanceOf(CapabilityError); // not in aspectRatios
    await expect(p.quote({ count: 5 })).rejects.toBeInstanceOf(CapabilityError); // > maxImagesPerRequest 4
    await expect(p.quote({ refs: Array(4).fill('/work/r.png') })).rejects.toBeInstanceOf(CapabilityError); // > maxReferenceImages 3
    await expect(p.quote({ refs: ['/work/r.txt'] })).rejects.toBeInstanceOf(CapabilityError); // not an image
    expect(stub.calls('POST', '/images/quote')).toEqual([]);
  });

  it('reports an unknown outcome as ambiguous, with the idempotency key and without the secret', async () => {
    const { p, stub } = await provider();
    const options = { idempotencyKey: 'skill-test-key-0001' };
    for (const reply of [[200, '{oops'], [502, '<html>bad gateway</html>'], err(504, 'TIMEOUT'), err(500, 'INTERNAL_ERROR')] as const) {
      stub.set('POST', '/images/generations', reply);
      const error = await failure(() => p.submit('a cat', { aspect: '1:1', model: 'stub-model-a', options }));
      expect(error, String(reply[0])).toBeInstanceOf(AmbiguousSubmitError);
      expect(error.message).toContain('skill-test-key-0001');
      expect(error.message).not.toContain(KEY);
    }
    stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED')); // an explicit refusal: nothing charged
    const refusal = await failure(() => p.submit('a cat', { aspect: '1:1', model: 'stub-model-a' }));
    expect(refusal).toBeInstanceOf(PopostApiError);
    expect(refusal).not.toBeInstanceOf(AmbiguousSubmitError);
  });

  it('keeps an empty task folder as the trace of a request that went out, and removes it after a refusal', async () => {
    const { p, stub, rt } = await provider();
    stub.set('POST', '/images/generations', err(502, 'INTERNAL_ERROR'));
    await failure(() => p.submit('a cat', { model: 'stub-model-a' }));
    expect(await rt.fs.readdir('/work/tasks')).toHaveLength(1);
    stub.set('POST', '/images/generations', err(422, 'CONTENT_REJECTED'));
    await failure(() => p.submit('a cat', { model: 'stub-model-a' }));
    expect(await rt.fs.readdir('/work/tasks')).toHaveLength(1);
  });

  it('treats a turn that ends while the request is in flight as an unknown outcome', async () => {
    const { stub, rt } = await provider();
    const ctl = new AbortController();
    const aborting = new PopostProvider({ ...rt, signal: ctl.signal }, { config: { baseUrl: BASE_URL } });
    aborting.taskDir = '/work/tasks';
    await aborting.models(); // the list is read before the paid request
    stub.delays.set(`POST ${API}/images/generations`, 500);
    setTimeout(() => ctl.abort(), 30);
    const error = await failure(() => aborting.submit('a cat', { model: 'stub-model-a' }));
    expect(error).toBeInstanceOf(AmbiguousSubmitError);
  });

  it('is not ambiguous when the connection was refused', async () => {
    const scene = await newScene({ fetchHandler: () => refused });
    const p = new PopostProvider(scene.rt, { config: { baseUrl: 'http://127.0.0.1:1/api/open/v1' } });
    p.taskDir = '/work/tasks';
    (p as unknown as { rows: unknown }).rows = [{ value: 'stub-model-a', label: 'A', credits: 1, known: true }];
    const error = (await failure(() => p.submit('a cat', { model: 'stub-model-a' }))) as PopostApiError;
    expect(error.code).toBe('NETWORK');
    expect(error).not.toBeInstanceOf(AmbiguousSubmitError);
  });

  it('is not ambiguous when the host refuses the URL, and sends nothing', async () => {
    const scene = await newScene({ fetchHandler: (stub) => restrictTo(stub.fetch, [`${ORIGIN}/elsewhere/`]) });
    const p = new PopostProvider(scene.rt, { config: { baseUrl: BASE_URL } });
    const error = (await failure(() => p.models())) as PopostApiError;
    expect(error).toBeInstanceOf(PopostApiError);
    expect(error).not.toBeInstanceOf(AmbiguousSubmitError);
    expect(error.code).toBe('NETWORK');
    expect(error.message).toContain('不允许访问');
    expect(error.message).not.toContain(KEY);
    expect(scene.stub.requests).toEqual([]);
    expect(error).not.toBeInstanceOf(BlockedFetchError); // reported as a normal provider error, not a crash
  });

  it('stores the answer in a task record and serves status / result / materialize from it', async () => {
    const { p, stub, rt } = await provider();
    const submitted = await p.submit('a cat', { aspect: '3:4', model: 'stub-model-a', count: 2, options: { idempotencyKey: 'skill-key-12345678', maxCredits: '24' } });
    expect(submitted).toMatchObject({ status: 'completed', model: 'stub-model-a', images: 2, costCredits: 24, balance: 476, idempotencyKey: 'skill-key-12345678' });
    expect(stub.calls('POST', '/images/generations')[0]!.json).toMatchObject({ maxCredits: 24, idempotencyKey: 'skill-key-12345678', model: 'stub-model-a', n: 2, aspectRatio: '3:4' });
    const taskId = submitted.taskId as string;
    expect(taskId).toMatch(/^pt-\d{14}-[0-9a-f]{10}$/);
    expect(await p.status(taskId)).toMatchObject({ taskId, status: 'completed', credits: 24 });
    const record = JSON.parse(await rt.fs.readText(`/work/tasks/${taskId}.json`));
    expect(record).toMatchObject({ schema: 'popost-task.v1', provider: 'popost', status: 'completed' });
    expect(JSON.stringify(record)).not.toContain('SomeUpstreamVendor');
    const before = stub.requests.length;
    const materials = await p.materialize(taskId, '/work/out', 'hero.png');
    expect(materials.map((m) => m.mimeType)).toEqual(['image/png', 'image/png']);
    expect(materials[0]).toMatchObject({ url: null });
    expect(String(materials[1]!.url)).toMatch(/\/files\/gen-1\.png$/);
    expect(stub.requests.length - before).toBe(1); // only the URL image is fetched again
    expect(await p.result(taskId)).toHaveLength(2);
  });

  it('refuses a bad task id and a missing record', async () => {
    const { p } = await provider();
    await expect(p.status('../etc/passwd')).rejects.toThrow('非法 taskId');
    await expect(p.status('pt-missing')).rejects.toThrow('本地没有任务记录');
  });
});
