/**
 * `popost video generate`, the built-in generator on the popost.ai Open API, against an in-memory platform: the image
 * tests' stub with the agreed video endpoints added here. No network, no real key; the clock is the test's own.
 */
import { describe, expect, it } from 'vitest';
import type { TestRuntime } from '../../src/testing/memory';
import { cli, err, KEY, tinyPng, type Json } from '../image-helpers';
import { CLIP, MOVE, PRODUCT, scene } from './video-api-fake';

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
    expect(r.data).toEqual({ credits: 50, chargedCredits: 50, key: expect.stringMatching(/^video-[0-9a-f]{64}$/) });
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

  it('answers a request for the price only with the price, inside a budget and with --yes too, and makes nothing', async () => {
    const { rt, stub, api } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    const req = await request(rt, { prompt: 'a desk', seconds: 5, images: ['/work/product.png'], priceOnly: true });
    for (const more of [[], ['--yes']]) {
      const r = await generate(rt, 'video', req, '/work/out.mp4', ...more);
      expect(r.code).toBe(3);
      expect(r.data).toEqual({ confirm: { credits: 25, model: 'video-a', resolution: '480p', seconds: 5, aspectRatio: '16:9', balance: 500 } });
      expect(oneLine(r.stderr)).toContain('Only its price was asked for: nothing was made or charged');
    }
    expect(stub.calls('POST', '/videos/generations')).toEqual([]);
    expect([api.balance, await rt.fs.stat('/work/out.mp4')]).toEqual([500, null]);
    const picture = await generate(rt, 'image', req, '/work/out.png');
    expect([picture.code, oneLine(picture.stderr)]).toEqual([2, '"priceOnly" is for a clip; a picture is priced when it is made.']);
  });

  it('sends a first and a last frame as frames, never as references, and refuses a request that has both', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    await rt.fs.writeFile('/work/end.png', tinyPng([10, 200, 10]));
    const req = await request(rt, { prompt: 'the lid opens', seconds: 5, firstFrame: '/work/product.png', lastFrame: '/work/end.png' });
    const r = await generate(rt, 'video', req, '/work/out.mp4');
    expect([r.code, r.data]).toEqual([0, { credits: 25, chargedCredits: 25, key: expect.any(String) }]);
    expect(stub.calls('POST', '/videos/uploads').map((c) => c.json?.kind)).toEqual(['image', 'image']);
    const quoted = { seconds: 5, frames: { first: 'vu_1', last: 'vu_2' } };
    expect(stub.calls('POST', '/videos/quote').map((c) => c.json)).toEqual([quoted]);
    expect(stub.calls('POST', '/videos/generations')[0]?.json).toMatchObject({ ...quoted, prompt: 'the lid opens' });
    // Another first frame is another clip: the key holds the frames by content.
    const keys = async (body: Json): Promise<string> => {
      const s = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
      await s.rt.fs.writeFile('/work/end.png', tinyPng([10, 200, 10]));
      expect((await generate(s.rt, 'video', await request(s.rt, body), '/work/out.mp4')).code).toBe(0);
      return s.stub.calls('POST', '/videos/generations')[0]?.json?.idempotencyKey;
    };
    expect(await keys({ prompt: 'x', firstFrame: '/work/product.png' })).not.toBe(await keys({ prompt: 'x', firstFrame: '/work/end.png' }));
    expect(await keys({ prompt: 'x', firstFrame: '/work/product.png' })).not.toBe(await keys({ prompt: 'x', images: ['/work/product.png'] }));
    for (const [body, said] of [
      [{ prompt: 'x', firstFrame: '/work/product.png', images: ['/work/end.png'] }, /cannot be combined with "images", "videos" or "audios".*Nothing was sent/],
      [{ prompt: 'x', lastFrame: '/work/end.png' }, /"lastFrame" needs "firstFrame"/],
      [{ prompt: 'x', firstFrame: '/work/move.mov' }, /move\.mov in "firstFrame" is not a JPEG, PNG or WebP picture/],
    ] as const) {
      const refused = await generate(rt, 'video', await request(rt, body), '/work/no.mp4');
      expect(refused.code).toBe(2);
      expect(oneLine(refused.stderr)).toMatch(said);
    }
    expect(stub.calls('POST', '/videos/quote')).toHaveLength(1);
    const picture = await generate(rt, 'image', await request(rt, { prompt: 'x', firstFrame: '/work/product.png' }), '/work/no.png');
    expect([picture.code, oneLine(picture.stderr)]).toEqual([2, 'Only a clip starts from a frame; a picture takes reference pictures ("images"). Nothing was sent.']);
  });

  it('says so when the model takes no frames', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    stub.set('POST', '/videos/quote', () => err(400, 'VIDEO_OPTION_UNSUPPORTED', 'The model does not take this', { field: 'frames' }));
    const r = await generate(rt, 'video', await request(rt, { prompt: 'x', firstFrame: '/work/product.png' }), '/work/out.mp4');
    expect(r.code).toBe(1);
    expect(oneLine(r.stderr)).toMatch(/This video model does not take a first or last frame .*POPOST_VIDEO_MODEL.*"images" instead\. Nothing was charged\./);
    expect(stub.calls('POST', '/videos/generations')).toEqual([]);
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
    // It was paid by the first run: this one charges nothing.
    expect(again.data).toMatchObject({ credits: 25, chargedCredits: 0 });
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
    expect(agreed.data).toMatchObject({ credits: 25, chargedCredits: 25 });
    expect([stub.calls('POST', '/videos/uploads').length, stub.calls('POST', '/videos/quote').length]).toEqual([1, 1]);
    expect(stub.calls('POST', '/videos/generations')[0]?.json?.quoteId).toBe('q_1');
  });

  it('never goes past a budget that is set, even with --yes', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '20' });
    const r = await generate(rt, 'video', '--yes', await request(rt, { prompt: 'a desk', seconds: 5 }), '/work/out.mp4');
    expect(r.code).toBe(3);
    expect(r.data.confirm.credits).toBe(25);
    expect(oneLine(r.stderr)).toContain('more than the budget of this call (20 credits)');
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
    expect(r.data).toEqual({ credits: 20, chargedCredits: 20 });
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
