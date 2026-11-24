/**
 * The reading commands of `popost video` run through the CLI: measure, text, transcript, describe, compare, draft and
 * synth, each reading its JSON. The text reader and the transcriber are small Node scripts that keep the contract of
 * the tools in skills/popost/tools/video/ (the files they are given and the file they write). Media is synthesized with
 * ffmpeg; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { ffmpegReady } from './read-clips';

const ok = await ffmpegReady();
let rt: DiskRuntime;

/** A text reader: every frame it is given shows "first line" in its first second and "second line" after. */
const OCR = `import { readFileSync, writeFileSync } from 'node:fs';
const [list, out] = process.argv.slice(2);
const frames = JSON.parse(readFileSync(list, 'utf8'));
writeFileSync(out, JSON.stringify(frames.map((f) => ({ frame: f.frame, lines: [{ text: f.frame < 30 ? 'first line' : 'second line', confidence: 0.95, box: [0.2, 0.8, 0.6, 0.08] }] }))));
`;

/** A transcriber: two words, and the language hint it was given (or "en"). */
const ASR = `import { writeFileSync } from 'node:fs';
const [, out, language] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({ language: language || 'en', words: [{ text: 'first', start: 0.1, end: 0.5, confidence: 0.9 }, { text: ' line', start: 1.2, end: 1.6, confidence: 0.8 }] }));
`;

/** A tool that fails the way a broken installation does. */
const BROKEN = `process.stderr.write('loading the model\\nno model file found\\n'); process.exit(3);`;

const withTools = (env: Record<string, string>): DiskRuntime => ({ ...rt, env: { ...rt.env, ...env } });
const json = () => rt.json();
const exists = async (p: string): Promise<boolean> => (await rt.fs.stat(rt.path.resolve(rt.dir, p))) !== null;

describe.skipIf(!ok)('popost video: the reading commands', () => {
  let tools: { ocr: string; asr: string; broken: string };
  beforeAll(async () => {
    rt = await createDiskRuntime();
    const script = async (name: string, body: string): Promise<string> => {
      const file = rt.path.join(rt.dir, name);
      await rt.fs.writeFile(file, body);
      return process.execPath + ' ' + file;
    };
    tools = { ocr: await script('ocr.mjs', OCR), asr: await script('asr.mjs', ASR), broken: await script('broken.mjs', BROKEN) };
    // Two shots joined by a hard cut at frame 30, with a tone under them.
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-f', 'lavfi', '-i', 'smptebars=s=160x284:r=30:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-shortest', rt.path.join(rt.dir, 'two.mp4')]);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rt.path.join(rt.dir, 'silent.mp4')]);
  }, 60_000);
  afterAll(() => rt.cleanup());

  it('measure lists the shots and boundaries without --out, and writes them to the file with it', async () => {
    expect((await runCli(rt, ['video', 'measure', 'two.mp4'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, video: rt.path.join(rt.dir, 'two.mp4'), frames: 60, fps: 30, shots: 2, boundaries: 1 });
    expect(json().listing).toMatchObject({ boundaries: [{ frame: 30, kind: 'cut' }], shots: [{ index: 0, start: 0, end: 30 }, { index: 1, start: 30, end: 60 }] });
    expect((await runCli(rt, ['video', 'measure', 'two.mp4', '--out', 'm/measure.json'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, shots: 2, file: rt.path.join(rt.dir, 'm/measure.json') });
    expect(json().listing).toBeUndefined();
    const written = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'm/measure.json'))) as { shots: unknown[] };
    expect(written.shots).toHaveLength(2);
  });

  it('measure says what is wrong with a missing file, with exit code 2', async () => {
    expect((await runCli(rt, ['video', 'measure', 'nothing.mp4'])).code).toBe(2);
    expect(json()).toMatchObject({ ok: false });
    expect(String(json().error)).toContain('There is no file at');
  });

  it('text reads cues through POPOST_OCR_CMD, keeps and reuses the raw samples, and says how to set up a reader', async () => {
    expect((await runCli(rt, ['video', 'text', 'two.mp4'])).code).toBe(2);
    expect(String(json().error)).toContain('POPOST_OCR_CMD');
    const reading = withTools({ POPOST_OCR_CMD: tools.ocr });
    expect((await runCli(reading, ['video', 'text', 'two.mp4', '--samples', 'samples.json'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, samples: 10, wholeFrames: 10, captionStrips: 0, cues: 2, samplesReused: false });
    expect((json().listing as { cues: Array<{ text: string }> }).cues.map((c) => c.text)).toEqual(['first line', 'second line']);
    // the samples are reused: no reader needed, and the cues land in the file
    expect((await runCli(rt, ['video', 'text', 'two.mp4', '--samples', 'samples.json', '--out', 'text.json'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, cues: 2, samplesReused: true, file: rt.path.join(rt.dir, 'text.json') });
    expect(await exists('text.json')).toBe(true);
  });

  it('transcript hears the words through POPOST_ASR_CMD, passes the language on, and reports a silent video', async () => {
    expect((await runCli(rt, ['video', 'transcript', 'two.mp4'])).code).toBe(2);
    expect(String(json().error)).toContain('POPOST_ASR_CMD');
    const hearing = withTools({ POPOST_ASR_CMD: tools.asr });
    expect((await runCli(hearing, ['video', 'transcript', 'two.mp4', '--language', 'zh'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, sound: true, words: 2, language: 'zh', phrases: 2 });
    expect((json().listing as { phrases: Array<{ text: string; start: number }> }).phrases.map((p) => [p.text, p.start])).toEqual([['first', 3], ['line', 36]]);
    expect((await runCli(hearing, ['video', 'transcript', 'silent.mp4', '--out', 'silent.json'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, sound: false, words: 0 });
    expect(await exists('silent.json')).toBe(false);
  });

  it('a tool that fails is reported with the end of what it printed, exit code 2', async () => {
    expect((await runCli(withTools({ POPOST_ASR_CMD: tools.broken }), ['video', 'transcript', 'two.mp4'])).code).toBe(2);
    expect(json()).toMatchObject({ ok: false, error: 'The transcriber exited with 3: loading the model | no model file found' });
    expect((await runCli(withTools({ POPOST_OCR_CMD: 'popost-no-such-reader' }), ['video', 'text', 'two.mp4'])).code).toBe(2);
    expect(String(json().error)).toMatch(/^The text reader could not be started \(.*\)\. Check POPOST_OCR_CMD\.$/);
  });

  it('describe works without tools and says what it left out; with them it writes the text and the speech too', async () => {
    expect((await runCli(rt, ['video', 'describe', 'two.mp4', '--out', 'plain'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dir: rt.path.join(rt.dir, 'plain'), files: ['REFERENCE.md', 'timeline.md', 'measure.json', 'tracks.json'], shotFiles: 2, sound: true, text: false, speech: false });
    expect((json().leftOut as Array<{ because: string }>).map((x) => x.because)).toEqual(['POPOST_OCR_CMD is not set', 'POPOST_ASR_CMD is not set']);
    for (const f of ['REFERENCE.md', 'timeline.md', 'shots/01.md', 'shots/02.md', 'measure.json']) expect(await exists('plain/' + f), f).toBe(true);
    const full = withTools({ POPOST_OCR_CMD: tools.ocr, POPOST_ASR_CMD: tools.asr });
    expect((await runCli(full, ['video', 'describe', 'two.mp4', '--out', 'full', '--name', 'two shots'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, files: ['REFERENCE.md', 'timeline.md', 'measure.json', 'tracks.json', 'text.json', 'transcript.json'], text: true, speech: true });
    expect(json().leftOut).toBeUndefined();
    expect(await rt.fs.readText(rt.path.join(rt.dir, 'full/REFERENCE.md'))).toContain('# Reference: two shots');
  });

  it('compare scores a measurement against its own video as the same', async () => {
    expect((await runCli(rt, ['video', 'compare', 'plain/measure.json', 'two.mp4'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, composite: 1 });
    expect(Object.keys(json().dimensions as object)).toEqual(['structure', 'transitions', 'camera', 'motion', 'rhythm', 'colour', 'picture']);
  });

  it('draft builds a first project from the measurement, and keeps the footage when asked', async () => {
    expect((await runCli(rt, ['video', 'draft', 'two.mp4', '--out', 'draft'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dir: rt.path.join(rt.dir, 'draft'), segments: 2, notesFile: rt.path.join(rt.dir, 'draft/draft-notes.json') });
    for (const f of ['video.json', 'draft-notes.json', 'assets/shot-01.png', 'assets/shot-02.png']) expect(await exists('draft/' + f), f).toBe(true);
    expect((await runCli(rt, ['video', 'draft', 'two.mp4', '--out', 'kept', '--footage', 'video'])).code).toBe(0);
    expect(json()).toMatchObject({ ok: true, segments: 2, items: 1 });
    expect(await rt.fs.readFile(rt.path.join(rt.dir, 'kept/assets/reference.mp4'))).toEqual(await rt.fs.readFile(rt.path.join(rt.dir, 'two.mp4')));
    expect(await exists('kept/assets/reference.m4a')).toBe(true);
  });

  it('synth writes a random project with its pictures, the same for the same seed', async () => {
    expect((await runCli(rt, ['video', 'synth', '--seed', '3', '--out', 'case'])).code).toBe(0);
    const first = json();
    expect(first).toMatchObject({ ok: true, seed: 3, dir: rt.path.join(rt.dir, 'case') });
    const project = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'case/video.json'))) as { segments: unknown[]; materials: Array<{ file?: string }> };
    expect(project.segments).toHaveLength(first.segments as number);
    for (const m of project.materials) if (m.file) expect(await exists('case/' + m.file), m.file).toBe(true);
    expect((await runCli(rt, ['video', 'synth', '--seed', '3', '--out', 'again'])).code).toBe(0);
    expect(await rt.fs.readText(rt.path.join(rt.dir, 'again/video.json'))).toBe(await rt.fs.readText(rt.path.join(rt.dir, 'case/video.json')));
  });

  it('the command list names the reading commands', async () => {
    const help = await runCli(rt, ['video', '--help']);
    for (const name of ['measure', 'text', 'transcript', 'describe', 'compare', 'draft', 'synth']) expect(help.stdout).toContain(name);
  });
});
