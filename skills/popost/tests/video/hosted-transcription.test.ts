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

/** A runtime whose clock moves only when it sleeps: polls and progress lines are counted, not waited for. */
const clocked = (env: Record<string, string>, o: FakeOptions) => {
  const platform = fakePlatform(o);
  const sleeps: number[] = [];
  let t = Date.UTC(2026, 10, 27);
  const rt = createTestRuntime({ env: { ...ENV, ...env }, fetchHandler: platform.handler, now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  return { rt, platform, sleeps };
};
const reads = (paths: string[]) => paths.filter((p) => p.startsWith('GET /transcriptions/')).length;

describe('a transcription that runs long', () => {
  it('reads a job the run left running every 3 s until it is ready, with a line on stderr every 30 s, and counts its charge', async () => {
    const { rt, platform, sleeps } = clocked({ POPOST_ASR_MAX_CREDITS: '3' }, { runningReads: 12 });
    await rt.fs.writeFile('/work/long.wav', wav({ seconds: 12 }));
    const transcriber = hostedTranscriber(rt)!;
    expect((await transcriber.transcribe('/work/long.wav', 'zh')).words).toHaveLength(4);
    expect(platform.paths().slice(0, 3)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions/t-1/run']);
    expect(reads(platform.paths())).toBe(12);
    expect(sleeps).toEqual(Array(12).fill(3000));
    expect(rt.err).toEqual(['popost.ai is transcribing 12.0 s of sound (30 s so far)\n']);
    // The 2 credits of the job it ran count against the budget: 1 is left, and 15 s (2 credits) is refused.
    await rt.fs.writeFile('/work/more.wav', wav({ seconds: 15 }));
    await expect(transcriber.transcribe('/work/more.wav')).rejects.toThrow('1 of the confirmed POPOST_ASR_MAX_CREDITS budget');
  });

  it('a rerun finds the job running: it waits for it without uploading, running or spending again', async () => {
    const { rt, platform } = clocked({ POPOST_ASR_MAX_CREDITS: '1' }, { cutRuns: [1], runningReads: 3 });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('the same sound reuses the same transcription job') });
    expect(platform.jobs.get('t-1')?.state).toBe('running');
    const again = hostedTranscriber(rt)!;
    const before = platform.sent.length;
    expect((await again.transcribe('/work/a.wav')).words).toHaveLength(4);
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'GET /transcriptions/t-1', 'GET /transcriptions/t-1', 'GET /transcriptions/t-1']);
    expect(platform.puts).toHaveLength(1);
    // Nothing of the budget was spent on it: another sound of 1 credit still fits.
    await rt.fs.writeFile('/work/b.wav', wav({ seconds: 5 }));
    await expect(again.transcribe('/work/b.wav')).resolves.toBeDefined();
  });

  it('waits as long as a rate limit asks, and reports a failed job', async () => {
    const limited = clocked({ POPOST_ASR_MAX_CREDITS: '5' }, { runningReads: 2, limitFirstRead: 7 });
    await limited.rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await hostedTranscriber(limited.rt)!.transcribe('/work/a.wav');
    expect(limited.sleeps).toEqual([3000, 7000, 3000]);
    const failing = clocked({ POPOST_ASR_MAX_CREDITS: '5' }, { runningReads: 2, failRuns: [1] });
    await failing.rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await expect(hostedTranscriber(failing.rt)!.transcribe('/work/a.wav')).rejects.toThrow('failed; run the same command again to start a new one');
  });

  it('a rerun after a failed job starts one new job, and a rerun after that finds the new job', async () => {
    const { rt, platform } = clocked({ POPOST_ASR_MAX_CREDITS: '5' }, { runningReads: 2, failRuns: [1], cutRuns: [2] });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toThrow('failed; run the same command again to start a new one');
    expect(platform.jobs.get('t-1')?.state).toBe('failed');
    const creates = () => platform.sent.filter((x) => x.path === '/transcriptions').map((x) => String(x.body?.operationKey));
    // First rerun: the key of the sound answers failed; the next key, made from the failed job, makes t-2, which is cut off.
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toThrow('the same sound reuses the same transcription job');
    expect(platform.jobs.size).toBe(2);
    expect(platform.jobs.get('t-2')?.state).toBe('running');
    const [first, again, next] = creates();
    expect(again).toBe(first);
    expect(next).not.toBe(first);
    // Second rerun: the same walk finds t-2 and waits for it, with no upload, run or new job.
    const before = platform.sent.length;
    expect((await hostedTranscriber(rt)!.transcribe('/work/a.wav')).words).toHaveLength(4);
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions', 'GET /transcriptions/t-2', 'GET /transcriptions/t-2']);
    expect(creates().slice(3)).toEqual([first, next]);
    expect(platform.jobs.size).toBe(2);
    expect(platform.puts).toHaveLength(2);
    expect(platform.paths().filter((x) => x.endsWith('/run'))).toHaveLength(2);
  });

  it('steps past at most 5 failed jobs, then gives up on the sound without uploading', async () => {
    const { rt, platform } = clocked({ POPOST_ASR_MAX_CREDITS: '5' }, { failAtCreate: true });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toThrow('failed to transcribe this sound 6 times');
    expect(platform.paths()).toEqual(['POST /transcriptions/quote', ...Array(6).fill('POST /transcriptions')]);
    expect(new Set(platform.sent.slice(1).map((x) => x.body?.operationKey)).size).toBe(6);
    expect(platform.puts).toHaveLength(0);
  });

  it('stops waiting after 30 min, and refuses more than 30 min of sound before anything is sent', async () => {
    const { rt, platform, sleeps } = clocked({ POPOST_ASR_MAX_CREDITS: '5' }, { runningReads: 1_000_000 });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toThrow('still running after 30 min');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(rt.err.length).toBeLessThanOrEqual(60);
    expect(reads(platform.paths())).toBe(600);
    const long = clocked({ POPOST_ASR_MAX_CREDITS: '500' }, {});
    await long.rt.fs.writeFile('/work/long.wav', wav({ seconds: 30 * 60 + 1 }));
    await expect(hostedTranscriber(long.rt)!.transcribe('/work/long.wav')).rejects.toThrow('at most 30 min of sound');
    expect(long.platform.sent).toHaveLength(0);
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
