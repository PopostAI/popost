/**
 * `popost video generate`, the built-in generator on the popost.ai Open API, against an in-memory platform: the image
 * tests' stub with the agreed video endpoints added here. No network, no real key; the clock is the test's own.
 */
import { describe, expect, it } from 'vitest';
import type { TestRuntime } from '../../src/testing/memory';
import { cli, err, KEY, newScene, ok, ORIGIN, tinyPng, type Json, type PopostStub, type Recorded } from '../image-helpers';

const CLIP = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom'), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const MOVE = new Uint8Array([0, 0, 0, 20, ...Buffer.from('ftypqt  '), 9, 9, 9, 9, 9, 9, 9, 9]);
const PRODUCT = tinyPng([200, 10, 10]);
const START = Date.parse('2026-11-24T10:00:00Z');
const MODEL = { id: 'video-a', label: 'Video A', resolutions: ['480p', '720p'], seconds: { min: 4, max: 15 }, aspectRatios: ['16:9', '9:16'], maxReferenceImages: 4, credits: { '480p': 5, '720p': 10 } };

type Reply = ReturnType<typeof ok>;

/** Keys sorted, so two bodies compare by what they say. */
const canonical = (value: Json): string =>
  JSON.stringify(value, (_key, v: Json) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** The video endpoints as agreed. A task is done at its readyAfter-th poll; a quote binds the body of the generation. */
class VideoApi {
  disabled = false;
  balance = 500;
  readyAfter = 2;
  failWith: { code: string; message: string } | null = null;
  /** The next answer of POST /videos/generations is lost after the task was made (a gateway error instead). */
  loseAnswer = false;
  readonly quotes = new Map<string, Json>();
  readonly tasks = new Map<string, Json>();
  private readonly byKey = new Map<string, string>();
  private readonly polls = new Map<string, number>();

  constructor(private readonly stub: PopostStub) {
    stub.files.set('clip.mp4', CLIP);
    const route = (method: string, path: string, handle: (req: Recorded) => Reply) =>
      stub.set(method, path, (req) => (this.disabled ? err(403, 'VIDEO_GENERATION_DISABLED', 'Video generation is turned off for this account') : handle(req)));
    route('GET', '/videos/models', () => ok({ models: [MODEL], default: 'video-a' }));
    route('POST', '/videos/uploads', (req) => this.upload(req.json ?? {}));
    route('POST', '/videos/quote', (req) => this.quote(req.json ?? {}));
    route('POST', '/videos/generations', (req) => this.create(req.json ?? {}));
    route('GET', '/videos/generations', (req) => this.poll(req.query.id ?? ''));
  }

  private upload(body: Json): Reply {
    const id = 'vu_' + this.stub.calls('POST', '/videos/uploads').length;
    return ok({ uploadId: id, uploadUrl: ORIGIN + '/storage/' + id, method: 'PUT', headers: { 'Content-Type': body.mimeType, 'x-stub-signature': 'sig-' + id }, expiresAt: '2026-12-01T10:00:00Z' });
  }

  private price = (body: Json): number => body.seconds * ((body.resolution ?? '480p') === '720p' ? 10 : 5);

  private quote(body: Json): Reply {
    const quoteId = 'q_' + (this.quotes.size + 1);
    this.quotes.set(quoteId, body);
    const { model = 'video-a', resolution = '480p', seconds, aspectRatio = '16:9' } = body;
    return ok({ quoteId, quoteExpiresAt: '2026-11-24T11:00:00Z', model, resolution, seconds, aspectRatio, credits: this.price(body), balance: this.balance });
  }

  private create(body: Json): Reply {
    const { prompt: _prompt, quoteId, idempotencyKey, ...rest } = body;
    const quoted = this.quotes.get(quoteId);
    if (!quoted) return err(400, 'QUOTE_EXPIRED', 'no such quote');
    if (canonical(quoted) !== canonical(rest)) return err(409, 'QUOTE_MISMATCH', 'the body differs from the quote');
    const known = this.byKey.get(idempotencyKey);
    const task = known ? this.tasks.get(known) : this.charge(quoted, idempotencyKey);
    if (!task) return err(402, 'INSUFFICIENT_CREDITS', 'not enough credits', { required: this.price(quoted), balance: this.balance });
    if (this.loseAnswer) {
      this.loseAnswer = false;
      return [502, 'bad gateway'];
    }
    return ok({ ...task });
  }

  private charge(quoted: Json, key: string): Json | undefined {
    const credits = this.price(quoted);
    if (this.balance < credits) return undefined;
    this.balance -= credits;
    const task = { id: 'vt_' + (this.tasks.size + 1), status: 'queued', model: quoted.model ?? 'video-a', resolution: quoted.resolution ?? '480p', seconds: quoted.seconds, aspectRatio: quoted.aspectRatio ?? '16:9', credits, createdAt: '2026-11-24T10:00:00Z' };
    this.tasks.set(task.id, task);
    this.byKey.set(key, task.id);
    return task;
  }

  private poll(id: string): Reply {
    const task = this.tasks.get(id);
    if (!task) return err(404, 'NOT_FOUND', 'no such task');
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    if (task.status === 'queued' || task.status === 'running') {
      if (n < this.readyAfter) task.status = 'running';
      else if (this.failWith) Object.assign(task, { status: 'failed', error: this.failWith });
      else Object.assign(task, { status: 'succeeded', completedAt: '2026-11-24T10:01:00Z', expiresAt: '2026-12-01T10:01:00Z', video: { url: ORIGIN + '/files/clip.mp4', urlExpiresAt: '2026-11-24T11:01:00Z', bytes: CLIP.length } });
    }
    return ok({ ...task });
  }
}

/** A platform stub with the video endpoints, two reference files, and a clock that moves only when the generator waits. */
const scene = async (env: Record<string, string | undefined> = {}) => {
  const base = await newScene({ env, files: { '/work/product.png': PRODUCT, '/work/move.mov': MOVE } });
  const api = new VideoApi(base.stub);
  const waited: number[] = [];
  let now = START;
  const rt: TestRuntime = { ...base.rt, now: () => new Date(now), sleep: async (ms: number) => void (waited.push(ms), (now += ms)) };
  return { rt, stub: base.stub, api, waited };
};

const request = async (rt: TestRuntime, body: Json, file = '/work/req.json'): Promise<string> => {
  await rt.fs.writeFile(file, JSON.stringify(body));
  return file;
};

const generate = (rt: TestRuntime, ...args: string[]) => cli(rt, 'video', 'generate', ...args);

/** What a failure prints: one line, no stack, no key. */
const oneLine = (stderr: string): string => {
  const lines = stderr.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(stderr).not.toMatch(/\bat .+:\d+:\d+/);
  expect(stderr).not.toContain(KEY);
  return lines[0]!;
};

describe('popost video generate video', () => {
  it('uploads the references, prices the clip with the model and resolution of the environment, waits for it and downloads it', async () => {
    const { rt, stub, waited } = await scene({ POPOST_VIDEO_MODEL: 'video-a', POPOST_VIDEO_RESOLUTION: '720p', POPOST_GEN_MAX_CREDITS: '60' });
    const req = await request(rt, { prompt: 'a desk by a window', seconds: 5, aspect: '9:16', images: ['/work/product.png'], videos: ['/work/move.mov'], model: 'not-this-one', resolution: '1080p' });
    const r = await generate(rt, 'video', req, '/work/out.mp4');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"credits":50}\n');
    expect(await rt.fs.readFile('/work/out.mp4')).toEqual(CLIP);
    expect(stub.calls('POST', '/videos/uploads').map((c) => c.json)).toEqual([
      { kind: 'image', mimeType: 'image/png', bytes: PRODUCT.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { kind: 'video', mimeType: 'video/quicktime', bytes: MOVE.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(stub.uploads.get('vu_1')).toEqual(PRODUCT);
    expect(stub.uploads.get('vu_2')).toEqual(MOVE);
    expect(stub.calls('PUT', '/storage/vu_1')[0]?.headers).not.toHaveProperty('authorization');
    const quoted = { model: 'video-a', resolution: '720p', seconds: 5, aspectRatio: '9:16', references: { images: ['vu_1'], videos: ['vu_2'] } };
    expect(stub.calls('POST', '/videos/quote').map((c) => c.json)).toEqual([quoted]);
    const [created] = stub.calls('POST', '/videos/generations');
    expect(created?.json).toEqual({ ...quoted, prompt: 'a desk by a window', quoteId: 'q_1', idempotencyKey: expect.stringMatching(/^video-[0-9a-f]{64}$/) });
    expect(created?.headers).toMatchObject({ authorization: 'Bearer ' + KEY, 'x-popost-client': 'skill' });
    expect(stub.calls('GET', '/videos/generations').map((c) => c.query.id)).toEqual(['vt_1', 'vt_1']);
    expect(waited).toEqual([10_000, 10_000]);
  });

  it('derives the idempotency key from the request: the same request, the same key; another model or prompt, another one', async () => {
    const keyOf = async (env: Record<string, string>, body: Json): Promise<string> => {
      const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100', ...env });
      expect((await generate(rt, 'video', await request(rt, body), '/work/out.mp4')).code).toBe(0);
      return stub.calls('POST', '/videos/generations')[0]?.json?.idempotencyKey;
    };
    const body = { prompt: 'a desk', seconds: 4, images: ['/work/product.png'] };
    const first = await keyOf({}, body);
    expect(await keyOf({}, body)).toBe(first);
    expect(await keyOf({}, { ...body, model: 'video-b', resolution: '720p' })).toBe(first);
    expect(await keyOf({ POPOST_VIDEO_MODEL: 'video-b' }, body)).not.toBe(first);
    expect(await keyOf({}, { ...body, prompt: 'a chair' })).not.toBe(first);
  });

  it('picks its task up again after a timeout instead of paying again', async () => {
    const { rt, stub, api } = await scene({ POPOST_GEN_MAX_CREDITS: '100', POPOST_GEN_WAIT_MIN: '0.1' });
    api.readyAfter = 3;
    const req = await request(rt, { prompt: 'a desk', seconds: 5, images: ['/work/product.png'] });
    const late = await generate(rt, 'video', req, '/work/out.mp4');
    expect(late.code).toBe(1);
    expect(oneLine(late.stderr)).toMatch(/still being made on popost\.ai after 0\.1 minutes \(task vt_1, running\).*not paid twice/);
    expect(await rt.fs.stat('/work/out.mp4')).toBeNull();
    const again = await generate(rt, 'video', req, '/work/out.mp4');
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('{"credits":25}\n');
    expect([stub.calls('POST', '/videos/uploads'), stub.calls('POST', '/videos/quote'), stub.calls('POST', '/videos/generations')].map((c) => c.length)).toEqual([1, 1, 1]);
    expect(api.balance).toBe(475);
  });

  it('asks again with the same key and body when the answer to the request is lost, and is charged once', async () => {
    const { rt, stub, api } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    api.loseAnswer = true;
    const r = await generate(rt, 'video', await request(rt, { prompt: 'a desk', seconds: 5 }), '/work/out.mp4');
    expect(r.code).toBe(0);
    const sent = stub.calls('POST', '/videos/generations').map((c) => c.json);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect([api.tasks.size, api.balance]).toEqual([1, 475]);
  });

  it('charges nothing until the price is agreed: it prints the price and exits with 3, then goes on with --yes at that price', async () => {
    const { rt, stub } = await scene();
    const req = await request(rt, { prompt: 'a desk', seconds: 5, aspect: '16:9', images: ['/work/product.png'] });
    const asked = await generate(rt, 'video', req, '/work/out.mp4');
    expect(asked.code).toBe(3);
    expect(asked.stdout.trim().split('\n')).toHaveLength(1);
    expect(asked.data).toEqual({ confirm: { credits: 25, model: 'video-a', resolution: '480p', seconds: 5, aspectRatio: '16:9', balance: 500 } });
    expect(oneLine(asked.stderr)).toContain('nothing was charged');
    expect(stub.calls('POST', '/videos/generations')).toHaveLength(0);
    expect(await rt.fs.stat('/work/out.mp4')).toBeNull();
    const agreed = await generate(rt, 'video', '--yes', req, '/work/out.mp4');
    expect(agreed.code).toBe(0);
    expect(agreed.stdout).toBe('{"credits":25}\n');
    expect([stub.calls('POST', '/videos/uploads').length, stub.calls('POST', '/videos/quote').length]).toEqual([1, 1]);
    expect(stub.calls('POST', '/videos/generations')[0]?.json?.quoteId).toBe('q_1');
  });

  it('never goes past a budget that is set, even with --yes', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '20' });
    const r = await generate(rt, 'video', '--yes', await request(rt, { prompt: 'a desk', seconds: 5 }), '/work/out.mp4');
    expect(r.code).toBe(3);
    expect(r.data.confirm.credits).toBe(25);
    expect(oneLine(r.stderr)).toContain('more than POPOST_GEN_MAX_CREDITS (20)');
    expect(stub.calls('POST', '/videos/generations')).toHaveLength(0);
  });

  it('--models lists the video models and makes nothing', async () => {
    const { rt, stub } = await scene();
    const r = await generate(rt, '--models');
    expect(r.code).toBe(0);
    expect(r.data).toMatchObject({ ok: true, default: 'video-a', models: [{ id: 'video-a', resolutions: ['480p', '720p'] }] });
    expect(stub.requests.map((q) => q.method + ' ' + q.path)).toEqual(['GET /api/open/v1/videos/models']);
  });
});

describe('popost video generate fails with one line on stderr and a non-zero exit', () => {
  it('without an account: nothing is sent', async () => {
    const { rt, stub } = await scene({ POPOST_API_KEY: undefined, POPOST_GEN_MAX_CREDITS: '100' });
    const r = await generate(rt, 'video', await request(rt, { prompt: 'a desk' }), '/work/out.mp4');
    expect(r.code).toBe(2);
    expect(oneLine(r.stderr)).toContain('No popost.ai account is connected');
    expect(stub.requests).toHaveLength(0);
  });

  it('when video generation is off for the account, with what the platform says', async () => {
    const { rt, api } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    api.disabled = true;
    const r = await generate(rt, 'video', await request(rt, { prompt: 'a desk' }), '/work/out.mp4');
    expect(r.code).toBe(1);
    expect(oneLine(r.stderr)).toMatch(/not available for this account.*Video generation is turned off for this account.*\[VIDEO_GENERATION_DISABLED\]/);
  });

  it('without enough credits, before asking anyone to agree', async () => {
    const { rt, stub, api } = await scene();
    api.balance = 10;
    const r = await generate(rt, 'video', await request(rt, { prompt: 'a desk', seconds: 5 }), '/work/out.mp4');
    expect(r.code).toBe(1);
    expect(oneLine(r.stderr)).toContain('Not enough credits: this needs 25 credits and the balance is 10');
    expect(stub.calls('POST', '/videos/generations')).toHaveLength(0);
  });

  it('when the content is rejected; running again makes a new attempt under the next key', async () => {
    const { rt, stub, api } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    api.failWith = { code: 'CONTENT_REJECTED', message: 'the prompt was flagged' };
    const req = await request(rt, { prompt: 'a desk', seconds: 5 });
    const r = await generate(rt, 'video', req, '/work/out.mp4');
    expect(r.code).toBe(1);
    expect(oneLine(r.stderr)).toMatch(/moderation.*the prompt was flagged.*\[CONTENT_REJECTED\].*refunded/);
    api.failWith = null;
    expect((await generate(rt, 'video', req, '/work/out.mp4')).code).toBe(0);
    const keys = stub.calls('POST', '/videos/generations').map((c) => c.json?.idempotencyKey);
    expect(keys).toEqual([keys[0], keys[0] + '.2']);
  });

  it('for a request it cannot read, and a reference that is not what its list says', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    const noPrompt = await generate(rt, 'video', await request(rt, { seconds: 5 }), '/work/out.mp4');
    expect([noPrompt.code, oneLine(noPrompt.stderr)]).toEqual([2, expect.stringContaining('no "prompt"')]);
    const wrong = await generate(rt, 'video', await request(rt, { prompt: 'a desk', audios: ['/work/product.png'] }), '/work/out.mp4');
    expect([wrong.code, oneLine(wrong.stderr)]).toEqual([2, 'product.png in "audios" is not an MP3 or WAV sound; nothing was sent.']);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('popost video generate image', () => {
  it('prices and makes a picture on the platform image path with the model of the environment', async () => {
    const { rt, stub } = await scene({ POPOST_IMAGE_MODEL: 'stub-model-b', POPOST_GEN_MAX_CREDITS: '30' });
    const r = await generate(rt, 'image', await request(rt, { prompt: 'a red logo', aspect: '1:1', model: 'stub-model-a' }), '/work/logo.png');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"credits":20}\n');
    expect(stub.calls('POST', '/images/quote')[0]?.json).toMatchObject({ model: 'stub-model-b', n: 1, aspectRatio: '1:1' });
    expect(stub.calls('POST', '/images/generations')[0]?.json).toMatchObject({ model: 'stub-model-b', prompt: 'a red logo', maxCredits: 20, idempotencyKey: expect.stringMatching(/^image-[0-9a-f]{64}$/) });
    expect(await rt.fs.readFile('/work/logo.png')).toEqual(stub.inlinePng);
    expect(await rt.fs.stat('/work/logo.png.parts')).toBeNull();
  });

  it('asks before it charges for a picture too', async () => {
    const { rt, stub } = await scene();
    const r = await generate(rt, 'image', await request(rt, { prompt: 'a red logo' }), '/work/logo.png');
    expect(r.code).toBe(3);
    expect(r.data).toEqual({ confirm: { credits: 12, model: 'stub-model-a', aspectRatio: '1:1', balance: 500 } });
    expect(stub.calls('POST', '/images/generations')).toHaveLength(0);
  });

  it('keeps the picture as it was made where nothing can convert it', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '30' });
    const r = await generate(rt, 'image', await request(rt, { prompt: 'a red logo' }), '/work/logo.jpg');
    expect(r.code).toBe(0);
    expect(await rt.fs.readFile('/work/logo.jpg')).toEqual(stub.inlinePng);
    expect(r.stderr).toContain('could not be converted here');
  });
});
