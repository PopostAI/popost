/**
 * An animation library for scenes: the command that puts its file into a project, the check that names the command
 * when a scene loads a file that is not there, and a timeline of the library driven frame by frame (the picture of a
 * frame depends on the frame alone). Needs Chrome and ffmpeg; skipped without them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { PACKAGE_ROOT, runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

let rt: DiskRuntime;
beforeAll(async () => { rt = await createDiskRuntime(); });
afterAll(async () => { await rt.cleanup(); });
const probe = await createDiskRuntime();
const ready = (await hasFfmpeg(probe)) && hasChrome();
await probe.cleanup();

/** A 200x100 scene: a 20 px red box that a paused timeline moves 100 px to the right in one second, evenly. */
const SCENE = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:200px;height:100px;overflow:hidden;background:#102040}' +
  '#box{position:absolute;left:0;top:40px;width:20px;height:20px;background:#ff0000}</style></head><body><div id="box"></div>' +
  '<script src="../lib/gsap.min.js"></script><script>var tl = gsap.timeline({ paused: true }); tl.to("#box", { x: 100, duration: 1, ease: "none" }); window.__timelines = { main: tl };</script></body></html>';

const project = async (name: string): Promise<string> => {
  const dir = path.join(rt.dir, name);
  await mkdir(path.join(dir, 'scenes'), { recursive: true });
  await writeFile(path.join(dir, 'video.json'), JSON.stringify({ version: 1, canvas: { width: 200, height: 100, fps: 30 }, materials: [], tracks: [], segments: [{ id: 'a', frames: 30, base: { scene: 'scenes/move.html' } }] }));
  await writeFile(path.join(dir, 'scenes', 'move.html'), SCENE);
  return name;
};

/** The colour of one pixel of a PNG, read with ffmpeg. */
const pixel = async (png: string, x: number, y: number, width: number): Promise<number[]> => {
  const raw = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])).stdout;
  return [...raw.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
};
const isRed = (c: number[]): boolean => (c[0] ?? 0) > 200 && (c[1] ?? 255) < 60;

describe.skipIf(!ready)('popost video scene library', () => {
  it('scene check names the missing library file and the command that supplies it', async () => {
    const dir = await project('missing');
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(2);
    const problems = rt.json().problems as { at: string; message: string; fix: string }[];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ at: 'segments[0].base.scene' });
    expect(problems[0]?.message).toContain('loads the script "../lib/gsap.min.js"');
    expect(problems[0]?.fix).toBe('Run: popost video scene library missing --name gsap   (it puts the file into the project)');
  });

  it('puts the unchanged file of the installed package into the project and says how a scene uses it', async () => {
    const dir = await project('added');
    expect((await runCli(rt, ['video', 'scene', 'library', dir])).code).toBe(0);
    const json = rt.json();
    expect(json).toMatchObject({ ok: true, library: 'gsap', file: path.join('added', 'lib/gsap.min.js'), tag: '<script src="../lib/gsap.min.js"></script>' });
    expect(String(json.version)).toMatch(/^3\./);
    expect(String(json.licence)).toContain('gsap.com/standard-license');
    const installed = await readFile(path.join(PACKAGE_ROOT, '..', '..', 'node_modules', 'gsap', 'dist', 'gsap.min.js'));
    expect((await readFile(path.join(rt.dir, 'added', 'lib', 'gsap.min.js'))).equals(installed)).toBe(true);
    expect((await runCli(rt, ['video', 'scene', 'check', dir])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, opened: 1, errors: 0 });
  });

  it('the timeline is at the frame\'s time whichever frame is drawn first', async () => {
    const dir = await project('driven');
    await runCli(rt, ['video', 'scene', 'library', dir]);
    // Frame 15 first (half a second: the box spans 50..70), then frame 0 (0..20): a jump back gives the picture of that frame.
    for (const [frame, inside, outside] of [[15, 60, 40], [0, 10, 40], [29, 107, 80]] as const) {
      const png = path.join(rt.dir, 'f' + frame + '.png');
      expect((await runCli(rt, ['video', 'frame', dir, '--frame', String(frame), '--out', png])).code, rt.stdoutText()).toBe(0);
      expect(isRed(await pixel(png, inside, 50, 200)), 'frame ' + frame + ' at x ' + inside).toBe(true);
      expect(isRed(await pixel(png, outside, 50, 200)), 'frame ' + frame + ' at x ' + outside).toBe(false);
    }
  });

  it('refuses a library it does not know', async () => {
    const dir = await project('unknown');
    const r = await runCli(rt, ['video', 'scene', 'library', dir, '--name', 'nothing']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid choice');
  });
});
