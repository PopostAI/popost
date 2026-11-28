/**
 * The sound of generated clips (references/video-sound.md): a silent clip asked for without a sound track only on a
 * model that can (audioOptional), reference sounds held to the model's limits, one voice sample per character (popost
 * video voice sample), the speech check of what a clip really said (popost video speech-check, paid as describe pays
 * its transcription), captions that follow the measured lines, and a generated track cut to the video's length. The
 * platform is the in-memory fake; the parts that cut or render sound need ffmpeg.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { makeMaterials, type Generator, type GenerateRequest } from '../../src/video/generate/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { audioSeconds } from '../../src/video/voice/index';
import { speechSpans } from '../../src/video/media/footage';
import { fitTrack } from '../../src/video/music/hosted';
import { retarget } from '../../src/video/retarget/index';
import { lineTimes, matchSpeech, MATCH_FLOOR, speechMatchProblems, spokenSpans } from '../../src/video/sound/speech-check';
import { heardShifts } from '../../src/video/template/speech-rules';
import type { Measure } from '../../src/video/types';
import { registerVoice } from '../../src/video/voice/profile';
import { sampleSecondsFor, sampleStart } from '../../src/video/voice/sample';
import { cli, err, ok, type Json } from '../image-helpers';
import { ENV, fakePlatform, wav } from './hosted-fake';
import { scene } from './video-api-fake';

const disk = await createDiskRuntime();
afterAll(() => disk.cleanup());
const ffmpeg = await hasFfmpeg(disk);

describe('a silent clip on the platform', () => {
  const models = (more: Json) => ok({ models: [{ id: 'video-a', label: 'Video A', resolutions: ['480p'], seconds: { min: 4, max: 15 }, aspectRatios: ['16:9'], maxReferenceImages: 4, credits: { '480p': 5 }, ...more }], default: 'video-a' });

  it('is asked for without a sound track only on a model whose audioOptional is true, and the key says so', async () => {
    const keyOf = async (audioOptional: boolean, audio?: false): Promise<{ quoted: Json; key: string }> => {
      const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
      stub.set('GET', '/videos/models', () => models({ audioOptional }));
      await rt.fs.writeFile('/work/req.json', JSON.stringify({ prompt: 'a quiet street', seconds: 5, ...(audio === false ? { audio } : {}) }));
      const r = await cli(rt, 'video', 'generate', 'video', '/work/req.json', '/work/out.mp4');
      expect(r.code).toBe(0);
      return { quoted: stub.calls('POST', '/videos/quote')[0]?.json as Json, key: String(r.data.key) };
    };
    const optional = await keyOf(true, false), always = await keyOf(false, false), plain = await keyOf(true);
    expect(optional.quoted).toMatchObject({ generateAudio: false });
    expect(always.quoted.generateAudio).toBeUndefined();
    expect(plain.quoted.generateAudio).toBeUndefined();
    // A model that always makes a sound track is asked as usual: the same key as a request that never said "audio".
    expect(always.key).toBe(plain.key);
    expect(optional.key).not.toBe(plain.key);
  });

  it('refuses reference sounds the model does not take before anything is uploaded or priced', async () => {
    const { rt, stub } = await scene({ POPOST_GEN_MAX_CREDITS: '100' });
    stub.set('GET', '/videos/models', () => models({ maxReferenceAudios: 0 }));
    await rt.fs.writeFile('/work/voice.wav', wav({ seconds: 3 }));
    await rt.fs.writeFile('/work/req.json', JSON.stringify({ prompt: 'a host speaks', seconds: 5, audios: ['/work/voice.wav'] }));
    const r = await cli(rt, 'video', 'generate', 'video', '/work/req.json', '/work/out.mp4');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('takes no reference sounds');
    expect(stub.calls('POST', '/videos/uploads')).toEqual([]);
    expect(stub.calls('POST', '/videos/quote')).toEqual([]);
    // A list that cannot be read is no reason to refuse: the platform checks then.
    stub.set('GET', '/videos/models', () => err(500, 'INTERNAL', 'down'));
    expect((await cli(rt, 'video', 'generate', 'video', '/work/req.json', '/work/out.mp4')).code).toBe(0);
  });
});

describe('the voice sample', () => {
  it('is cut from the cleanest run of speech, an equal share of the reference sounds for each speaker', () => {
    expect(sampleStart([[2, 3]], 8, 10)).toEqual({ at: 3, seconds: 5 });
    expect(sampleStart([[2, 2.2]], 8, 10)).toEqual({ at: 0, seconds: 8 });
    expect(sampleStart([], 30, 10)).toEqual({ at: 0, seconds: 10 });
    expect([1, 2, 3, 10].map((n) => sampleSecondsFor(n))).toEqual([10, 7, 5, 2]);
  });

  it.skipIf(!ffmpeg)('popost video voice sample cuts it from the registered voice, a recording of the user\'s or a clip, and goes to every speaking clip', async () => {
    const dir = disk.path.join(disk.dir, 'voiced');
    await disk.fs.mkdir(dir);
    const tone = async (name: string, seconds: number, video = false): Promise<string> => {
      const out = disk.path.join(dir, name);
      await runFfmpegOk(disk, ['-y', '-loglevel', 'error', ...(video ? ['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=30:d=' + seconds] : []), '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + seconds, ...(video ? ['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : []), out]);
      return out;
    };
    await registerVoice(disk, dir, 'host', await tone('host.wav', 12), 'audio-first');
    const sample = (...more: string[]) => runCli(disk, ['video', 'voice', 'sample', dir, '--speaker', 'host', ...more]);
    expect((await sample()).code).toBe(0);
    expect(disk.json()).toMatchObject({ ok: true, sample: 'assets/voices/host.sample.wav', from: 'reference', at: 0, seconds: 10 });
    expect((await sample('--from', await tone('mine.wav', 8), '--start', '1', '--end', '4.5')).code).toBe(0);
    expect(disk.json()).toMatchObject({ from: 'file', source: 'mine.wav', at: 1, seconds: 3.5 });
    expect(await audioSeconds(disk, disk.path.join(dir, 'assets/voices/host.sample.wav'))).toBeCloseTo(3.5, 1);
    expect((await sample('--from', await tone('take.mp4', 4, true))).code).toBe(0);
    expect(disk.json()).toMatchObject({ from: 'clip', source: 'take.mp4' });
    expect((await sample('--from', disk.path.join(dir, 'mine.wav'), '--start', '0', '--end', '12')).code).toBe(2);
    expect(String(disk.json().error)).toContain('2 to 10 s');
    expect((await runCli(disk, ['video', 'voice', 'sample', dir, '--speaker', 'nobody'])).code).toBe(2);
    // The sample on record goes with every speaking clip of the speaker, whatever way the voice was registered.
    const asked: GenerateRequest[] = [];
    const generator: Generator = { make: async (_k, r, out) => { asked.push(r); await runFfmpegOk(disk, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]); return {}; } };
    await disk.fs.writeFile(disk.path.join(dir, 'cast.json'), JSON.stringify({ version: 1, roles: [{ id: 'host', description: 'A fictional presenter' }] }));
    const made = await makeMaterials(disk, { dir, generator, requests: [{ file: 'assets/talk.mp4', prompt: 'A presenter at a desk', seconds: 4, cast: ['host'], speech: { mode: 'native', speaker: 'host', text: 'Hello there.' } }] });
    expect(made.problems).toEqual([]);
    expect(asked[0]?.audios).toEqual([disk.path.join(dir, 'assets/voices/host.sample.wav')]);
    expect(asked[0]?.prompt).toContain('The voice of host is @audio1');
  }, 90_000);
});

describe('the speech check', () => {
  it('holds the heard words against the script, in order, and gives each line its measured time', () => {
    expect(matchSpeech('I use it every single day.', 'i use it every day')).toEqual({ script: 6, heard: 5, matched: 5, share: 0.83, missing: ['single'], extra: [] });
    expect(matchSpeech('我每天都用', '我每天用').matched).toBe(4);
    expect(matchSpeech('', 'anything').share).toBe(1);
    const words = [{ text: 'I', start: 0.6, end: 0.7 }, { text: 'use', start: 0.7, end: 0.9 }, { text: 'it', start: 0.9, end: 1 }, { text: 'Really', start: 2, end: 2.3 }, { text: 'every', start: 2.3, end: 2.6 }, { text: 'day', start: 2.6, end: 2.9 }];
    expect(lineTimes(['I use it.', 'Really every day.', 'Never said.'], words)).toEqual([{ at: 0.6, to: 1 }, { at: 2, to: 2.9 }, null]);
    expect(spokenSpans(words)).toEqual([[0.6, 1], [2, 2.9]]);
    expect(MATCH_FLOOR).toBe(0.8);
    expect(speechMatchProblems('assets/a.mp4', matchSpeech('one two three four five', 'one two three four five'))).toEqual([]);
    expect(speechMatchProblems('assets/a.mp4', matchSpeech('one two three four five', 'one two three four'))).toMatchObject([{ level: 'warning' }]);
    expect(speechMatchProblems('assets/a.mp4', matchSpeech('one two three four five', 'one two'))).toMatchObject([{ level: 'error', message: expect.stringContaining('speech-not-as-written') }]);
  });

  it.skipIf(!ffmpeg)('popost video speech-check prices the transcription first, measures each speaking clip once, and the mix and the captions follow it', async () => {
    const heard = [{ text: 'I', start: 0.7, end: 0.8 }, { text: 'use', start: 0.8, end: 1 }, { text: 'it', start: 1, end: 1.1 }, { text: 'every', start: 1.1, end: 1.3 }, { text: 'single', start: 1.3, end: 1.5 }, { text: 'day', start: 1.5, end: 1.7 }, { text: 'Try', start: 2.4, end: 2.6 }, { text: 'it', start: 2.6, end: 2.8 }];
    const platform = fakePlatform({ balance: 100, heard });
    const rt = await createDiskRuntime({ env: { ...ENV }, fetchHandler: platform.handler });
    try {
      const dir = rt.path.join(rt.dir, 'p');
      await rt.fs.mkdir(rt.path.join(dir, 'assets'));
      const clip = rt.path.join(dir, 'assets', 'talk.mp4');
      await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
      const lines = [{ speaker: 'host', text: 'I use it every single day.', at: 0.5, to: 1.6, beat: 2 }, { speaker: 'host', text: 'Try it.', at: 2.2, to: 2.7, beat: 3 }];
      await rt.fs.writeFile(clip + '.speech.json', JSON.stringify({ version: 1, mode: 'native', speaker: 'host', text: lines.map((l) => l.text).join(' '), language: 'en-US', lines, videoSha256: sha256(await rt.fs.readFile(clip)) }));
      const check = (...more: string[]) => runCli(rt, ['video', 'speech-check', dir, ...more]);
      expect((await check()).code).toBe(3);
      expect(rt.json()).toMatchObject({ ok: false, confirm: { credits: 1, items: [{ kind: 'transcription', what: 'the speech of assets/talk.mp4' }] } });
      expect(platform.account.charged).toBe(0);
      expect((await check('--confirm', '--max-credits', '5')).code).toBe(0);
      expect(rt.json()).toMatchObject({ ok: true, chargedCredits: 1, clips: [{ file: 'assets/talk.mp4', share: 1, matched: 8, script: 8, lines: [{ at: 0.7, to: 1.7 }, { at: 2.4, to: 2.8 }] }], problems: [] });
      // Measured once: the same clip is not heard, or paid for, again.
      const posts = platform.sent.filter((s) => s.path === '/transcriptions').length;
      expect((await check()).code).toBe(0);
      expect(rt.json()).toMatchObject({ chargedCredits: 0, clips: [{ kept: true }] });
      expect(platform.sent.filter((s) => s.path === '/transcriptions').length).toBe(posts);
      // The mix reads the measured stretches; the captions of the clip's beats move by what was measured.
      expect(await speechSpans(rt, clip, 3)).toEqual([[0.7, 1.7], [2.4, 2.8]]);
      expect(await heardShifts(rt, { shots: [{ footage: 'assets/talk.mp4' }] }, dir)).toEqual({ 2: { start: 0.2, end: 0.1 }, 3: { start: 0.2, end: 0.1 } });
      // A clip that says too little is an error that offers a remake.
      const short = fakePlatform({ balance: 100, heard: heard.slice(0, 2) });
      const other = await createDiskRuntime({ env: { ...ENV }, fetchHandler: short.handler });
      try {
        const copy = other.path.join(other.dir, 'q', 'assets');
        await other.fs.mkdir(copy);
        await other.fs.writeFile(other.path.join(copy, 'talk.mp4'), await rt.fs.readFile(clip));
        const receipt = JSON.parse(await rt.fs.readText(clip + '.speech.json')) as Record<string, unknown>;
        const { measured: _m, ...fresh } = receipt;
        await other.fs.writeFile(other.path.join(copy, 'talk.mp4.speech.json'), JSON.stringify(fresh));
        expect((await runCli(other, ['video', 'speech-check', other.path.join(other.dir, 'q'), '--confirm', '--max-credits', '5'])).code).toBe(2);
        expect(other.json()).toMatchObject({ ok: false, problems: [{ level: 'error', at: 'assets/talk.mp4', message: expect.stringContaining('speech-not-as-written') }] });
      } finally { await other.cleanup(); }
    } finally { await rt.cleanup(); }
  }, 90_000);
});

describe('captions of the lines a clip says', () => {
  const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
  const measure: Measure = {
    version: 1, source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
    boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }],
    shots: [{ index: 0, start: 0, end: 90, camera: still, background: '', palette: [], events: [] }, { index: 1, start: 90, end: 300, camera: still, background: '', palette: [], events: [] }],
    rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
  };
  const cue = (text: string, start: number, end: number) => ({ text, start, end, box: [0.1, 0.8, 0.8, 0.06] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 1, confidence: 1 });
  const text = { step: 3, sampled: 0, cues: [cue('a', 0, 90), cue('b', 150, 240)] };

  it('follow the time a line was measured at, by its offset from the asked slot; the others stay', () => {
    const during = (heard?: Record<number, { start: number; end: number }>) => {
      const r = retarget({ measure, text, plan: { shots: [{ color: '#101010' }, { color: '#202020' }], captions: ['one', 'two'] }, dialogue: [1], ...(heard ? { heard } : {}) });
      const track = r.project?.tracks.find((t) => t.type === 'caption');
      return track && track.type === 'caption' ? track.cues.map((c) => [c.during.from, c.during.to]) : [];
    };
    expect(during()).toEqual([[0, 90], [150, 240]]);
    expect(during({ 1: { start: 0.2, end: 0.3 } })).toEqual([[0, 90], [156, 249]]);
    expect(during({ 0: { start: -0.5, end: 0.5 } })).toEqual([[0, 105], [150, 240]]);
  });
});

describe.skipIf(!ffmpeg)('a generated track longer than the video', () => {
  it('is cut to the video\'s length with a fade-out, and a track that fits is kept as it came', async () => {
    const file = disk.path.join(disk.dir, 'track.mp3');
    await runFfmpegOk(disk, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '44100', '-c:a', 'libmp3lame', file]);
    expect(await fitTrack(disk, file, 5.4)).toEqual({ seconds: 8, fadeOut: 1 });
    expect(await audioSeconds(disk, file)).toBeCloseTo(5.4, 1);
    const pcm = (await runFfmpegOk(disk, ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const level = (from: number, to: number): number => {
      let sum = 0;
      for (let i = Math.round(from * 8000); i < Math.round(to * 8000); i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
      return 10 * Math.log10(sum / Math.max(1, Math.round((to - from) * 8000)) + 1e-12);
    };
    expect(level(1, 2) - level(5.3, 5.38)).toBeGreaterThan(15);
    expect(await fitTrack(disk, file, 6)).toBeUndefined();
    await disk.fs.writeFile(disk.path.join(disk.dir, 'not-audio.mp3'), 'x');
    expect(await fitTrack(disk, disk.path.join(disk.dir, 'not-audio.mp3'), 2)).toBeUndefined();
  }, 60_000);
});
