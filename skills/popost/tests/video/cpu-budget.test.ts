/**
 * The video engine keeps to one CPU budget (src/cpu-budget.ts, video/host.ts): ffmpeg's threads, Chrome pages, the
 * threads and copies of a tool, and the parts of describe all derive from it, and the heavy children run at a lower
 * priority. A budget changes how fast the work goes, never what it writes: describe at budget 1 and at budget 4 write
 * the same bytes. The tools are small Node scripts that keep the contract of skills/popost/tools/video/.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodePrograms } from '../../src/node-runtime';
import { chromiumArgs } from '../../src/render/browser';
import type { LocalPrograms } from '../../src/runtime';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { createTestRuntime, runCli } from '../../src/testing/memory';
import { readReference } from '../../src/video/describe/parts';
import { cpuBudgetOf, heavyJobs, mapLimit, partsSideBySide, VideoUnavailableError } from '../../src/video/host';
import { runFfmpegOk, withThreads } from '../../src/video/media/ffmpeg';
import { encodeArgs } from '../../src/video/render/encode';
import { pagesFor } from '../../src/video/render/index';
import { ENCODER_THREADS } from '../../src/video/eval/roundtrip';
import type { Transcriber } from '../../src/video/speech/index';
import type { TextReader } from '../../src/video/text/index';
import { readerSplit } from '../../src/video/text/reader-command';
import { toolEnv } from '../../src/video/tool';
import { ffmpegReady } from './read-clips';

const programs = (parallelism: number): LocalPrograms => ({
  run: () => Promise.resolve({ code: 0, stdout: new Uint8Array(), stderr: '' }),
  tempDir: () => Promise.resolve('/scratch'),
  parallelism,
  parallelismSource: 'cgroup v2 cpu.max: 1.5 processors, rounded up',
});
const at = (env: Record<string, string>, parallelism = 16) => createTestRuntime({ env, programs: programs(parallelism) });

describe('the budget of a runtime', () => {
  it('is POPOST_CPUS in its environment, else what the host reports, and needs one or the other', () => {
    expect(cpuBudgetOf(at({ POPOST_CPUS: '3' }))).toEqual({ cpus: 3, source: 'POPOST_CPUS' });
    expect(cpuBudgetOf(at({}, 2))).toEqual({ cpus: 2, source: 'cgroup v2 cpu.max: 1.5 processors, rounded up' });
    expect(cpuBudgetOf(at({ POPOST_CPUS: 'all' }, 2)).cpus).toBe(2);
    expect(() => cpuBudgetOf(createTestRuntime())).toThrow(VideoUnavailableError);
  });

  it('decides what runs side by side: parts from 4 processors, one heavy job per 2', () => {
    expect([1, 2, 3, 4, 8].map((n) => partsSideBySide(at({}, n)))).toEqual([false, false, false, true, true]);
    expect([1, 2, 3, 4, 8, 16].map((n) => heavyJobs(at({}, n)))).toEqual([1, 1, 1, 2, 4, 8]);
  });

  it('gives a render one page below 8 processors and a page per 4 above, up to 4', () => {
    const big = { frames: 600, width: 1080, height: 1920 };
    expect([1, 2, 4, 7, 8, 12, 16, 64].map((n) => pagesFor(at({ POPOST_CPUS: String(n) }), big))).toEqual([1, 1, 1, 1, 2, 3, 4, 4]);
    // Asked for in so many words, the pages are the user's choice.
    expect(pagesFor(at({ POPOST_CPUS: '1', POPOST_RENDER_PAGES: '3' }), big)).toBe(3);
  });

  it('gives a tool the budget as its threads, at most 4, unless the user set them', () => {
    expect(toolEnv(at({ POPOST_CPUS: '1' }))).toEqual({ POPOST_TOOL_THREADS: '1' });
    expect(toolEnv(at({ POPOST_CPUS: '16' }))).toEqual({ POPOST_TOOL_THREADS: '4' });
    expect(toolEnv(at({ POPOST_CPUS: '16' }), 2)).toEqual({ POPOST_TOOL_THREADS: '2' });
    expect(toolEnv(at({ POPOST_CPUS: '2', POPOST_TOOL_THREADS: '6' }))).toEqual({ POPOST_TOOL_THREADS: '6' });
  });

  it('keeps reader copies times threads within the budget', () => {
    const split = (env: Record<string, string>, frames = 150) => readerSplit(at(env), frames);
    expect(split({ POPOST_CPUS: '16' })).toEqual({ processes: 1, threads: 4 });
    expect(split({ POPOST_CPUS: '16', POPOST_OCR_JOBS: '4' })).toEqual({ processes: 4, threads: 4 });
    expect(split({ POPOST_CPUS: '2', POPOST_OCR_JOBS: '4' })).toEqual({ processes: 2, threads: 1 });
    expect(split({ POPOST_CPUS: '6', POPOST_OCR_JOBS: '4' })).toEqual({ processes: 4, threads: 1 });
    expect(split({ POPOST_CPUS: '8', POPOST_OCR_JOBS: '4', POPOST_TOOL_THREADS: '4' })).toEqual({ processes: 2, threads: 4 });
    expect(split({ POPOST_CPUS: '2', POPOST_TOOL_THREADS: '8' })).toEqual({ processes: 1, threads: 8 });
    expect(split({ POPOST_CPUS: '16', POPOST_OCR_JOBS: '4' }, 10)).toEqual({ processes: 2, threads: 4 });
  });
});

describe('Chrome raster threads from the budget', () => {
  it('gives the frames profile 1 to 4 raster threads, and leaves the other profiles alone', () => {
    const raster = (args: string[]) => args.filter((a) => a.startsWith('--num-raster-threads'));
    expect(raster(chromiumArgs('frames', { rasterThreads: 1 }))).toEqual(['--num-raster-threads=1']);
    expect(raster(chromiumArgs('frames', { rasterThreads: 3 }))).toEqual(['--num-raster-threads=3']);
    expect(raster(chromiumArgs('frames', { rasterThreads: 16 }))).toEqual(['--num-raster-threads=4']);
    expect(raster(chromiumArgs('frames', { rasterThreads: 0 }))).toEqual(['--num-raster-threads=1']);
    expect(raster(chromiumArgs('frames'))).toEqual([]);
    expect(raster(chromiumArgs('pages', { rasterThreads: 2 }))).toEqual([]);
    expect(raster(chromiumArgs('web', { rasterThreads: 2 }))).toEqual([]);
  });
});

describe('ffmpeg threads from the budget', () => {
  it('sets the threads of every input, of the output and of the filters, once', () => {
    expect(withThreads(['-version'], 2)).toEqual(['-version']);
    expect(withThreads(['-y', '-i', 'a.mp4', '-vf', 'scale=90:-2', 'b.mp4'], 2))
      .toEqual(['-filter_threads', '2', '-filter_complex_threads', '2', '-y', '-threads', '2', '-i', 'a.mp4', '-vf', 'scale=90:-2', '-threads', '2', 'b.mp4']);
    expect(withThreads(['-i', 'a.wav', '-i', 'b.wav', '-filter_complex', 'amix', 'c.m4a'], 1))
      .toEqual(['-filter_threads', '1', '-filter_complex_threads', '1', '-threads', '1', '-i', 'a.wav', '-threads', '1', '-i', 'b.wav', '-filter_complex', 'amix', '-threads', '1', 'c.m4a']);
  });

  it('leaves a run that only describes its input without an output, and the caller\'s own threads alone', () => {
    expect(withThreads(['-i', 'a.mp4'], 3)).toEqual(['-filter_threads', '3', '-filter_complex_threads', '3', '-threads', '3', '-i', 'a.mp4']);
    expect(withThreads(['-threads', '1', '-i', 'a.mp4', 'b.mp4'], 3)).toEqual(['-filter_threads', '3', '-filter_complex_threads', '3', '-threads', '1', '-i', 'a.mp4', 'b.mp4']);
  });

  it('keeps a render\'s fixed encoder threads whatever the budget (the round trip\'s scores do not move with it)', () => {
    const job: Parameters<typeof encodeArgs>[0] = { out: 'o.mp4', fps: 30, from: 0, to: 30, image: 'png', crf: 18, audio: [{ id: 'a', src: '/a.wav', start: 0, end: 30, gain: 1 }] };
    const fixed = (budget: number): string[] => withThreads(encodeArgs({ ...job, threads: ENCODER_THREADS }), budget);
    expect(fixed(1).slice(4)).toEqual(fixed(8).slice(4));
    const args = fixed(2);
    expect(args.filter((a, i) => a === '-threads' && args[i + 1] !== String(ENCODER_THREADS))).toEqual([]);
    expect(args.slice(-3)).toEqual(['-threads', String(ENCODER_THREADS), 'o.mp4']);
    expect(args.filter((a) => a === '-i').length).toBe(args.filter((a) => a === '-threads').length - 1);
    // Without it, the budget's.
    expect(withThreads(encodeArgs(job), 2).slice(-3)).toEqual(['-threads', '2', 'o.mp4']);
  });
});

describe('side by side, a few at a time', () => {
  it('never runs more than the limit at once, keeps the order, and starts nothing after a failure', async () => {
    let now = 0, most = 0;
    const seen: number[] = [];
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, x * 3));
      now--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
    await expect(mapLimit([1, 2, 3, 4], 1, async (x) => {
      seen.push(x);
      if (x === 2) throw new Error('two');
      return x;
    })).rejects.toThrow('two');
    expect(seen).toEqual([1, 2]);
  });
});

describe.skipIf(process.platform === 'win32')('heavy children run lower', () => {
  const niceness = async (lowPriority: boolean): Promise<number> => {
    const result = await nodePrograms.run([process.execPath, '-p', 'require("node:os").getPriority(0)'], { lowPriority });
    expect(result.code).toBe(0);
    return Number(new TextDecoder().decode(result.stdout).trim());
  };

  it('starts a low-priority program through nice, with the variables it is given', async () => {
    const base = await niceness(false);
    expect(await niceness(true)).toBe(Math.min(19, base + 10));
    const r = await nodePrograms.run(['sh', '-c', 'printf %s "$POPOST_TEST_VARIABLE"'], { env: { POPOST_TEST_VARIABLE: 'set' }, lowPriority: true });
    expect(new TextDecoder().decode(r.stdout)).toBe('set');
  });

  it('still fails to start a program that is not there, as it would without nice', async () => {
    await expect(nodePrograms.run(['popost-no-such-program'], { lowPriority: true })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const ok = await ffmpegReady();

describe.skipIf(!ok)('describe under a budget', () => {
  let rt: DiskRuntime;
  let tools: { ocr: string; asr: string };
  const threadsFile = (): string => rt.path.join(rt.dir, 'threads.txt');
  beforeAll(async () => {
    rt = await createDiskRuntime();
    const script = async (name: string, body: string): Promise<string> => {
      const f = rt.path.join(rt.dir, name);
      await rt.fs.writeFile(f, body);
      return process.execPath + ' ' + f;
    };
    // The reader writes down the threads it was given; the files it writes do not depend on them.
    tools = {
      ocr: await script('ocr.mjs', `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [list, out] = process.argv.slice(2);
appendFileSync(${JSON.stringify(threadsFile())}, (process.env.POPOST_TOOL_THREADS ?? '') + '\\n');
const frames = JSON.parse(readFileSync(list, 'utf8'));
writeFileSync(out, JSON.stringify(frames.map((f) => ({ frame: f.frame, lines: [{ text: f.frame < 30 ? 'first line' : 'second line', confidence: 0.95, box: [0.2, 0.8, 0.6, 0.08] }] }))));
`),
      asr: await script('asr.mjs', `import { writeFileSync } from 'node:fs';
const [, out, language] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({ language: language || 'en', words: [{ text: 'first', start: 0.1, end: 0.5, confidence: 0.9 }, { text: ' line', start: 1.2, end: 1.6, confidence: 0.8 }] }));
`),
    };
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-shortest', rt.path.join(rt.dir, 'two.mp4')]);
  }, 60_000);
  afterAll(() => rt.cleanup());

  /** Every file under dir, by its path below dir, with its bytes. */
  const filesUnder = async (dir: string, below = ''): Promise<Record<string, string>> => {
    const entries = await Promise.all((await rt.fs.readdir(rt.path.join(dir, below))).map(async (name) => {
      const rel = below ? below + '/' + name : name;
      const s = await rt.fs.stat(rt.path.join(dir, rel));
      return s?.isDirectory ? filesUnder(dir, rel) : { [rel]: Buffer.from(await rt.fs.readFile(rt.path.join(dir, rel))).toString('base64') };
    }));
    return Object.assign({}, ...entries) as Record<string, string>;
  };

  it('writes the same bytes at budget 1 and at budget 4, and gives the reader the budget as its threads', async () => {
    const written: Record<string, Record<string, string>> = {};
    for (const cpus of ['1', '4']) {
      const at = { ...rt, env: { ...rt.env, POPOST_CPUS: cpus, POPOST_OCR_CMD: tools.ocr, POPOST_ASR_CMD: tools.asr } };
      expect((await runCli(at, ['video', 'describe', 'two.mp4', '--out', 'budget-' + cpus, '--name', 'two shots'])).code).toBe(0);
      expect(rt.json()).toMatchObject({ ok: true, text: true, speech: true });
      written[cpus] = await filesUnder(rt.path.join(rt.dir, 'budget-' + cpus));
    }
    // The pictures too (two shots joined by a cut: no transition picture), byte for byte.
    expect(Object.keys(written['1'] ?? {}).sort()).toEqual(['REFERENCE.md', 'measure.json', 'opening.jpg', 'shots/01-frames.jpg', 'shots/01.md', 'shots/02-frames.jpg', 'shots/02.md', 'text.json', 'timeline.md', 'tracks.json', 'transcript.json']);
    expect(written['1']).toEqual(written['4']);
    expect((await rt.fs.readText(threadsFile())).trim().split('\n')).toEqual(['1', '4']);
  }, 60_000);

  it('runs the parts one after another below 4 processors, and the progress line says which one works', async () => {
    const spans: Record<string, [number, number]> = {};
    const slow = async <T>(name: string, value: T): Promise<T> => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 400));
      spans[name] = [start, Date.now()];
      return value;
    };
    const reader: TextReader = { read: (frames) => slow('reader', frames.map((f) => ({ frame: f.frame, lines: [] }))) };
    const transcriber: Transcriber = { transcribe: () => slow('transcriber', { language: 'en', words: [] }) };
    const lines: string[] = [];
    const small = { ...rt, env: { ...rt.env, POPOST_CPUS: '2' } };
    const r = await readReference(small, rt.path.join(rt.dir, 'two.mp4'), { reader, transcriber, progress: { write: (l) => lines.push(l), everyMs: 100 } });
    expect(r.measure.source.frames).toBe(60);
    const [a, b] = [spans.reader, spans.transcriber];
    expect(a && b && a[1] <= b[0]).toBe(true);
    expect(lines.every((l) => l.startsWith('describe (one part at a time, CPU budget 2), '))).toBe(true);
    expect(lines.some((l) => /text: the reader is reading \d+ frames .*; speech: waiting its turn/.test(l))).toBe(true);
  }, 30_000);

  it('doctor prints the budget and where it came from', async () => {
    expect((await runCli({ ...rt, env: { ...rt.env, POPOST_CPUS: '3' } }, ['video', 'doctor'])).code).toBeLessThanOrEqual(2);
    expect(rt.json().cpus).toEqual({ budget: 3, from: 'POPOST_CPUS' });
    await runCli(rt, ['video', 'doctor']);
    expect(rt.json().cpus).toMatchObject({ budget: nodePrograms.parallelism });
  }, 30_000);
});
