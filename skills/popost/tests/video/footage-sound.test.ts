import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import type { FootageInfo, Project } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { resolve } from '../../src/video/timeline/resolve';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { encodeArgs, tempoChain } from '../../src/video/render/encode';

const FACTS: Record<string, FootageInfo> = {
  clip: { width: 180, height: 320, fps: 30, frames: 90, hasAudio: true },
  mute: { width: 180, height: 320, fps: 30, frames: 90, hasAudio: false },
};

/** Two footage shots and a video item, none of which says "audio"; the second shot's file has no sound. */
const project = (): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'clip', kind: 'video', file: 'assets/clip.mp4' }, { id: 'mute', kind: 'video', file: 'assets/mute.mp4' }, { id: 'voice', kind: 'audio', file: 'assets/voice.m4a' }],
  segments: [{ id: 's0', frames: 30, base: { material: 'clip' } }, { id: 's1', frames: 30, base: { material: 'mute' } }],
  tracks: [{ id: 'inset', type: 'video', material: 'clip', box: [0.5, 0, 0.5, 0.5], in: 30, speed: 1.5, during: { segment: 's1' } }],
});
const withVoice = (p: Project): Project => ({ ...p, tracks: [...p.tracks, { id: 'sound', type: 'audio', material: 'voice' }] });

describe('the footage\'s own sound', () => {
  it('is kept at its own level when nothing says "audio" and the project has no audio track', () => {
    const r = resolve(project(), FACTS);
    expect(r.audio).toEqual([
      { id: 's0.audio', src: 'assets/clip.mp4', start: 0, end: 30, gain: 0, from: { frame: 0, fps: 30 } },
      { id: 'inset.audio', src: 'assets/clip.mp4', start: 30, end: 60, gain: 0, from: { frame: 30, fps: 30 }, speed: 1.5 },
    ]);
    // A file without sound is simply silent: nobody wrote "audio", so nothing is warned about.
    expect(checkProject(project(), { footage: FACTS })).toEqual([]);
  });

  it('is silent under a voice-over or any other audio track, unless a use sets a gain', () => {
    expect(resolve(withVoice(project()), FACTS).audio.map((a) => a.id)).toEqual(['sound']);
    const ducked = withVoice(project());
    (ducked.segments[0] as { base: { audio?: number } }).base.audio = -18;
    expect(resolve(ducked, FACTS).audio.map((a) => [a.id, a.gain])).toEqual([['sound', 0], ['s0.audio', -18]]);
  });

  it('"audio": false mutes a use whatever the project holds', () => {
    const p = project();
    (p.segments[0] as { base: { audio?: false } }).base.audio = false;
    expect(resolve(p, FACTS).audio.map((a) => a.id)).toEqual(['inset.audio']);
  });

  it('plays at the footage\'s speed: the file is read at the rate and its tempo changed', () => {
    expect([tempoChain(1), tempoChain(2), tempoChain(0.25), tempoChain(4)]).toEqual(['', ',atempo=2', ',atempo=0.5,atempo=0.5', ',atempo=2,atempo=2']);
    const graph = encodeArgs({ out: 'o.mp4', fps: 30, from: 0, to: 60, image: 'png', crf: 18, audio: [{ id: 'a', src: '/a.mp4', start: 30, end: 60, gain: 0, from: { frame: 30, fps: 30 }, speed: 1.5 }] });
    const chain = graph[graph.indexOf('-filter_complex') + 1] ?? '';
    // One second of the video from 1 s of the file on: 1.5 s of the file, played 1.5 times as fast.
    expect(chain).toContain('atrim=start=1:duration=1.5,asetpts=PTS-STARTPTS,atempo=1.5,adelay=delays=48000S');
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });

describe.skipIf(!(await hasFfmpeg(rt)))('the footage\'s own sound in a render (ffmpeg)', () => {
  it('a clip at speed 2 is heard at speed 2', async () => {
    const file = (name: string): string => rt.path.join(rt.dir, name);
    // The clip is silent for 1 s, then a tone for 1 s; 30 black frames stand for the render's pictures.
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=2', '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,1),0.5*sin(2*PI*440*t),0)':s=48000:d=2", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('clip.mp4')]);
    const frames = (await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])).stdout;
    await runFfmpegOk(rt, encodeArgs({ out: file('out.mp4'), fps: 30, from: 0, to: 30, image: 'png', crf: 30, audio: [{ id: 'a', src: file('clip.mp4'), start: 0, end: 30, gain: 0, from: { frame: 0, fps: 30 }, speed: 2 }] }), frames);
    const pcm = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file('out.mp4'), '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const level = (from: number, to: number): number => {
      let sum = 0;
      for (let i = Math.round(from * 8000); i < Math.round(to * 8000); i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
      return 10 * Math.log10(sum / Math.max(1, Math.round((to - from) * 8000)) + 1e-12);
    };
    // At speed 2 the tone of the file's second second starts half a second in.
    expect(level(0.05, 0.4)).toBeLessThan(-50);
    expect(level(0.6, 0.95)).toBeGreaterThan(-20);
  });
});
