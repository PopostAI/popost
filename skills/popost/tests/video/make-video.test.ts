import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverProcesses } from './make-fixtures';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { FootageInfo, Problem, Project, Segment, VideoTrack } from '../../src/video/types';
import { parseProject } from '../../src/video/project/schema';
import { checkProject } from '../../src/video/project/check';
import { resolve } from '../../src/video/timeline/resolve';
import { sourceFrame } from '../../src/video/timeline/footage';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { buildPage, type BuiltPage } from '../../src/video/compile/index';
import { openRenderer, renderVideo } from '../../src/video/render/index';
import { startPreview } from '../../src/video/preview/index';

const W = 180;
const H = 320;
/** Each frame of a test clip shows its own number in 8 horizontal bands, one bit each (white = 1), band 0 at the top. */
const BANDS = 8;
const CODE = "format=yuv420p,geq=lum='if(mod(floor(N/pow(2,floor(Y*" + BANDS + "/H))),2),235,16)':cb=128:cr=128";
const FACTS: Record<string, FootageInfo> = {
  c30: { width: W, height: H, fps: 30, frames: 90, hasAudio: true },
  c25: { width: W, height: H, fps: 25, frames: 100, hasAudio: false },
};

/**
 * 130 frames at 30 fps. Left half: the bases. s0 plays c30 from 0; a dissolve (26..33) into s1, c30 from in 10; a slide
 * (57..62) into s2, the 25 fps clip c25; a cut to s3, c30 from in 80, which runs out at frame 110 and holds frame 89.
 * Right half: item "fast" plays c30 at speed 2 on 0..29; item "voice" plays c30 from in 30 with its sound on 30..59;
 * then the bases show through.
 */
const project = (): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'c30', kind: 'video', file: 'assets/c30.mp4' }, { id: 'c25', kind: 'video', file: 'assets/c25.mp4' }],
  segments: [
    { id: 's0', frames: 30, base: { material: 'c30' } },
    { id: 's1', frames: 30, base: { material: 'c30', in: 10 }, in: { transition: 'dissolve', frames: 8 } },
    { id: 's2', frames: 40, base: { material: 'c25' }, in: { transition: 'slide', frames: 6 } },
    { id: 's3', frames: 30, base: { material: 'c30', in: 80 } },
  ],
  tracks: [
    { id: 'fast', type: 'video', material: 'c30', box: [0.5, 0, 0.5, 1], fit: 'cover', speed: 2, during: { segment: 's0' } },
    { id: 'voice', type: 'video', material: 'c30', box: [0.5, 0, 0.5, 1], fit: 'cover', in: 30, audio: 0, during: { segment: 's1' } },
  ],
});

/** What the test expects, written out by hand from the mapping in types.ts; undefined inside transitions. */
const expectLeft = (n: number): number | undefined => {
  if (n < 26) return n;
  if (n >= 34 && n < 57) return 10 + (n - 30);
  if (n >= 63 && n < 100) return Math.round(((n - 60) * 25) / 30);
  if (n >= 100) return Math.min(89, 80 + (n - 100));
  return undefined;
};
const expectRight = (n: number): number | undefined => (n < 30 ? 2 * n : n < 60 ? n : expectLeft(n));

const seg = (p: Project, k: number): Segment => p.segments[k] as Segment;
const video = (p: Project, i: number): VideoTrack => p.tracks[i] as VideoTrack;
const problemsOf = (p: Project, footage?: Record<string, FootageInfo>): Problem[] => checkProject(p, footage ? { footage } : {});
const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};
const change = (f: (p: Project) => void): Project => {
  const p = project();
  f(p);
  return p;
};

describe('video footage: format, check and frame mapping', () => {
  it('parses video bases and video items, and refuses wrong values with a fix', () => {
    const parsed = parseProject(project());
    expect(parsed.problems).toEqual([]);
    expect(seg(parsed.project as Project, 1).base).toEqual({ material: 'c30', in: 10 });
    const bad = parseProject({ ...project(), tracks: [{ ...video(project(), 1), speed: 8, audio: true, repeat: true }] });
    expect(bad.project).toBeUndefined();
    expect(at(bad.problems, 'tracks[0].speed').message).toContain('at most 4');
    expect(at(bad.problems, 'tracks[0].audio').fix).toContain('"audio": 0');
    expect(at(bad.problems, 'tracks[0].repeat', 'warning').message).toContain('Unknown field');
  });

  it('checks in, speed and audio against the source', () => {
    expect(problemsOf(project())).toEqual([]);
    const ok = problemsOf(project(), FACTS);
    expect(ok.filter((p) => p.level === 'error')).toEqual([]);
    expect(at(ok, 'segments[3].base', 'warning').message).toContain('from project frame 110');
    expect(at(problemsOf(change((p) => { seg(p, 1).base = { material: 'c30', in: 90 }; }), FACTS), 'segments[1].base.in').fix).toContain('at most 89');
    expect(at(problemsOf(change((p) => { video(p, 1).speed = 2; }), FACTS), 'tracks[1].audio', 'warning').message).toContain('speed 1');
    expect(at(problemsOf(change((p) => { seg(p, 2).base = { material: 'c25', audio: -6 }; }), FACTS), 'segments[2].base.audio', 'warning').message).toContain('no sound');
    const image = change((p) => { p.materials.push({ id: 'pic', kind: 'image', file: 'assets/pic.png' }); seg(p, 0).base = { material: 'pic', in: 3 }; });
    expect(at(problemsOf(image), 'segments[0].base.in').message).toContain('applies to a video material');
    expect(at(problemsOf(project(), { ...FACTS, c25: { error: 'not a video' } }), 'materials[1].file').message).toContain('not a video');
    expect(() => resolve(project())).toThrow(/"c30" needs the frame rate and frame count/);
  });

  it('maps project frames to source frames: in, speed, another frame rate, before the start and past the end', () => {
    const src = (fps: number, frames: number) => ({ fps, frames });
    expect([0, 1, 2, 3].map((n) => sourceFrame({ start: 0, in: 0, speed: 1 }, src(30, 90), 30, n))).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((n) => sourceFrame({ start: 0, in: 0, speed: 2 }, src(30, 90), 30, n))).toEqual([0, 2, 4, 6]);
    expect([10, 11, 12].map((n) => sourceFrame({ start: 10, in: 5, speed: 1 }, src(30, 90), 30, n))).toEqual([5, 6, 7]);
    expect([0, 1, 2, 3, 6].map((n) => sourceFrame({ start: 0, in: 0, speed: 1 }, src(25, 100), 30, n))).toEqual([0, 1, 2, 3, 5]);
    expect([0, 3, 10].map((n) => sourceFrame({ start: 10, in: 7, speed: 1 }, src(30, 90), 30, n))).toEqual([7, 7, 7]);
    expect([88, 89, 90, 200].map((n) => sourceFrame({ start: 0, in: 0, speed: 1 }, src(30, 90), 30, n))).toEqual([88, 89, 89, 89]);
    const r = resolve(project(), FACTS);
    expect(r.segments[1]?.base).toMatchObject({ kind: 'video', play: { material: 'c30', start: 30, in: 10, speed: 1 } });
    expect(r.items.map((it) => it.play)).toEqual([{ material: 'c30', start: 0, in: 0, speed: 2 }, { material: 'c30', start: 30, in: 30, speed: 1 }]);
    expect(r.audio).toEqual([{ id: 'voice.audio', src: 'assets/c30.mp4', start: 30, end: 60, gain: 0, from: { frame: 30, fps: 30 } }]);
    expect(r.footage).toEqual({ c30: { src: 'assets/c30.mp4', fps: 30, frames: 90 }, c25: { src: 'assets/c25.mp4', fps: 25, frames: 100 } });
  });
});

const rt = await createDiskRuntime({ processes: serverProcesses });
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

const gray = async (args: string[], input?: Buffer): Promise<Buffer> =>
  Buffer.from((await runFfmpegOk(rt, ['-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], input)).stdout);

/** The number shown at x in a gray W x H frame starting at byte offset. */
const readCode = (g: Buffer, offset: number, x: number): number =>
  Array.from({ length: BANDS }, (_v, b) => ((g[offset + Math.floor(((b + 0.5) * H) / BANDS) * W + x] ?? 0) > 128 ? 2 ** b : 0)).reduce((a, v) => a + v, 0);

/** RMS level in dB of 50 ms windows of the file's sound, as mono 8 kHz. */
const levels = async (file: string): Promise<number[]> => {
  const pcm = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  return Array.from({ length: Math.floor(samples.length / 400) }, (_v, w) => {
    let sum = 0;
    for (let i = w * 400; i < (w + 1) * 400; i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
    return 10 * Math.log10(sum / 400 + 1e-12);
  });
};

describe.skipIf(!ready)('video footage: build and render (Chrome + ffmpeg)', () => {
  let dir = '';
  let first: BuiltPage = { problems: [] };
  let second: BuiltPage = { problems: [] };
  const out = (): string => path.join(dir, 'out.mp4');

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'make-video-'));
    await mkdir(path.join(dir, 'assets'));
    // c30: 3 s at 30 fps with sound that is silent for 1 s, then a tone; c25: 4 s at 25 fps, no sound.
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':r=30:d=3', '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,1),0.5*sin(2*PI*440*t),0)':s=48000:d=3",
      '-vf', CODE, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'assets', 'c30.mp4')]);
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':r=25:d=4', '-vf', CODE, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', path.join(dir, 'assets', 'c25.mp4')]);
    await writeFile(path.join(dir, 'video.json'), JSON.stringify(project(), null, 2));
    first = await buildPage(rt, dir);
    second = await buildPage(rt, dir);
    await renderVideo(rt, { projectDir: dir, out: out() });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('extracts only the frames the timeline shows into the project cache, and reuses them', async () => {
    expect(first.problems.map((p) => p.level + ' ' + p.at)).toEqual(['warning segments[3].base']);
    const fast = Array.from({ length: 30 }, (_v, n) => 2 * n);
    const want = { c30: new Set([...Array.from({ length: 34 }, (_v, n) => n), ...fast, ...Array.from({ length: 33 }, (_v, i) => 10 + i - 4), ...Array.from({ length: 30 }, (_v, i) => 30 + i), ...Array.from({ length: 10 }, (_v, i) => 80 + i)]).size };
    const dirs = first.resolved?.footage ?? {};
    const c30 = await readdir(path.join(dir, dirs.c30?.dir ?? 'missing'));
    expect(dirs.c30?.dir).toMatch(/^\.cache\/video\/[0-9a-f]{16}$/);
    expect(c30.filter((f) => f.endsWith('.jpg'))).toHaveLength(want.c30);
    expect(c30).toContain('000058.jpg');
    expect(c30).not.toContain('000060.jpg');
    expect(first.footage?.extracted).toBeGreaterThan(want.c30);
    expect(second.footage).toMatchObject({ extracted: 0, reused: first.footage?.extracted });
    const half = await buildPage(rt, dir, { scale: 0.5 });
    expect(half.resolved?.footage?.c30?.dir).not.toBe(dirs.c30?.dir);
    const size = (await runFfmpegOk(rt, ['-i', path.join(dir, half.resolved?.footage?.c30?.dir ?? '', '000000.jpg'), '-f', 'null', '-']).catch((e: { stderr: string }) => e)).stderr;
    expect(size).toMatch(/, 90x160[ ,]/);
  });

  it('shows the right source frame at every frame: speed 1 and 2, a non-zero in, a 25 fps source, past the end', async () => {
    const g = await gray(['-i', out()]);
    const frames = g.length / (W * H);
    expect(frames).toBe(130);
    const wrong: string[] = [];
    for (let n = 0; n < frames; n++) {
      const left = readCode(g, n * W * H, W / 4);
      const right = readCode(g, n * W * H, (3 * W) / 4);
      if (expectLeft(n) !== undefined && left !== expectLeft(n)) wrong.push(n + ' left ' + left + ' != ' + expectLeft(n));
      if (expectRight(n) !== undefined && right !== expectRight(n)) wrong.push(n + ' right ' + right + ' != ' + expectRight(n));
    }
    expect(wrong).toEqual([]);
  });

  it('draws frames inside transitions over video bases the same when jumped to and when played', async () => {
    const renderer = await openRenderer(rt, dir);
    try {
      for (const n of [27, 30, 31, 33, 58, 60, 62, 101, 111]) {
        await renderer.frame(n - 1);
        const played = await renderer.frame(n);
        await renderer.frame(0);
        const jumped = await renderer.frame(n);
        expect(played.equals(jumped), 'frame ' + n).toBe(true);
      }
      expect((await renderer.frame(28)).equals(await renderer.frame(29))).toBe(false);
    } finally {
      await renderer.close();
    }
  });

  it('mixes the footage\'s own sound from its in-point, delayed to the item\'s start, and nothing else', async () => {
    const db = await levels(out());
    const window = (from: number, to: number): number[] => db.slice(Math.ceil(from / 0.05), Math.floor(to / 0.05));
    // The item plays source 1.0 s .. 2.0 s (the tone) on project 1.0 s .. 2.0 s; every other base is silent footage.
    expect(Math.max(...window(0, 0.95))).toBeLessThan(-60);
    expect(Math.min(...window(1.05, 1.95))).toBeGreaterThan(-20);
    expect(Math.max(...window(2.05, 4.3))).toBeLessThan(-60);
  });

  it('serves the cached frames in the preview, and refuses a cache that links out of the project', async () => {
    const preview = await startPreview(rt, { projectDir: dir });
    try {
      const state = (await (await fetch(preview.url + 'api/state')).json()) as { resolved: { footage: Record<string, { dir: string }> } };
      const frame = await fetch(preview.url + 'project/' + state.resolved.footage.c30?.dir + '/000000.jpg');
      expect([frame.status, frame.headers.get('content-type')]).toEqual([200, 'image/jpeg']);
    } finally {
      await preview.close();
    }
    const linked = await mkdtemp(path.join(tmpdir(), 'make-video-linked-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'make-video-outside-'));
    try {
      await mkdir(path.join(linked, 'assets'));
      await symlink(path.join(dir, 'assets', 'c25.mp4'), path.join(linked, 'assets', 'c25.mp4'));
      await symlink(outside, path.join(linked, '.cache'));
      await writeFile(path.join(linked, 'video.json'), JSON.stringify({ ...project(), materials: [project().materials[1]], segments: [{ id: 's', frames: 10, base: { material: 'c25' } }], tracks: [] }));
      await expect(buildPage(rt, linked)).rejects.toThrow(/outside the project directory/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
