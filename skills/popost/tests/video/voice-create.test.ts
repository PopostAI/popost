/**
 * `popost video voice create`: consent first, the sound of an audio or video file made into a 24 kHz mono 16-bit sample
 * of 10 to 60 s, then create, upload to the signed address and complete; the new voice is in `voice list` and can be
 * quoted. The platform is the in-memory fake; the recordings are synthesized with ffmpeg (skipped without it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { readWav } from '../../src/video/media/wav';
import { ENV, fakePlatform, type FakeOptions } from './hosted-fake';
import { ffmpegReady } from './read-clips';

describe('voice create before any work', () => {
  it('needs --consent and a sensible name; nothing is read or sent without them', async () => {
    const platform = fakePlatform();
    const rt = createTestRuntime({ env: ENV, fetchHandler: platform.handler });
    expect((await runCli(rt, ['video', 'voice', 'create', '--file', 'me.wav', '--name', 'Me'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('--consent');
    expect(String(rt.json().error)).toContain('owns this voice or has the speaker\'s permission');
    expect((await runCli(rt, ['video', 'voice', 'create', '--file', 'me.wav', '--name', 'x'.repeat(101), '--consent'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('1 to 100');
    expect((await runCli(rt, ['video', 'voice', 'create', '--file', 'me.wav', '--name', 'Me', '--language', 'fr', '--consent'])).code).toBe(2);
    expect(platform.sent).toHaveLength(0);
    expect((await runCli(rt, ['video', 'voice', '--help'])).stdout).toContain('create');
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('voice create from a recording', () => {
  let maker: DiskRuntime;
  const recording = (name: string) => maker.path.join(maker.dir, name);
  beforeAll(async () => {
    maker = await createDiskRuntime();
    await runFfmpegOk(maker, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-ac', '2', '-ar', '44100', recording('short.wav')]);
    await runFfmpegOk(maker, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=14', '-c:a', 'aac', recording('talk.m4a')]);
    await runFfmpegOk(maker, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=5:d=75', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=75',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', recording('long.mp4')]);
    await runFfmpegOk(maker, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=5:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', recording('mute.mp4')]);
  }, 120_000);
  afterAll(() => maker.cleanup());

  const withPlatform = (o: FakeOptions = {}) => {
    const platform = fakePlatform(o);
    const rt = { ...maker, env: { ...maker.env, ...ENV }, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => platform.handler(new Request(input, init))) as typeof fetch };
    return { rt, platform };
  };
  const create = (rt: DiskRuntime, file: string, ...more: string[]) => runCli(rt, ['video', 'voice', 'create', '--file', file, '--name', 'My voice', '--consent', ...more]);

  it('trims a long video to 60 s from --start, uploads the plain sample and prints the voice the catalog lists', async () => {
    const { rt, platform } = withPlatform();
    expect((await create(rt, 'long.mp4', '--start', '5', '--language', 'zh', '--description', 'Calm narration')).code).toBe(0);
    const out = rt.json() as { voice: { id: string }; sample: { seconds: number; trimmed: boolean; bytes: number }; next: string };
    expect(out).toMatchObject({ ok: true, voice: { id: 'v-1', name: 'Made v-1' }, sample: { seconds: 60, start: 5, trimmed: true } });
    expect(out.next).toContain('--voice v-1');
    expect(platform.paths()).toEqual(['POST /voices', 'POST /voices/v-1/complete']);
    expect(platform.sent[0]?.body).toMatchObject({ name: 'My voice', language: 'zh', description: 'Calm narration', consent: true, sizeBytes: out.sample.bytes });
    const put = platform.puts[0]!;
    expect(put).toMatchObject({ contentType: 'audio/wav', authorization: null });
    expect(put.bytes.length).toBe(out.sample.bytes);
    expect(put.bytes.length).toBe(44 + 60 * 24000 * 2);
    expect(readWav(put.bytes)).toMatchObject({ format: 1, channels: 1, bitsPerSample: 16, sampleRate: 24000, seconds: 60 });
    // The new voice is in the catalog and can be quoted like an official one.
    expect((await runCli(rt, ['video', 'voice', 'list', '--scope', 'mine'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, total: 1, items: [{ id: 'v-1' }] });
    expect((await runCli(rt, ['video', 'voice', 'quote', '--voice', 'v-1', '--text', 'Hello'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, voice: 'v-1', credits: 1 });
  });

  it('takes an audio file under 60 s whole, and the same command again makes no second voice', async () => {
    const { rt, platform } = withPlatform();
    expect((await create(rt, 'talk.m4a')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, voice: { id: 'v-1' }, sample: { trimmed: false } });
    expect(Number((rt.json().sample as { seconds: number }).seconds)).toBeGreaterThanOrEqual(14);
    expect(platform.sent[0]?.body?.language).toBeUndefined();
    expect((await create(rt, 'talk.m4a')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, voice: { id: 'v-1' }, note: expect.stringContaining('already made') });
    expect(platform.paths().slice(2)).toEqual(['POST /voices', 'GET /voices']);
    expect(platform.puts).toHaveLength(1);
  });

  it('refuses a recording under 10 s or without sound before asking the platform, and passes a refusal on', async () => {
    const { rt, platform } = withPlatform();
    expect((await create(rt, 'short.wav')).code).toBe(2);
    expect(String(rt.json().error)).toMatch(/has 5(\.\d+)? s of sound; a voice needs 10 to 60 s/);
    expect((await create(rt, 'talk.m4a', '--start', '8')).code).toBe(2);
    expect(String(rt.json().error)).toContain('or an earlier --start');
    expect((await create(rt, 'mute.mp4')).code).toBe(2);
    expect(String(rt.json().error)).toContain('There is no sound in');
    expect(platform.sent).toHaveLength(0);
    const limited = withPlatform({ voiceRefusal: 'VOICE_PLAN_LIMIT' });
    expect((await create(limited.rt, 'talk.m4a')).code).toBe(2);
    expect(String(limited.rt.json().error)).toContain('VOICE_PLAN_LIMIT');
    expect(limited.platform.puts).toHaveLength(0);
    const refused = withPlatform({ refuseSample: true });
    expect((await create(refused.rt, 'talk.m4a')).code).toBe(2);
    expect(String(refused.rt.json().error)).toContain('could not use this recording as a voice sample');
    expect(String(refused.rt.json().error)).toContain('Give another recording');
    expect(String(refused.rt.json().error)).toContain('INVALID_REQUEST');
  });
});
