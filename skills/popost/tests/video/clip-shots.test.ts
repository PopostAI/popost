/**
 * Several shots from one generated clip: the advice on how a list is cut into calls, the bed that keeps a clip's sound
 * in one piece under the shots cut from it, and `popost video shots`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/testing/memory';
import { createDiskRuntime } from '../../src/testing/disk';
import type { FootageInfo, Project } from '../../src/video/types';
import { groupingAdvice } from '../../src/video/generate/index';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { bedProblems } from '../../src/video/retarget/index';
import { resolve } from '../../src/video/timeline/resolve';
import { ffmpegReady, xfadeClip } from './read-clips';

describe('how a list is cut into calls', () => {
  const clip = (n: number, more: Record<string, unknown> = {}) => ({ file: 'assets/s' + n + '.mp4', prompt: 'shot ' + n, seconds: 4, ...more });
  it('advises one call for three or more short clips, and leaves out the clips that need a call of their own', () => {
    const advice = groupingAdvice([clip(1), clip(2), clip(3)]);
    expect(advice.map((p) => p.level + ' ' + p.at)).toEqual(['warning [0]']);
    expect(advice[0]?.message).toContain('3 clips of 5 s or less are asked for one by one (12 s in all)');
    expect(advice[0]?.fix).toContain('one continuous soundtrack');
    expect(groupingAdvice([clip(1), clip(2)])).toEqual([]);
    expect(groupingAdvice([clip(1), clip(2), clip(3, { seconds: 12 })])).toEqual([]);
    expect(groupingAdvice([clip(1), clip(2), clip(3, { firstFrame: 'assets/a.png' }), clip(4, { anchor: false }), { file: 'assets/p.png', prompt: 'x' }])).toEqual([]);
  });
});

const FACTS: Record<string, FootageInfo> = { film: { width: 180, height: 320, fps: 24, frames: 240, hasAudio: true }, other: { width: 180, height: 320, fps: 30, frames: 90, hasAudio: true } };
const project = (): Project => ({
  version: 1, canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'film', kind: 'video', file: 'assets/film.mp4' }, { id: 'other', kind: 'video', file: 'assets/other.mp4' }],
  segments: [
    { id: 'shot-01', frames: 30, base: { material: 'film', in: 2 } },
    { id: 'shot-02', frames: 30, base: { material: 'film', in: 40, speed: 1.2 } },
    { id: 'shot-03', frames: 30, base: { material: 'other' } },
  ],
  tracks: [{ id: 'bed-1', type: 'audio', material: 'film', bed: true, in: 2, during: { segment: 'shot-01', from: 0, to: 60 } }],
});

describe('a bed: the sound of a clip under the shots cut from it', () => {
  it('plays once, from its in-point, and the shots under it do not sound a second time; a shot outside it keeps its own', () => {
    expect(parseProject(project()).problems).toEqual([]);
    expect(checkProject(project(), { footage: FACTS })).toEqual([]);
    expect(resolve(project(), FACTS).audio).toEqual([
      { id: 'bed-1', src: 'assets/film.mp4', start: 0, end: 60, gain: 0, from: { frame: 2, fps: 24 } },
      { id: 'shot-03.audio', src: 'assets/other.mp4', start: 60, end: 90, gain: 0, from: { frame: 0, fps: 30 } },
    ]);
    const loud = project();
    (loud.segments[1] as { base: { audio?: number } }).base.audio = -6;
    expect(resolve(loud, FACTS).audio.map((a) => a.id)).toEqual(['bed-1', 'shot-02.audio', 'shot-03.audio']);
  });

  it('is checked in a fill and in a project', () => {
    expect(bedProblems([{ footage: 'assets/film.mp4', shots: [1, 2] }, { footage: 'assets/b.mp4', shots: [3, 3], in: 4, audio: -6 }], 3)).toEqual([]);
    expect(bedProblems([{ footage: 'assets/film.mp4', shots: [0, 2] }, { footage: 'assets/film.mp4', shots: [2, 4] }, { footage: 'assets/film.mp4', shots: [1, 2] }, { footage: 'assets/film.mp4', shots: [2, 3], in: -1 }], 3).map((p) => p.at)).toEqual(['beds[0]', 'beds[1]', 'beds[3].in', 'beds[3].shots']);
    const wrong = project();
    wrong.tracks = [{ id: 'a', type: 'audio', material: 'film', in: 3 }];
    expect(checkProject(wrong, { footage: FACTS }).map((p) => p.at)).toEqual(['tracks[0].material']);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });

describe.skipIf(!(await ffmpegReady()))('popost video shots (ffmpeg)', () => {
  it('finds the cuts inside a clip and keeps a frame of each shot', async () => {
    await xfadeClip(rt, rt.path.join(rt.dir, 'film.mp4'), [{ src: 'testsrc2', frames: 30 }, { src: 'color=c=0x3366cc', frames: 45 }, { src: 'mandelbrot', frames: 36 }], [{ name: 'cut', frames: 0 }, { name: 'cut', frames: 0 }]);
    const r = await runCli(rt, ['video', 'shots', 'film.mp4', '--out', 'look']);
    const data = JSON.parse(r.stdout) as { ok: boolean; cuts: number; shots: { shot: number; in: number; picture: string }[] };
    expect([r.code, data.ok]).toEqual([0, true]);
    expect(data.cuts).toBe(2);
    expect(data.shots.map((s) => s.in)).toEqual([0, 30, 75]);
    expect(data.shots[0]).toMatchObject({ shot: 1, in: 0, picture: 'look/shot-01.jpg' });
    expect(await rt.fs.stat(rt.path.join(rt.dir, 'look', 'shot-01.jpg'))).not.toBeNull();
  });
});
