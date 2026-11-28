/**
 * `popost video describe` reads the sound of a reference: measured here for nothing (sound.json, the "Sound" sections
 * of REFERENCE.md and timeline.md), and listened to by popost.ai for a price that is shown first and paid only with
 * --confirm --max-credits; --no-sound-analysis, a server without the analysis and a missing account leave the
 * measurement and say why nobody listened. The platform is the in-memory fake; the video is made here by ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { isSoundFile, type SoundFile } from '../../src/video/sound/reading';
import { ENV, fakePlatform } from './hosted-fake';

const RESULT = {
  music: { present: true, description: 'a steady electronic pulse', genre: 'minimal electronic', mood: 'neutral', tempo: 'medium', bpm: 120, instruments: ['synth blips'], vocals: 'none', energy: 'low', sections: [{ from: 0, to: 6, what: 'one loop' }] },
  ambience: { present: false, description: '' }, effects: [{ at: 3, what: 'a short blip', kind: 'pop' }], speech: { present: false, kind: 'none', languages: [] }, summary: 'A pulse.',
};
const probe = await createDiskRuntime();
const ok = await hasFfmpeg(probe);
await probe.cleanup();

describe.skipIf(!ok)('describe reads the sound of the reference', () => {
  let rt: DiskRuntime, plain: DiskRuntime;
  const platform = fakePlatform({ balance: 50, soundAnalysis: RESULT }), old = fakePlatform({ balance: 50 });
  const read = async (r: DiskRuntime, dir: string): Promise<SoundFile> => JSON.parse(await r.fs.readText(r.path.join(r.dir, dir, 'sound.json'))) as SoundFile;
  beforeAll(async () => {
    rt = await createDiskRuntime({ fetchHandler: platform.handler, env: ENV });
    plain = await createDiskRuntime({ fetchHandler: old.handler, env: ENV });
    // Six seconds, two flat colours with a cut at 3 s, and a 50 ms beep every half second: 120 beats a minute.
    const beeps = 'aevalsrc=exprs=0.6*sin(2*PI*880*t)*lt(mod(t\\,0.5)\\,0.05):s=44100:d=6';
    for (const r of [rt, plain])
      await runFfmpegOk(r, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=96x96:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=0xc08020:s=96x96:r=30:d=3', '-f', 'lavfi', '-i', beeps,
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', r.path.join(r.dir, 'ref.mp4')]);
  }, 120_000);
  afterAll(async () => { await rt.cleanup(); await plain.cleanup(); });

  it('shows the price of the listener first, and charges nothing without --confirm', async () => {
    expect((await runCli(rt, ['video', 'describe', 'ref.mp4', '--out', 'd', '--no-speech'])).code).toBe(3);
    expect(rt.json()).toMatchObject({ ok: false, confirm: { credits: 6, items: [{ kind: 'sound-analysis', credits: 6 }] } });
    expect(platform.account.charged).toBe(0);
  }, 120_000);

  it('measures the beat and the cut, has popost.ai listen within the budget, and writes the sound into the description', async () => {
    expect((await runCli(rt, ['video', 'describe', 'ref.mp4', '--out', 'd', '--no-speech', '--confirm', '--max-credits', '10'])).code).toBe(0);
    const out = rt.json() as { chargedCredits: number; files: string[]; soundReading: { analysis: string; music: string; plan: { music: string }; beatGrid?: { bpm: number } } };
    expect(out.chargedCredits).toBe(6);
    expect(out.files).toContain('sound.json');
    expect(out.soundReading).toMatchObject({ analysis: 'done', plan: { music: 'bed' } });
    expect(out.soundReading.music).toContain('Music: yes: minimal electronic');
    const file = await read(rt, 'd');
    expect(isSoundFile(file)).toBe(true);
    expect(Math.abs((file.measured?.tempo?.bpm ?? 0) - 120)).toBeLessThan(2);
    expect(file.measured?.onsets.length).toBeGreaterThanOrEqual(10);
    // The one cut lies on a beep.
    expect(file.measured?.cuts).toMatchObject({ events: 1, onOnset: 1 });
    expect(file.facts.effects).toEqual([{ at: 3, what: 'a short blip', kind: 'pop' }]);
    const card = await rt.fs.readText(rt.path.join(rt.dir, 'd', 'REFERENCE.md'));
    expect(card).toContain('## Sound');
    expect(card).toContain('Default sound plan: Music: one bed under the whole video');
    expect(await rt.fs.readText(rt.path.join(rt.dir, 'd', 'timeline.md'))).toContain('- effect 3.00 pop: a short blip');
    // The same sound again is not analysed, or paid for, a second time.
    expect((await runCli(rt, ['video', 'describe', 'ref.mp4', '--out', 'd', '--no-speech'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ chargedCredits: 0, soundReading: { analysis: 'done' } });
    expect(platform.account.charged).toBe(6);
  }, 240_000);

  it('goes on without a listener on a server that has no sound analysis, and with --no-sound-analysis', async () => {
    expect((await runCli(plain, ['video', 'describe', 'ref.mp4', '--out', 'd', '--no-speech'])).code).toBe(0);
    expect(plain.json()).toMatchObject({ chargedCredits: 0, soundReading: { analysis: 'unavailable', plan: { music: 'ask' } } });
    expect((await read(plain, 'd')).facts.music).toBe('likely');
    expect((await runCli(plain, ['video', 'describe', 'ref.mp4', '--out', 'e', '--no-speech', '--no-sound-analysis'])).code).toBe(0);
    expect(plain.json()).toMatchObject({ soundReading: { analysis: 'skipped' }, leftOut: expect.arrayContaining([expect.objectContaining({ because: 'skipped' })]) });
    expect(old.sent.filter((s) => s.path.startsWith('/sound-analyses')).map((s) => s.path)).toEqual(['/sound-analyses/quote']);
  }, 240_000);
});
