/**
 * The bottom of the video engine: local programs through the runtime, ffmpeg found and run, a video file probed and
 * decoded, and the two commands that report them. Media is synthesized with ffmpeg; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodePrograms } from '../../src/node-runtime';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { VideoUnavailableError, toolCommand, withTempDir } from '../../src/video/host';
import { decodeFrames, extractFrame } from '../../src/video/media/decode';
import { hasFfmpeg, probe, runFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';

let rt: DiskRuntime;
beforeAll(async () => { rt = await createDiskRuntime(); });
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(await createDiskRuntime().then(async (r) => { await r.cleanup(); return r; }));

describe('local programs', () => {
  it('runs a program to its end, with input, and keeps its output and exit code', async () => {
    const r = await nodePrograms.run([process.execPath, '-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on("end", () => { console.error("done"); process.exit(3); })'], { stdin: new TextEncoder().encode('abc') });
    expect(new TextDecoder().decode(r.stdout)).toBe('ABC');
    expect(r.stderr.trim()).toBe('done');
    expect(r.code).toBe(3);
  });

  it('feeds an iterable piece by piece, hands output over as it comes, and fails with the iterable\'s own error', async () => {
    const pieces: string[] = [];
    const feed = async function* (): AsyncGenerator<Uint8Array> { for (const s of ['a', 'b', 'c']) yield new TextEncoder().encode(s); };
    const r = await nodePrograms.run([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { stdin: feed(), onStdout: (c) => pieces.push(new TextDecoder().decode(c)) });
    expect(pieces.join('')).toBe('abc');
    expect(r.stdout.length).toBe(0);
    const broken = async function* (): AsyncGenerator<Uint8Array> { yield new Uint8Array(1); throw new Error('the frames ran out'); };
    await expect(nodePrograms.run([process.execPath, '-e', 'process.stdin.resume()'], { stdin: broken() })).rejects.toThrow('the frames ran out');
  });

  it('leaves no listener behind while it waits for a slow program to read: no MaxListenersExceededWarning', async () => {
    const warnings: string[] = [];
    const listen = (w: Error): void => { warnings.push(w.name + ': ' + w.message); };
    process.on('warning', listen);
    try {
      // Every piece is larger than a pipe holds, so each write waits for the program to read (as frames do in render).
      const feed = async function* (): AsyncGenerator<Uint8Array> { for (let i = 0; i < 24; i++) yield new Uint8Array(1 << 20); };
      const r = await nodePrograms.run([process.execPath, '-e', 'let n = 0; process.stdin.on("data", (d) => { n += d.length; }); process.stdin.on("end", () => process.stdout.write(String(n)))'], { stdin: feed() });
      expect(new TextDecoder().decode(r.stdout)).toBe(String(24 << 20));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('warning', listen);
    }
    expect(warnings.filter((w) => w.startsWith('MaxListenersExceededWarning'))).toEqual([]);
  });

  it('rejects with ENOENT for a program that is not installed', async () => {
    await expect(nodePrograms.run(['popost-no-such-program'])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives scratch directories that are gone afterwards, and reads a tool from the environment', async () => {
    let seen = '';
    await expect(withTempDir(rt, 'popost-video-test-', async (dir) => { seen = dir; expect((await rt.fs.stat(dir))?.isDirectory).toBe(true); throw new Error('stop'); })).rejects.toThrow('stop');
    expect(await rt.fs.stat(seen)).toBeNull();
    expect(toolCommand({ ...rt, env: { POPOST_TTS_CMD: ' python3  tts.py --fast ' } }, 'POPOST_TTS_CMD')).toEqual(['python3', 'tts.py', '--fast']);
    expect(toolCommand(rt, 'POPOST_TTS_CMD')).toBeUndefined();
  });

  it('says what to do where local programs do not exist, or ffmpeg is not installed', async () => {
    const virtual = createTestRuntime();
    await expect(runFfmpeg(virtual, ['-version'])).rejects.toThrow(VideoUnavailableError);
    expect(await hasFfmpeg(virtual)).toBe(false);
    const none = { ...rt, env: { POPOST_FFMPEG: 'popost-no-such-ffmpeg' } };
    await expect(runFfmpeg(none, ['-version'])).rejects.toThrow(/Install ffmpeg or set POPOST_FFMPEG/);
    expect(await hasFfmpeg(none)).toBe(false);
  });
});

describe.skipIf(!ffmpeg)('probe and decode', () => {
  it('counts frames exactly and reads size, rate and audio', async () => {
    const file = rt.path.join(rt.dir, 'a.mp4');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    const p = await probe(rt, file);
    expect(p).toMatchObject({ width: 180, height: 320, fps: 30, frames: 75, hasAudio: true });
    expect(p.duration).toBeCloseTo(2.5, 5);
  });

  it('keeps a fractional frame rate', async () => {
    const file = rt.path.join(rt.dir, 'b.mp4');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=30000/1001', '-frames:v', '45', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const p = await probe(rt, file);
    expect(p.frames).toBe(45);
    expect(p.fps).toBeCloseTo(29.97, 2);
    expect(p.hasAudio).toBe(false);
  });

  it('says what is wrong with a file that has no video', async () => {
    const file = rt.path.join(rt.dir, 'c.m4a');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', 'aac', file]);
    await expect(probe(rt, file)).rejects.toThrow(/No video stream/);
  });

  it('decodes every frame to thumbnails of the asked width, and writes one frame as a picture', async () => {
    const file = rt.path.join(rt.dir, 'd.mp4');
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=0x2060a0:size=320x180:rate=25', '-frames:v', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const d = await decodeFrames(rt, file, { width: 32, gray: false });
    expect(d).toMatchObject({ width: 32, height: 18, fps: 25 });
    expect(d.frames).toHaveLength(20);
    expect(d.frames[7]).toHaveLength(32 * 18 * 3);
    // A flat colour comes back within a few levels (H.264 and the colour matrix).
    const [r, g, b] = [d.frames[7]?.[0] ?? 0, d.frames[7]?.[1] ?? 0, d.frames[7]?.[2] ?? 0];
    expect(Math.abs(r - 0x20) + Math.abs(g - 0x60) + Math.abs(b - 0xa0)).toBeLessThan(12);
    const png = rt.path.join(rt.dir, 'frame.png');
    await extractFrame(rt, file, 3, png, 64);
    expect([...(await rt.fs.readFile(png)).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });
});

describe.skipIf(!ffmpeg)('popost video probe and doctor', () => {
  it('probe prints the facts of a file, relative to the working directory; a missing file is an error with exit code 2', async () => {
    await runFfmpegOk(rt, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=30', '-frames:v', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rt.path.join(rt.dir, 'e.mp4')]);
    expect((await runCli(rt, ['video', 'probe', 'e.mp4'])).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, width: 160, height: 90, fps: 30, frames: 30, duration: 1, hasAudio: false });
    expect((await runCli(rt, ['video', 'probe', 'nothing.mp4'])).code).toBe(2);
    expect(rt.json()).toMatchObject({ ok: false });
  });

  it('doctor reports ffmpeg, the browser and the tools named in the environment', async () => {
    const withTool = await createDiskRuntime({ env: { POPOST_TTS_CMD: 'my-speaker' } });
    try {
      const r = await runCli(withTool, ['video', 'doctor']);
      const json = withTool.json();
      expect(json).toMatchObject({ browser: hasChrome(), tools: { readText: null, transcribe: null, speak: 'POPOST_TTS_CMD', generate: null } });
      expect(typeof json.ffmpeg).toBe('string');
      expect(r.code).toBe(hasChrome() ? 0 : 2);
    } finally {
      await withTool.cleanup();
    }
  });

  it('doctor says so where no local program can run, and the command list names the commands', async () => {
    const virtual = createTestRuntime();
    expect((await runCli(virtual, ['video', 'doctor'])).code).toBe(2);
    expect(virtual.json()).toMatchObject({ ok: false, ffmpeg: null, browser: false });
    expect(String((virtual.json().missing as string[])[0])).toContain('cannot run local programs');
    const help = await runCli(virtual, ['video', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('doctor');
    expect(help.stdout).toContain('probe');
  });
});
