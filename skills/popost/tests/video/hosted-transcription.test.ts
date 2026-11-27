/**
 * Transcription by popost.ai: used only without POPOST_ASR_CMD, with a connected account and a confirmed
 * POPOST_ASR_MAX_CREDITS budget; priced, then a job keyed by the sound (a retry reuses it), the WAV uploaded to the signed
 * address, run within the budget and read as the engine's RawTranscript. The platform is the in-memory fake; the CLI
 * part synthesizes a clip with ffmpeg and is skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { readWav } from '../../src/video/media/wav';
import { hostedTranscriber, rawTranscriptOf } from '../../src/video/speech/hosted';
import { commandTranscriber, toFrames, transcriberAbsence } from '../../src/video/speech/index';
import { ENV, fakePlatform, wav, type FakeOptions } from './hosted-fake';
import { ffmpegReady } from './read-clips';

const setup = (env: Record<string, string> = {}, o: FakeOptions = {}) => {
  const platform = fakePlatform(o);
  const rt = createTestRuntime({ env: { ...ENV, ...env }, fetchHandler: platform.handler });
  return { rt, platform };
};

describe('which transcriber', () => {
  it('has none without a budget or an account, and says why', () => {
    const none = createTestRuntime({ env: {} });
    expect(commandTranscriber(none)).toBeUndefined();
    expect(transcriberAbsence(none)).toBe('POPOST_ASR_CMD is not set');
    const unbudgeted = createTestRuntime({ env: ENV });
    expect(commandTranscriber(unbudgeted)).toBeUndefined();
    expect(transcriberAbsence(unbudgeted)).toContain('no POPOST_ASR_MAX_CREDITS budget');
    expect(transcriberAbsence(unbudgeted)).toContain('popost video transcript <video> --quote');
    const wrong = createTestRuntime({ env: { ...ENV, POPOST_ASR_MAX_CREDITS: 'ten' } });
    expect(commandTranscriber(wrong)).toBeUndefined();
    expect(transcriberAbsence(wrong)).toContain('not a whole number');
    expect(commandTranscriber(createTestRuntime({ env: { POPOST_ASR_MAX_CREDITS: '5' } }))).toBeUndefined();
    expect(commandTranscriber(createTestRuntime({ env: { ...ENV, POPOST_ASR_MAX_CREDITS: '5' } }))).toBeDefined();
  });

  it('keeps the local command first when POPOST_ASR_CMD is set', async () => {
    const argv: string[][] = [];
    const { rt, platform } = setup({ POPOST_ASR_MAX_CREDITS: '5', POPOST_ASR_CMD: 'my-asr --fast' });
    const local = { ...rt, programs: { parallelism: 1, tempDir: async () => '/scratch', run: async (a: readonly string[]) => {
      argv.push([...a]);
      await rt.fs.writeFile(a[3] ?? '', JSON.stringify({ language: 'en', words: [] }));
      return { code: 0, stdout: new Uint8Array(), stderr: '' };
    } } };
    await local.fs.writeFile('/work/a.wav', wav());
    expect(await commandTranscriber(local)?.transcribe('/work/a.wav')).toEqual({ language: 'en', words: [] });
    expect(argv[0]?.slice(0, 2)).toEqual(['my-asr', '--fast']);
    expect(platform.sent).toHaveLength(0);
  });

  it('video doctor names the hosted transcriber, or says what it needs', async () => {
    const ready = setup({ POPOST_ASR_MAX_CREDITS: '5' }).rt;
    await runCli(ready, ['video', 'doctor']);
    expect(ready.json()).toMatchObject({ tools: { transcribe: 'POPOST_ASR_MAX_CREDITS' } });
    expect(ready.json().note).toBeUndefined();
    const unbudgeted = setup().rt;
    await runCli(unbudgeted, ['video', 'doctor']);
    expect(unbudgeted.json()).toMatchObject({ tools: { transcribe: null }, hosted: { transcribe: expect.stringContaining('POPOST_ASR_MAX_CREDITS') } });
    const offline = createTestRuntime();
    await runCli(offline, ['video', 'doctor']);
    expect(offline.json()).toMatchObject({ tools: { transcribe: null } });
    expect(offline.json().hosted).toBeUndefined();
  });
});

describe('the hosted transcriber', () => {
  it('prices, uploads the plain WAV to the signed address and runs within the budget', async () => {
    const { rt, platform } = setup({ POPOST_ASR_MAX_CREDITS: '5' });
    await rt.fs.writeFile('/work/audio.wav', wav({ seconds: 12, list: true }));
    const raw = await commandTranscriber(rt)!.transcribe('/work/audio.wav', 'zh');
    expect(platform.paths()).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions/t-1/run']);
    expect(platform.sent[0]?.body).toEqual({ seconds: 12 });
    expect(platform.sent[1]?.body).toMatchObject({ sizeBytes: 44 + 12 * 32000, language: 'zh' });
    expect(platform.sent[1]?.body?.operationKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(platform.sent[2]?.body).toEqual({ maxCredits: 5 });
    expect(platform.sent.every((s) => s.authorization === 'Bearer test-platform-credential')).toBe(true);
    // The upload: the same sound behind a 44-byte header, typed, and without the platform's credential.
    const put = platform.puts[0]!;
    expect(put).toMatchObject({ contentType: 'audio/wav', authorization: null });
    expect(put.bytes.length).toBe(44 + 12 * 32000);
    expect(readWav(put.bytes)).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 12 });
    // Characters stay as they are, punctuation joins the word before it, a Latin word starts a new word.
    expect(raw).toEqual({ language: 'zh', words: [
      { text: '你', start: 0.1, end: 0.3, confidence: 1 }, { text: '好，', start: 0.3, end: 0.5, confidence: 1 },
      { text: ' Hello', start: 0.6, end: 0.9, confidence: 1 }, { text: ' world', start: 0.9, end: 1.2, confidence: 1 },
    ] });
    expect(toFrames(raw, 10).words.map((w) => w.text)).toEqual(['你', '好，', 'Hello', 'world']);
  });

  it('counts the budget down and refuses before anything is sent when the rest does not cover a call', async () => {
    const { rt, platform } = setup({ POPOST_ASR_MAX_CREDITS: '3' });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 15 }));
    await rt.fs.writeFile('/work/b.wav', wav({ seconds: 2 }));
    const transcriber = hostedTranscriber(rt)!;
    await transcriber.transcribe('/work/a.wav');
    expect(platform.jobs.get('t-1')?.charged).toBe(2);
    await expect(transcriber.transcribe('/work/b.wav')).resolves.toBeDefined();
    const before = platform.sent.length;
    await rt.fs.writeFile('/work/c.wav', wav({ seconds: 3 }));
    await expect(transcriber.transcribe('/work/c.wav')).rejects.toThrow(/costs 1 credits; 0 of the confirmed POPOST_ASR_MAX_CREDITS/);
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote']);
  });

  it('reads a finished job back for the same sound without charging again', async () => {
    const { rt, platform } = setup({ POPOST_ASR_MAX_CREDITS: '2' });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    const first = await hostedTranscriber(rt)!.transcribe('/work/a.wav');
    const again = await hostedTranscriber(rt)!.transcribe('/work/a.wav');
    expect(again).toEqual(first);
    expect(platform.paths().slice(3)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'GET /transcriptions/t-1']);
    expect(platform.sent[1]?.body?.operationKey).toBe(platform.sent[4]?.body?.operationKey);
    expect(platform.puts).toHaveLength(1);
    // Another language is another job.
    await hostedTranscriber(rt)!.transcribe('/work/a.wav', 'en');
    expect(platform.jobs.size).toBe(2);
  });

  it('refuses sound that is not 16 kHz mono 16-bit, and an unknown outcome says how to retry', async () => {
    const { rt, platform } = setup({ POPOST_ASR_MAX_CREDITS: '5' });
    await rt.fs.writeFile('/work/stereo.wav', wav({ channels: 2 }));
    await rt.fs.writeFile('/work/fast.wav', wav({ rate: 48000 }));
    await rt.fs.writeFile('/work/text.wav', 'not a wav');
    await expect(hostedTranscriber(rt)!.transcribe('/work/stereo.wav')).rejects.toThrow('16 kHz, one-channel, 16-bit');
    await expect(hostedTranscriber(rt)!.transcribe('/work/fast.wav')).rejects.toThrow('16 kHz, one-channel, 16-bit');
    await expect(hostedTranscriber(rt)!.transcribe('/work/text.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('not a WAV') });
    expect(platform.sent).toHaveLength(0);
    const broken = setup({ POPOST_ASR_MAX_CREDITS: '5' }, { runBroken: true });
    await broken.rt.fs.writeFile('/work/a.wav', wav());
    await expect(hostedTranscriber(broken.rt)!.transcribe('/work/a.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('the same sound reuses the same transcription job') });
  });

  it('keeps a confidence the platform gives and leaves out words without a time', () => {
    expect(rawTranscriptOf('en', [{ text: 'sure', start: 0, end: 0.2, confidence: 0.4 }, { text: '!', start: 0.2, end: 0.3 }]).words).toEqual([{ text: ' sure!', start: 0, end: 0.2, confidence: 0.4 }]);
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('popost video transcript through popost.ai', () => {
  let rt: DiskRuntime;
  const platform = fakePlatform();
  beforeAll(async () => {
    rt = await createDiskRuntime({ fetchHandler: platform.handler, env: ENV });
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=10:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', rt.path.join(rt.dir, 'clip.mp4')]);
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('--quote prices the sound for free; without a budget nothing is transcribed; with one the words come back', async () => {
    expect((await runCli(rt, ['video', 'transcript', 'clip.mp4', '--quote'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, sound: true, credits: 1, charged: 0, toUse: expect.stringContaining('POPOST_ASR_MAX_CREDITS=1') });
    expect(Number(rt.json().seconds)).toBeCloseTo(3, 1);
    expect(platform.paths()).toEqual(['POST /transcriptions/quote']);
    expect((await runCli(rt, ['video', 'transcript', 'clip.mp4'])).code).toBe(2);
    expect(String(rt.json().error)).toContain('no POPOST_ASR_MAX_CREDITS budget');
    const budgeted = { ...rt, env: { ...rt.env, POPOST_ASR_MAX_CREDITS: '1' } };
    expect((await runCli(budgeted, ['video', 'transcript', 'clip.mp4', '--language', 'zh'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, sound: true, words: 4, language: 'zh' });
    expect(platform.paths().slice(1)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions/t-1/run']);
  });
});
