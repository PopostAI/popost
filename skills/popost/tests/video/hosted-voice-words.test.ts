/**
 * Word times from hosted speech: the platform's words go beside the clip as <clip>.words.json, speakLines reads them
 * (the speaker's own times, first word at 0) instead of a transcript, and `voice speak` keeps them beside its output.
 * The platform is the in-memory fake; the parts that cut and measure clips use ffmpeg and are skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { hostedSpeaker, hostedSpeech } from '../../src/video/voice/hosted';
import { speakLines } from '../../src/video/voice/index';
import { Wallet } from '../../src/video/wallet';
import { ENV, fakePlatform, MALE } from './hosted-fake';
import { ffmpegReady } from './read-clips';

const WORDS = [{ text: '你', start: 0.5, end: 0.8 }, { text: '好', start: 0.8, end: 1.3 }];

describe('hosted speech word times', () => {
  it('writes the words beside the clip, and removes an older file when an answer has none', async () => {
    const platform = fakePlatform({ speechWords: [...WORDS, { text: 'no time' }] });
    const rt = createTestRuntime({ env: ENV, fetchHandler: platform.handler });
    await hostedSpeech(rt, MALE, '你好', '/work/line.wav', new Wallet(5));
    expect(JSON.parse(await rt.fs.readText('/work/line.wav.words.json'))).toEqual({ words: WORDS });
    const silent = fakePlatform({ speechWords: null });
    const again = { ...rt, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => silent.handler(new Request(input, init))) as typeof fetch };
    await hostedSpeech(again, MALE, '你好', '/work/line.wav', new Wallet(5));
    expect(await rt.fs.stat('/work/line.wav.words.json')).toBeNull();
    expect(await rt.fs.stat('/work/line.wav.voice.json')).not.toBeNull();
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('hosted word times through the engine', () => {
  let rt: DiskRuntime;
  let speech: Uint8Array;
  beforeAll(async () => {
    const maker = await createDiskRuntime();
    // Half a second of silence, then a second of tone: the clip is trimmed to its first sound.
    const file = maker.path.join(maker.dir, 'speech.wav');
    await runFfmpegOk(maker, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'adelay=500', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', file]);
    speech = await maker.fs.readFile(file);
    await maker.cleanup();
    const platform = fakePlatform({ speechWords: WORDS, audio: speech });
    rt = await createDiskRuntime({ fetchHandler: platform.handler, env: ENV });
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('speakLines takes the speaker\'s own times, the first word at 0, and leaves no words file behind', async () => {
    const dir = rt.path.join(rt.dir, 'voice');
    const lines = await speakLines(rt, { lines: ['你好', ''], dir, speaker: hostedSpeaker(rt, new Wallet(10)), fps: 30, voice: 'popost:default-male' });
    expect(lines[0]?.words?.map((w) => w.text)).toEqual(['你', '好']);
    expect(lines[0]?.words?.[0]?.start).toBe(0);
    expect(lines[0]?.words?.[1]?.start).toBeCloseTo(0.3, 5);
    expect(lines[0]?.words?.[1]?.end).toBeCloseTo(0.8, 5);
    expect(lines[0]?.frames).toBeGreaterThanOrEqual(29);
    expect(lines[1]).toEqual({ text: '', frames: 0 });
    expect((await rt.fs.readdir(dir)).filter((n) => n.endsWith('.words.json'))).toEqual([]);
  });

  it('voice speak keeps the words beside its output', async () => {
    const project = rt.path.join(rt.dir, 'project');
    await rt.fs.mkdir(project);
    expect((await runCli(rt, ['video', 'voice', 'use', 'project', '--speaker', 'host', '--voice', 'default-male'])).code).toBe(0);
    expect((await runCli(rt, ['video', 'voice', 'speak', 'project', '--speaker', 'host', '--text', '你好', '--out', 'project/assets/line.wav', '--confirm', '--max-credits', '1'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, words: 'project/assets/line.wav.words.json' });
    expect(JSON.parse(await rt.fs.readText(rt.path.join(project, 'assets/line.wav.words.json')))).toEqual({ words: WORDS });
    expect(await rt.fs.readFile(rt.path.join(project, 'assets/line.wav'))).toEqual(speech);
  });
});
