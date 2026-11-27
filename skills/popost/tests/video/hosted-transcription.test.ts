/**
 * Transcription by popost.ai: the transcriber of a connected account unless POPOST_ASR_CMD names one of your own; paid as
 * images are: priced, then (within what the command confirmed) a job keyed by the sound (a retry reuses it), the WAV
 * uploaded to the signed address, run within what is left and read as the engine's RawTranscript. The platform is the
 * in-memory fake; the CLI part synthesizes a clip with ffmpeg and is skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { readWav } from '../../src/video/media/wav';
import { hostedTranscriber, rawTranscriptOf } from '../../src/video/speech/hosted';
import { commandTranscriber, toFrames, transcriberKind } from '../../src/video/speech/index';
import { Wallet } from '../../src/video/wallet';
import { ENV, fakePlatform, wav, type FakeOptions } from './hosted-fake';
import { ffmpegReady } from './read-clips';

const setup = (env: Record<string, string> = {}, o: FakeOptions = {}) => {
  const platform = fakePlatform(o);
  const rt = createTestRuntime({ env: { ...ENV, ...env }, fetchHandler: platform.handler });
  return { rt, platform };
};

describe('which transcriber', () => {
  it('is popost.ai by default with a connected account, one of your own when POPOST_ASR_CMD is set, none without either', () => {
    const none = createTestRuntime({ env: {} });
    expect([transcriberKind(none), commandTranscriber(none)]).toEqual([undefined, undefined]);
    const connected = createTestRuntime({ env: ENV });
    expect(transcriberKind(connected)).toBe('hosted');
    expect(commandTranscriber(connected)).toBeDefined();
    expect(transcriberKind(createTestRuntime({ env: { ...ENV, POPOST_ASR_CMD: 'my-asr' } }))).toBe('own');
    expect(transcriberKind(createTestRuntime({ env: { POPOST_ASR_CMD: 'my-asr' } }))).toBe('own');
  });

  it('keeps the local command first when POPOST_ASR_CMD is set, with an account connected too', async () => {
    const argv: string[][] = [];
    const { rt, platform } = setup({ POPOST_ASR_CMD: 'my-asr --fast' });
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

  it('video doctor names the hosted transcriber when connected, and says to connect first when not', async () => {
    const ready = setup().rt;
    await runCli(ready, ['video', 'doctor']);
    expect(ready.json()).toMatchObject({ tools: { transcribe: 'popost.ai', speak: 'popost.ai' }, hosted: { transcribe: expect.stringContaining('popost.ai transcribes') } });
    expect(JSON.stringify(ready.json().hosted)).not.toMatch(/MAX_CREDITS|budget/);
    expect(ready.json().note).toBeUndefined();
    const own = setup({ POPOST_ASR_CMD: 'my-asr' }).rt;
    await runCli(own, ['video', 'doctor']);
    expect(own.json()).toMatchObject({ tools: { transcribe: 'POPOST_ASR_CMD', speak: 'popost.ai' } });
    const offline = createTestRuntime();
    await runCli(offline, ['video', 'doctor']);
    expect(offline.json()).toMatchObject({ tools: { transcribe: null, speak: null }, connect: expect.stringMatching(/^Connect a popost.ai account with popost auth login \(recommended\)/) });
    expect(offline.json().hosted).toBeUndefined();
  });
});

describe('the hosted transcriber', () => {
  it('prices, uploads the plain WAV to the signed address and runs within the budget', async () => {
    const { rt, platform } = setup();
    await rt.fs.writeFile('/work/audio.wav', wav({ seconds: 12, list: true }));
    const raw = await commandTranscriber(rt, new Wallet(5))!.transcribe('/work/audio.wav', 'zh');
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

  it('transcribes nothing a command did not confirm', async () => {
    const { rt, platform } = setup();
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt)!.transcribe('/work/a.wav')).rejects.toThrow('no spending was confirmed for this command; nothing was charged');
    expect(platform.paths()).toEqual(['POST /transcriptions/quote']);
  });

  it('counts the ceiling of the command down and refuses before anything is sent when the rest does not cover a call', async () => {
    const { rt, platform } = setup();
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 15 }));
    await rt.fs.writeFile('/work/b.wav', wav({ seconds: 2 }));
    const transcriber = hostedTranscriber(rt, new Wallet(3))!;
    await transcriber.transcribe('/work/a.wav');
    expect(platform.jobs.get('t-1')?.charged).toBe(2);
    await expect(transcriber.transcribe('/work/b.wav')).resolves.toBeDefined();
    const before = platform.sent.length;
    await rt.fs.writeFile('/work/c.wav', wav({ seconds: 3 }));
    await expect(transcriber.transcribe('/work/c.wav')).rejects.toThrow('costs 1 credits and 0 of the --max-credits 3 of this command are left');
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote']);
  });

  it('reads a finished job back for the same sound without charging again', async () => {
    const { rt, platform } = setup();
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    const first = await hostedTranscriber(rt, new Wallet(2))!.transcribe('/work/a.wav');
    const again = await hostedTranscriber(rt, new Wallet(2))!.transcribe('/work/a.wav');
    expect(again).toEqual(first);
    expect(platform.paths().slice(3)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'GET /transcriptions/t-1']);
    expect(platform.sent[1]?.body?.operationKey).toBe(platform.sent[4]?.body?.operationKey);
    expect(platform.puts).toHaveLength(1);
    // Another language is another job.
    await hostedTranscriber(rt, new Wallet(2))!.transcribe('/work/a.wav', 'en');
    expect(platform.jobs.size).toBe(2);
  });

  it('refuses sound that is not 16 kHz mono 16-bit, and an unknown outcome says how to retry', async () => {
    const { rt, platform } = setup();
    await rt.fs.writeFile('/work/stereo.wav', wav({ channels: 2 }));
    await rt.fs.writeFile('/work/fast.wav', wav({ rate: 48000 }));
    await rt.fs.writeFile('/work/text.wav', 'not a wav');
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/stereo.wav')).rejects.toThrow('16 kHz, one-channel, 16-bit');
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/fast.wav')).rejects.toThrow('16 kHz, one-channel, 16-bit');
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/text.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('not a WAV') });
    expect(platform.sent).toHaveLength(0);
    const broken = setup({}, { runBroken: true });
    await broken.rt.fs.writeFile('/work/a.wav', wav());
    await expect(hostedTranscriber(broken.rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('the same sound reuses the same transcription job') });
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
    const { rt, platform, sleeps } = clocked({}, { runningReads: 12 });
    await rt.fs.writeFile('/work/long.wav', wav({ seconds: 12 }));
    const transcriber = hostedTranscriber(rt, new Wallet(3))!;
    expect((await transcriber.transcribe('/work/long.wav', 'zh')).words).toHaveLength(4);
    expect(platform.paths().slice(0, 3)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions/t-1/run']);
    expect(reads(platform.paths())).toBe(12);
    expect(sleeps).toEqual(Array(12).fill(3000));
    expect(rt.err).toEqual(['popost.ai is transcribing 12.0 s of sound (30 s so far)\n']);
    // The 2 credits of the job it ran count against the ceiling: 1 is left, and 15 s (2 credits) is refused.
    await rt.fs.writeFile('/work/more.wav', wav({ seconds: 15 }));
    await expect(transcriber.transcribe('/work/more.wav')).rejects.toThrow('1 of the --max-credits 3 of this command are left');
  });

  it('a rerun finds the job running: it waits for it without uploading, running or spending again', async () => {
    const { rt, platform } = clocked({}, { cutRuns: [1], runningReads: 3 });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt, new Wallet(1))!.transcribe('/work/a.wav')).rejects.toMatchObject({ name: 'ToolError', message: expect.stringContaining('the same sound reuses the same transcription job') });
    expect(platform.jobs.get('t-1')?.state).toBe('running');
    const again = hostedTranscriber(rt, new Wallet(1))!;
    const before = platform.sent.length;
    expect((await again.transcribe('/work/a.wav')).words).toHaveLength(4);
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'GET /transcriptions/t-1', 'GET /transcriptions/t-1', 'GET /transcriptions/t-1']);
    expect(platform.puts).toHaveLength(1);
    // Nothing of the ceiling was spent on it: another sound of 1 credit still fits.
    await rt.fs.writeFile('/work/b.wav', wav({ seconds: 5 }));
    await expect(again.transcribe('/work/b.wav')).resolves.toBeDefined();
  });

  it('waits as long as a rate limit asks, and reports a failed job', async () => {
    const limited = clocked({}, { runningReads: 2, limitFirstRead: 7 });
    await limited.rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await hostedTranscriber(limited.rt, new Wallet(5))!.transcribe('/work/a.wav');
    expect(limited.sleeps).toEqual([3000, 7000, 3000]);
    const failing = clocked({}, { runningReads: 2, failRuns: [1] });
    await failing.rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await expect(hostedTranscriber(failing.rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toThrow('failed; run the same command again to start a new one');
  });

  it('a rerun after a failed job starts one new job, and a rerun after that finds the new job', async () => {
    const { rt, platform } = clocked({}, { runningReads: 2, failRuns: [1], cutRuns: [2] });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toThrow('failed; run the same command again to start a new one');
    expect(platform.jobs.get('t-1')?.state).toBe('failed');
    const creates = () => platform.sent.filter((x) => x.path === '/transcriptions').map((x) => String(x.body?.operationKey));
    // First rerun: the key of the sound answers failed; the next key, made from the failed job, makes t-2, which is cut off.
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toThrow('the same sound reuses the same transcription job');
    expect(platform.jobs.size).toBe(2);
    expect(platform.jobs.get('t-2')?.state).toBe('running');
    const [first, again, next] = creates();
    expect(again).toBe(first);
    expect(next).not.toBe(first);
    // Second rerun: the same walk finds t-2 and waits for it, with no upload, run or new job.
    const before = platform.sent.length;
    expect((await hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/a.wav')).words).toHaveLength(4);
    expect(platform.paths().slice(before)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions', 'GET /transcriptions/t-2', 'GET /transcriptions/t-2']);
    expect(creates().slice(3)).toEqual([first, next]);
    expect(platform.jobs.size).toBe(2);
    expect(platform.puts).toHaveLength(2);
    expect(platform.paths().filter((x) => x.endsWith('/run'))).toHaveLength(2);
  });

  it('steps past at most 5 failed jobs, then gives up on the sound without uploading', async () => {
    const { rt, platform } = clocked({}, { failAtCreate: true });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 4 }));
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toThrow('failed to transcribe this sound 6 times');
    expect(platform.paths()).toEqual(['POST /transcriptions/quote', ...Array(6).fill('POST /transcriptions')]);
    expect(new Set(platform.sent.slice(1).map((x) => x.body?.operationKey)).size).toBe(6);
    expect(platform.puts).toHaveLength(0);
  });

  it('stops waiting after 30 min, and refuses more than 30 min of sound before anything is sent', async () => {
    const { rt, platform, sleeps } = clocked({}, { runningReads: 1_000_000 });
    await rt.fs.writeFile('/work/a.wav', wav({ seconds: 2 }));
    await expect(hostedTranscriber(rt, new Wallet(5))!.transcribe('/work/a.wav')).rejects.toThrow('still running after 30 min');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(rt.err.length).toBeLessThanOrEqual(60);
    expect(reads(platform.paths())).toBe(600);
    const long = clocked({}, {});
    await long.rt.fs.writeFile('/work/long.wav', wav({ seconds: 30 * 60 + 1 }));
    await expect(hostedTranscriber(long.rt, new Wallet(500))!.transcribe('/work/long.wav')).rejects.toThrow('at most 30 min of sound');
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

  it('--quote prices the sound for free; without --confirm the price comes back with exit code 3; with it the words', async () => {
    expect((await runCli(rt, ['video', 'transcript', 'clip.mp4', '--quote'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, sound: true, credits: 1, chargedCredits: 0, next: expect.stringContaining('--confirm --max-credits') });
    expect(Number(rt.json().seconds)).toBeCloseTo(3, 1);
    expect(platform.paths()).toEqual(['POST /transcriptions/quote']);
    expect((await runCli(rt, ['video', 'transcript', 'clip.mp4'])).code).toBe(3);
    expect(rt.json()).toMatchObject({ ok: false, confirm: { credits: 1, items: [{ kind: 'transcription', credits: 1 }] }, next: expect.stringContaining('Nothing was charged') });
    expect(platform.paths().slice(1)).toEqual(['POST /transcriptions/quote']);
    expect((await runCli(rt, ['video', 'transcript', 'clip.mp4', '--language', 'zh', '--confirm', '--max-credits', '1'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, sound: true, words: 4, language: 'zh', chargedCredits: 1 });
    expect(platform.paths().slice(2)).toEqual(['POST /transcriptions/quote', 'POST /transcriptions/quote', 'POST /transcriptions', 'POST /transcriptions/t-1/run']);
  });
});
