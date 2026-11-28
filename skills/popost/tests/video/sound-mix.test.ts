/**
 * A fill's "sound" in the mix: at its own level without a voice, 18 dB under the voice of a spoken fill, and faded out
 * where the video cuts it off. The last part renders a tone with ffmpeg and measures the levels (skipped without it).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { parseProject } from '../../src/video/project/schema';
import { encodeArgs } from '../../src/video/render/encode';
import { SOUND_FADE_SECONDS, UNDER_VOICE_DB, retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { resolve } from '../../src/video/timeline/resolve';
import type { Measure } from '../../src/video/types';

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const measure: Measure = {
  version: 1,
  source: { width: 1280, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 90, kind: 'cut', start: 89, end: 90, confidence: 1 }],
  shots: [
    { index: 0, start: 0, end: 90, camera: still, background: '', palette: [], events: [] },
    { index: 1, start: 90, end: 300, camera: still, background: '', palette: [], events: [] },
  ],
  rhythm: { step: 3, change: [] },
  signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const plan: RetargetPlan = { shots: [{ color: '#101010' }, { color: '#202020' }], sound: 'assets/music.mp3' };
const audioOf = (r: ReturnType<typeof retarget>) => (r.project?.tracks ?? []).filter((t) => t.type === 'audio');

describe('a fill\'s sound', () => {
  it('plays at its own level without a voice and fades out when the video cuts it off', () => {
    const r = retarget({ measure, plan });
    expect(audioOf(r)).toEqual([{ id: 'sound', type: 'audio', material: 'audio-1', fadeOut: SOUND_FADE_SECONDS }]);
    expect(parseProject(r.project).problems).toEqual([]);
    expect(resolve(r.project!, {}).audio).toEqual([{ id: 'sound', src: 'assets/music.mp3', start: 0, gain: 0, fadeOut: 1 }]);
  });

  it('lies 18 dB under the voice of a spoken fill, which keeps its own level and no fade', () => {
    const r = retarget({ measure, plan: { ...plan, sound: 'assets/voice.m4a' }, music: 'assets/music.mp3', wordsFile: 'assets/voice.words.json' });
    expect(audioOf(r)).toEqual([
      { id: 'sound', type: 'audio', material: 'audio-1' },
      { id: 'music', type: 'audio', material: 'audio-2', gain: UNDER_VOICE_DB, fadeOut: SOUND_FADE_SECONDS },
    ]);
    expect(UNDER_VOICE_DB).toBe(-18);
    expect(r.project?.materials.map((m) => m.file)).toEqual(['assets/voice.m4a', 'assets/music.mp3']);
    expect(r.notes.join(' ')).toContain('lies under the voice, 18 dB lower');
    // A fill that named the voice file itself as its sound has one track, not the voice twice.
    expect(audioOf(retarget({ measure, plan: { ...plan, sound: 'assets/voice.m4a' }, music: 'assets/voice.m4a', wordsFile: 'assets/voice.words.json' }))).toHaveLength(1);
  });

  it('fades to silence over its last second in the mix, at the video\'s end also when a part is rendered', () => {
    const chainOf = (from: number, to: number, audio: Parameters<typeof encodeArgs>[0]['audio']): string => {
      const args = encodeArgs({ out: 'o.mp4', fps: 30, from, to, image: 'png', crf: 18, audio });
      return args[args.indexOf('-filter_complex') + 1] ?? '';
    };
    const music = { id: 'music', src: '/m.mp3', start: 0, gain: -18, fadeOut: 1 };
    expect(chainOf(0, 300, [music])).toContain('volume=-18dB,afade=t=out:st=9:d=1[a0]');
    expect(chainOf(0, 300, [{ ...music, fadeOut: undefined }])).not.toContain('afade');
    // Frames 150 to 300 of a sound that ends with the video at frame 300: the fade is 4 s into the part.
    expect(chainOf(150, 300, [{ ...music, end: 300 }])).toContain('afade=t=out:st=4:d=1');
    // A sound shorter than two fades is faded over half of itself.
    expect(chainOf(0, 300, [{ ...music, start: 270, end: 300 }])).toContain('afade=t=out:st=9.5:d=0.5');
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });

describe.skipIf(!(await hasFfmpeg(rt)))('a fill\'s sound in a render (ffmpeg)', () => {
  it('is 18 dB lower under a voice and silent at the very end', async () => {
    const file = (name: string): string => rt.path.join(rt.dir, name);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '48000', '-c:a', 'libmp3lame', file('music.mp3')]);
    const frames = (await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=4', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])).stdout;
    const levels = async (gain: number, fadeOut?: number): Promise<{ middle: number; end: number }> => {
      await runFfmpegOk(rt, encodeArgs({ out: file('out.mp4'), fps: 30, from: 0, to: 120, image: 'png', crf: 30, audio: [{ id: 'music', src: file('music.mp3'), start: 0, gain, ...(fadeOut ? { fadeOut } : {}) }] }), frames);
      const pcm = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file('out.mp4'), '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const level = (from: number, to: number): number => {
        let sum = 0;
        for (let i = Math.round(from * 8000); i < Math.round(to * 8000); i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
        return 10 * Math.log10(sum / Math.max(1, Math.round((to - from) * 8000)) + 1e-12);
      };
      return { middle: level(1, 2), end: level(3.9, 3.98) };
    };
    const alone = await levels(0), under = await levels(-18, 1);
    expect(alone.middle - under.middle).toBeCloseTo(18, 0);
    // Without a fade the tone runs to the cut; with one the last tenth of a second is far below the middle.
    expect(alone.middle - alone.end).toBeLessThan(1);
    expect(under.middle - under.end).toBeGreaterThan(15);
  }, 60_000);
});
