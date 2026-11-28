/**
 * A clip made without sound: a model asked for no sound track (generateAudio false) returns a video with no audio
 * stream at all, not a silent track. Every path that reads a clip's sound (footage measurement, the mix, the checks,
 * the Studio state, the render, the draft export, the speech check, the voice sample, native speech) treats it as
 * silence and never fails on its missing stream. The fixture is made here with ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { buildPage } from '../../src/video/compile/index';
import { prepareDraft } from '../../src/video/draft/export';
import { makeMaterials, type Generator } from '../../src/video/generate/index';
import { finalizeSpeech } from '../../src/video/generate/speech';
import { hasFfmpeg, probe, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { readFootage } from '../../src/video/media/footage';
import { loadAll } from '../../src/video/preview/project';
import { renderVideo } from '../../src/video/render/index';
import { readModeReceipt } from '../../src/video/sound/modes';
import { decodeMono, integratedLoudness } from '../../src/video/sound/pcm';
import { measureClipSpeech } from '../../src/video/sound/speech-check';
import { resolve } from '../../src/video/timeline/resolve';
import type { Project } from '../../src/video/types';
import { registerVoice } from '../../src/video/voice/profile';
import { ENV, fakePlatform } from './hosted-fake';
import { serverProcesses } from './make-fixtures';

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(() => rt.cleanup());
const ffmpeg = await hasFfmpeg(rt);
const chrome = ffmpeg && hasChrome();

const dir = rt.path.join(rt.dir, 'p');
const QUIET = 'assets/quiet.mp4';

/** A clip as a model returns it without sound: h264 video and no audio stream. */
const quietClip = async (file: string, seconds = 2): Promise<string> => {
  await rt.fs.mkdir(rt.path.dirname(file));
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=30:d=' + seconds, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  return file;
};
const tone = async (file: string, seconds: number): Promise<string> => {
  await rt.fs.mkdir(rt.path.dirname(file));
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=' + seconds, '-ar', '48000', '-c:a', 'pcm_s16le', file]);
  return file;
};

/** The clip as a speaking shot with a level of its own, as the shot after it under a bed of its own sound, and a voice-over. */
const project: Project = {
  version: 1, canvas: { width: 64, height: 36, fps: 30 },
  materials: [{ id: 'quiet', kind: 'video', file: QUIET }, { id: 'voice', kind: 'audio', file: 'assets/voice.wav' }],
  segments: [{ id: 's1', frames: 30, base: { material: 'quiet', audio: 0, soundMode: 'speech' } }, { id: 's2', frames: 30, base: { material: 'quiet', in: 30 } }],
  tracks: [{ id: 'bed', type: 'audio', material: 'quiet', bed: true, during: { segment: 's2', from: 0, to: 30 } }, { id: 'vo', type: 'audio', material: 'voice', role: 'voice', lines: [[0, 60]] }],
};

beforeAll(async () => {
  if (!ffmpeg) return;
  await quietClip(rt.path.join(dir, QUIET));
  await tone(rt.path.join(dir, 'assets/voice.wav'), 2);
  await rt.fs.writeFile(rt.path.join(dir, 'video.json'), JSON.stringify(project, null, 2));
}, 60_000);

describe.skipIf(!ffmpeg)('a clip without an audio stream', () => {
  it('is measured as silence: no sound, no speech, no samples, no loudness', async () => {
    const clip = rt.path.join(dir, QUIET);
    expect((await probe(rt, clip)).hasAudio).toBe(false);
    const { facts } = await readFootage(rt, clip);
    expect(facts.hasAudio).toBe(false);
    expect(facts.speech).toBeUndefined();
    expect((await decodeMono(rt, clip)).length).toBe(0);
    expect(await integratedLoudness(rt, clip)).toBeUndefined();
  });

  it('adds nothing to the mix: the build, its checks and the Studio state carry the voice-over only', async () => {
    const built = await buildPage(rt, dir);
    expect(built.problems.filter((p) => p.level === 'error').map((p) => p.at + ': ' + p.message)).toEqual([]);
    expect(built.problems.map((p) => p.at)).toEqual(expect.arrayContaining(['segments[0].base.audio', 'tracks[0].material']));
    expect(built.resolved?.audio.map((a) => a.src)).toEqual(['assets/voice.wav']);
    // A speaking clip without sound says nothing: no lines of dialogue for the rest of the mix to give way to.
    expect(built.resolved?.speech?.dialogue ?? []).toEqual([]);
    const studio = await loadAll(rt, { projectDir: dir }, 1);
    expect(studio.state.resolved?.audio.map((a) => a.src).some((s) => s.includes('quiet'))).toBe(false);
    expect(studio.state.resolved?.audio).toHaveLength(1);
    // The same by resolve with the facts given directly.
    const facts = { quiet: { width: 64, height: 36, fps: 30, frames: 60, hasAudio: false } };
    expect(resolve(project, facts).audio.map((a) => a.id)).toEqual(['vo']);
  }, 60_000);

  it.skipIf(!chrome)('renders, and exports as a draft, with the voice-over as the only sound', async () => {
    const out = rt.path.join(rt.dir, 'quiet-render.mp4');
    await renderVideo(rt, { projectDir: dir, out });
    const made = await probe(rt, out);
    expect(made).toMatchObject({ frames: 60, hasAudio: true });
    const draft = await prepareDraft(rt, dir, project);
    expect(draft.audio).toHaveLength(1);
    expect(draft.videos).toHaveLength(2);
  }, 120_000);

  it('is kept as it came when it was asked for silent, and a speaking clip without sound is a plain error', async () => {
    const generated = rt.path.join(rt.dir, 'generated');
    const generator: Generator = { make: async (_k, _r, out) => { await quietClip(out, 4); return {}; } };
    const made = await makeMaterials(rt, { dir: generated, generator, requests: [{ file: 'assets/street.mp4', prompt: 'A quiet street at dawn', seconds: 4, sound: 'silent' }] });
    expect(made.materials).toMatchObject([{ file: 'assets/street.mp4', made: true }]);
    expect(made.materials[0]?.error).toBeUndefined();
    const receipt = await readModeReceipt(rt, rt.path.join(generated, 'assets/street.mp4'));
    expect(receipt).toMatchObject({ sound: 'silent' });
    expect(receipt).not.toHaveProperty('stripped');
    const talk = await quietClip(rt.path.join(generated, 'assets/talk.mp4'));
    await expect(finalizeSpeech(rt, talk, { mode: 'native', speaker: 'host', text: 'Hello there.' }, generated)).rejects.toThrow(/came back without sound/);
  }, 60_000);

  it('gives no voice sample: popost video voice sample says the clip has no sound', async () => {
    const voiced = rt.path.join(rt.dir, 'voiced');
    await registerVoice(rt, voiced, 'host', await tone(rt.path.join(voiced, 'host.wav'), 8), 'audio-first');
    const clip = await quietClip(rt.path.join(voiced, 'assets/take.mp4'));
    expect((await runCli(rt, ['video', 'voice', 'sample', voiced, '--speaker', 'host', '--from', clip])).code).toBe(2);
    expect(String(rt.json().error)).toContain('has no sound');
  }, 60_000);

  it('fails the speech check as saying nothing, with nothing transcribed or charged', async () => {
    const platform = fakePlatform({ balance: 100 });
    const hosted = await createDiskRuntime({ env: { ...ENV }, fetchHandler: platform.handler });
    try {
      const project2 = hosted.path.join(hosted.dir, 'q');
      const clip = hosted.path.join(project2, 'assets', 'talk.mp4');
      await hosted.fs.mkdir(hosted.path.dirname(clip));
      await hosted.fs.writeFile(clip, await rt.fs.readFile(rt.path.join(dir, QUIET)));
      await hosted.fs.writeFile(clip + '.speech.json', JSON.stringify({ version: 1, mode: 'native', speaker: 'host', text: 'Hello there.', language: 'en-US' }));
      expect((await runCli(hosted, ['video', 'speech-check', project2, '--confirm', '--max-credits', '5'])).code).toBe(2);
      expect(hosted.json()).toMatchObject({ ok: false, chargedCredits: 0, clips: [{ file: 'assets/talk.mp4', silent: true, matched: 0 }], problems: [{ level: 'error', at: 'assets/talk.mp4', message: expect.stringContaining('no sound') }] });
      expect(platform.sent.filter((s) => s.path === '/transcriptions')).toEqual([]);
      expect(platform.account.charged).toBe(0);
      // Measured once, without a transcriber: the receipt keeps it.
      expect(await measureClipSpeech(hosted, project2, 'assets/talk.mp4')).toMatchObject({ silent: true, words: [] });
    } finally { await hosted.cleanup(); }
  }, 60_000);
});
