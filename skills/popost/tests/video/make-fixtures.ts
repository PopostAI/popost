/** Projects and picture helpers shared by the make-* tests. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeFileSystem, nodePrograms } from '../../src/node-runtime';
import { createTestRuntime } from '../../src/testing/memory';
import type { LocalProcesses } from '../../src/runtime';
import type { Project } from '../../src/video/types';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';

/** Decodes the pictures the tests look at: the real disk and ffmpeg, nothing else (a test's own runtime has a scratch directory). */
const pictures = createTestRuntime({ fs: nodeFileSystem, path, programs: nodePrograms, env: { POPOST_FFMPEG: process.env.POPOST_FFMPEG } });

/** What the preview needs of the desktop besides files and programs: a local web server (createDiskRuntime has none). */
export const serverProcesses: LocalProcesses = {
  createServer,
  spawnDetached: () => Promise.reject(new Error('the video tests start no detached process')),
  selfCommand: [],
};

/** A valid project: four segments (a cut, a 9-frame slide, a 12-frame fade), text, shape, image, audio. */
export const goodProject = (): Project => ({
  version: 1,
  canvas: { width: 1080, height: 1920, fps: 30 },
  materials: [
    { id: 'desk', kind: 'image', file: 'assets/desk.png' },
    { id: 'logo', kind: 'image', file: 'assets/logo.png' },
    { id: 'pop', kind: 'audio', file: 'assets/pop.wav' },
    { id: 'music', kind: 'audio', file: 'assets/music.wav' },
  ],
  segments: [
    { id: 'hook', frames: 30, base: { material: 'desk', camera: { zoom: 0.04 } } },
    { id: 'proof', frames: 30, base: { color: '#203040' } },
    { id: 'detail', frames: 30, base: { color: '#ffffff' }, in: { transition: 'slide', frames: 9 } },
    { id: 'end', frames: 30, base: { color: '#101014' }, in: { transition: 'fade', frames: 12 } },
  ],
  tracks: [
    { id: 'claim', type: 'text', text: '只要 19.9', style: 'headline', box: [0.1, 0.12, 0.8, 0.14], during: { segment: 'hook', from: 3 }, enter: { preset: 'pop' }, exit: { preset: 'fade' }, sound: 'pop' },
    { id: 'bar', type: 'shape', shape: 'rect', color: '#ffcc00', box: [0.1, 0.7, 0.8, 0.05], during: { segment: 'proof', to: 200 }, enter: { preset: 'slide', direction: 'left' } },
    { id: 'logo', type: 'image', material: 'logo', box: [0.35, 0.4, 0.3, 0.2], during: { segment: 'end', from: 6 }, enter: { preset: 'scale-in', frames: 10, ease: 'out' }, z: -1 },
    { id: 'bgm', type: 'audio', material: 'music', gain: -18 },
  ],
});

/** A deep copy that a test may change. */
export const variant = (change: (p: Project) => void): Project => {
  const p = structuredClone(goodProject());
  change(p);
  return p;
};

/** A decoded picture: RGB bytes, row by row. */
export interface Rgb { data: Buffer; width: number; height: number }

/** A PNG (as the renderer returns it) decoded to RGB with ffmpeg. */
export const decodePng = async (png: Buffer): Promise<Rgb> => {
  const r = await runFfmpegOk(pictures, ['-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], png);
  // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
  return { data: Buffer.from(r.stdout), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

export type Colour = [number, number, number];

export const pixelAt = (img: Rgb, x: number, y: number): Colour => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 3;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
};

export const isNear = (a: readonly number[], b: readonly number[], tol = 24): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);

/** Every pixel of the box [x0, y0, x1, y1) that passes the test, as [x, y]. */
export const pixelsWhere = (img: Rgb, box: readonly number[], test: (c: Colour) => boolean): [number, number][] => {
  const [x0 = 0, y0 = 0, x1 = img.width, y1 = img.height] = box;
  const out: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(pixelAt(img, x, y))) out.push([x, y]);
  return out;
};

/** A new temporary project directory with an assets folder, holding video.json for project. */
export const projectDir = async (prefix: string, project: Project): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'video.json'), JSON.stringify(project, null, 2));
  return dir;
};

/** Frame n reached right after frame n-1 and after a jump from frame 0 (the renderer's PNGs). */
export const playedAndJumped = async (frame: (n: number) => Promise<Buffer>, n: number): Promise<[Buffer, Buffer]> => {
  await frame(n - 1);
  const played = await frame(n);
  await frame(0);
  return [played, await frame(n)];
};
