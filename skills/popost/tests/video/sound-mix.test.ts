/**
 * A fill's "sound" in the mix: at its own level without a voice, 18 dB lower while the voice of a spoken fill speaks a
 * line and back up in its pauses, and faded out where the video cuts it off. The layers (timeline/mix.ts): a clip made
 * with speech is heard at full level, the other clips and the music give way to speech on its known times. The last
 * parts render tones with ffmpeg and measure the levels (skipped without it).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { parseProject } from '../../src/video/project/schema';
import { duckFilter, encodeArgs } from '../../src/video/render/encode';
import { DUCK_DB, duckAt, duckOf, heardSpan, joinSpans, overlapOf } from '../../src/video/timeline/mix';
import { speechOverlap } from '../../src/video/project/check-sound';
import { SOUND_FADE_SECONDS, UNDER_VOICE_DB, retarget, type RetargetPlan } from '../../src/video/retarget/index';
import { resolve } from '../../src/video/timeline/resolve';
import type { FootageFacts, Measure, Project } from '../../src/video/types';

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
    expect(audioOf(r)).toEqual([{ id: 'sound', type: 'audio', material: 'audio-1', role: 'music', fadeOut: SOUND_FADE_SECONDS }]);
    expect(parseProject(r.project).problems).toEqual([]);
    expect(resolve(r.project!, {}).audio).toEqual([{ id: 'sound', src: 'assets/music.mp3', start: 0, gain: 0, fadeOut: 1 }]);
  });

  it('lies 18 dB under the lines of a spoken fill and at its own level in the pauses; the voice keeps its level and no fade', () => {
    const captions = { step: 3, sampled: 0, cues: [{ text: 'a', start: 0, end: 90, box: [0.1, 0.8, 0.8, 0.06] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 1, confidence: 1 }, { text: 'b', start: 150, end: 240, box: [0.1, 0.8, 0.8, 0.06] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 1, confidence: 1 }] };
    const r = retarget({ measure, text: captions, plan: { ...plan, captions: ['one', 'two'], sound: 'assets/voice.m4a' }, music: 'assets/music.mp3', wordsFile: 'assets/voice.words.json', spoken: { frames: [60, 45], hold: true } });
    expect(audioOf(r)).toEqual([
      { id: 'sound', type: 'audio', material: 'audio-1', role: 'voice', lines: [[0, 60], [150, 195]] },
      { id: 'music', type: 'audio', material: 'audio-2', role: 'music', fadeOut: SOUND_FADE_SECONDS },
    ]);
    expect(UNDER_VOICE_DB).toBe(-18);
    expect(parseProject(r.project).problems).toEqual([]);
    expect(r.project?.materials.map((m) => m.file)).toEqual(['assets/voice.m4a', 'assets/music.mp3']);
    expect(r.notes.join(' ')).toContain('18 dB lower while a line is spoken, at its own level in the pauses');
    // The music gives way on the two lines, with ramps of 0.2 s (6 frames); the voice gives way to nothing.
    const [voice, music] = resolve(r.project!, {}).audio;
    expect(voice?.duck).toBeUndefined();
    expect(music).toMatchObject({ id: 'music', gain: 0, duck: { spans: [[0, 60], [150, 195]], db: 18, ramp: 6 } });
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

/** A project of two footage shots, a voice-over with one line and a music track, as a spoken fill writes it. */
const layered = (o: { audio?: false | number } = {}): Project => ({
  version: 1, canvas: { width: 320, height: 180, fps: 30 },
  materials: [{ id: 'talk', kind: 'video', file: 'assets/talk.mp4' }, { id: 'street', kind: 'video', file: 'assets/street.mp4' }, { id: 'voice', kind: 'audio', file: 'assets/voice.m4a' }, { id: 'music', kind: 'audio', file: 'assets/music.mp3' }],
  segments: [{ id: 'shot-01', frames: 120, base: { material: 'talk' } }, { id: 'shot-02', frames: 120, base: { material: 'street', ...(o.audio !== undefined ? { audio: o.audio } : {}) } }],
  tracks: [{ id: 'sound', type: 'audio', material: 'voice', role: 'voice', lines: [[150, 210]] }, { id: 'music', type: 'audio', material: 'music', role: 'music', fadeOut: 1 }],
});
const clip: FootageFacts = { width: 320, height: 180, fps: 30, frames: 150, hasAudio: true };
/** The person of talk.mp4 says two lines, from 0.5 to 1.5 s and from 2 to 3 s of the clip. */
const facts = { talk: { ...clip, speech: [[0.5, 1.5], [2, 3]] as [number, number][] }, street: clip };

describe('the layers of the mix', () => {
  it('keeps a clip in which a person speaks at full level, and lowers the other clips and the music under speech', () => {
    const r = resolve(layered(), facts);
    const by = Object.fromEntries(r.audio.map((a) => [a.id, a]));
    // The speaking clip: its own level, and it gives way to nothing.
    expect(by['shot-01.audio']).toMatchObject({ gain: 0 });
    expect(by['shot-01.audio']?.duck).toBeUndefined();
    // The other clip keeps its sound (it used to be muted by a voice) and gives way to the voice's line that lies on it.
    expect(by['shot-02.audio']).toMatchObject({ gain: 0, duck: { spans: [[150, 210]], db: DUCK_DB } });
    // The music gives way to every speech: the two lines of the clip (frames 15-45 and 60-90) and the voice's line.
    expect(by.music?.duck?.spans).toEqual([[15, 45], [60, 90], [150, 210]]);
    expect(r.speech).toEqual({ voice: [[150, 210]], dialogue: [{ id: 'shot-01.audio', spans: [[15, 45], [60, 90]] }] });
    expect(speechOverlap(r)).toEqual([]);
  });

  it('lets a shot\'s "audio" override the layers: a number fixes the level, false mutes', () => {
    const fixed = resolve(layered({ audio: -6 }), facts).audio.find((a) => a.id === 'shot-02.audio');
    expect(fixed).toMatchObject({ gain: -6 });
    expect(fixed?.duck).toBeUndefined();
    expect(resolve(layered({ audio: false }), facts).audio.some((a) => a.id === 'shot-02.audio')).toBe(false);
  });

  it('keeps clips at their own level, untouched, when there is neither a voice nor a person who speaks', () => {
    const quiet: Project = { ...layered(), tracks: [] };
    expect(resolve(quiet, { talk: clip, street: clip }).audio).toEqual([
      { id: 'shot-01.audio', src: 'assets/talk.mp4', start: 0, end: 120, gain: 0, from: { frame: 0, fps: 30 } },
      { id: 'shot-02.audio', src: 'assets/street.mp4', start: 120, end: 240, gain: 0, from: { frame: 0, fps: 30 } },
    ]);
    // A track without a role is a sound of the project's own, as before: it keeps footage silent, but never a person who speaks.
    const own: Project = { ...layered(), tracks: [{ id: 'sound', type: 'audio', material: 'music' }] };
    expect(resolve(own, facts).audio.map((a) => a.id)).toEqual(['sound', 'shot-01.audio']);
  });

  it('refuses a voice-over line that is spoken while the person of a clip speaks', () => {
    const p = layered();
    const clash: Project = { ...p, tracks: p.tracks.map((t) => (t.type === 'audio' && t.role === 'voice' ? { ...t, lines: [[30, 70]] as [number, number][] } : t)) };
    const problems = speechOverlap(resolve(clash, facts));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ level: 'error', at: 'tracks.shot-01' });
    expect(problems[0]?.message).toContain('two speeches are heard at once');
    expect(problems[0]?.fix).toContain('belongs to the clip alone');
  });

  it('computes the envelope from the known times alone', () => {
    expect(joinSpans([[40, 50], [0, 10], [8, 20]])).toEqual([[0, 20], [40, 50]]);
    expect(overlapOf([[0, 10]], [[10, 20]])).toBeUndefined();
    expect(overlapOf([[0, 11]], [[10, 20]])).toEqual([[0, 11], [10, 20]]);
    // Pauses shorter than two ramps (12 frames at 30 fps) do not bring the level back up.
    expect(duckOf([[30, 60], [70, 90], [150, 180]], 30)).toEqual({ spans: [[30, 90], [150, 180]], db: 18, ramp: 6 });
    expect(duckOf([], 30)).toBeUndefined();
    const duck = duckOf([[30, 60]], 30);
    expect([10, 24, 27, 30, 45, 60, 63, 66, 80].map((f) => duckAt(duck, f))).toEqual([0, 0, 9, 18, 18, 18, 9, 0, 0]);
    // A line of a clip on the timeline: the clip starts at frame 100 from its 1st second, at double speed.
    expect(heardSpan([2, 3], { start: 100, end: 200, inSeconds: 1, speed: 2 }, 30)).toEqual([115, 130]);
    expect(heardSpan([9, 10], { start: 100, end: 200, inSeconds: 1, speed: 1 }, 30)).toBeUndefined();
    // The filter: spans in seconds of the rendered range, none when no span is heard in it.
    expect(duckFilter(duck, 30)).toBe(",volume=volume='pow(10,-18/20*min(clip((t-0.8)/0.2,0,1),clip((2.2-t)/0.2,0,1)))':eval=frame");
    expect(duckFilter(duck, 30, 300, 5)).toBe('');
    expect(duckFilter(undefined, 30)).toBe('');
  });
});

describe.skipIf(!(await hasFfmpeg(rt)))('the layers in a render (ffmpeg)', () => {
  it('lowers a clip\'s sound by 18 dB while a line is spoken and brings it back in the pauses', async () => {
    const file = (name: string): string => rt.path.join(rt.dir, name);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-ar', '48000', '-c:a', 'libmp3lame', file('ambience.mp3')]);
    const frames = (await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=4', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])).stdout;
    // Lines from 1.0 to 2.0 s and from 3.0 to 3.5 s; the pause between them is longer than two ramps.
    const duck = duckOf([[30, 60], [90, 105]], 30);
    await runFfmpegOk(rt, encodeArgs({ out: file('ducked.mp4'), fps: 30, from: 0, to: 120, image: 'png', crf: 30, audio: [{ id: 'shot-01.audio', src: file('ambience.mp3'), start: 0, gain: 0, ...(duck ? { duck } : {}) }] }), frames);
    const pcm = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file('ducked.mp4'), '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const level = (from: number, to: number): number => {
      let sum = 0;
      for (let i = Math.round(from * 8000); i < Math.round(to * 8000); i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
      return 10 * Math.log10(sum / Math.max(1, Math.round((to - from) * 8000)) + 1e-12);
    };
    const before = level(0.2, 0.7), first = level(1.1, 1.9), pause = level(2.3, 2.7), second = level(3.05, 3.45), after = level(3.75, 3.95);
    expect(before - first).toBeCloseTo(18, 0);
    expect(before - second).toBeCloseTo(18, 0);
    expect(Math.abs(before - pause)).toBeLessThan(1);
    expect(Math.abs(before - after)).toBeLessThan(1);
    // On the ramp the level lies between the two.
    const ramp = level(0.88, 0.92);
    expect(before - ramp).toBeGreaterThan(3);
    expect(before - ramp).toBeLessThan(15);
  }, 60_000);
});
