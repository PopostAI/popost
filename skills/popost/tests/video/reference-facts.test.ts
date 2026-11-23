/**
 * A project knows its reference: template fill writes a record of its template into the project
 * (reference.facts.json), and the checks compare the project with it. describe measures how much of each reference
 * shot is not ground with the scene check's own function; the record round-trips from a described reference; the
 * scene check holds a scene's emptiness to its reference shot; video check holds the captions to the reference's size;
 * the record is never a source. With the record, the scene check also reports the reference's own words and numbers. Synthetic media and scenes only.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { fillOfPng, fillOfRgb } from '../../src/video/measure/fill';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { checkScenes } from '../../src/video/scene/check';
import { repeatsOf, type ReferenceLine } from '../../src/video/scene/copied';
import { projectTexts, untraced, valuesIn } from '../../src/video/scene/numbers';
import { FACTS_FILE, type ReferenceFacts } from '../../src/video/template/facts';
import type { Measure, Project } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);
const chrome = hasChrome();
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);
const put = async (file: string, text: string): Promise<void> => { await mkdir(path.dirname(at(file)), { recursive: true }); await writeFile(at(file), text); };
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(at(file), 'utf8')) as T;

/** The reference: three shots of two seconds joined by cuts, a flat colour, white boxes on grey, and a busy test picture. */
let made: Promise<unknown> | undefined;
const reference = (): Promise<unknown> => (made ??= runFfmpegOk(rt, ['-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=0x1d3557:s=640x360:r=30:d=2',
  '-f', 'lavfi', '-i', 'color=c=0x808890:s=640x360:r=30:d=2,drawbox=x=60:y=60:w=220:h=240:color=white:t=fill,drawbox=x=360:y=80:w=220:h=90:color=0x202020:t=fill,drawbox=x=360:y=200:w=220:h=90:color=0xe76f51:t=fill',
  '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', at('ref.mp4')]));

describe('the reference\'s content in a new video (no browser)', () => {
  const lines: ReferenceLine[] = [
    { shot: 0, text: 'Track every habit in one place' },
    { shot: 1, text: '2.3k stars on GitHub' },
    { shot: 2, text: '一键同步所有设备的数据' },
    { shot: 3, text: 'Acme Notes' },
    { shot: 3, text: 'Acme Cloud Notes' },
  ];
  const sources = ['Acme Cloud Notes keeps notes for teams. Acme Notes has 12,000 users.'];
  const repeats = repeatsOf(lines, sources, valuesIn(sources));
  const figures = (text: string): string[] => repeats.figures(untraced([text], valuesIn(sources))).map((r) => r.shown + ' @' + r.line.shot);
  const phrases = (text: string): string[] => repeats.phrases(text).map((r) => r.shown + ' @' + r.line.shot);

  it('finds a figure the reference showed, written another way, and leaves out one a source holds', () => {
    expect(figures('Loved by 2.3K developers')).toEqual(['2.3K @1']);
    expect(figures('Over 2,300 stars')).toEqual([]);
    expect(figures('12,000 users')).toEqual([]);
    const saved = [...sources, 'From the project page: 2,300 stars.'];
    expect(repeatsOf(lines, saved, valuesIn(saved)).figures(untraced(['Loved by 2.3K developers'], valuesIn(saved)))).toEqual([]);
  });

  it('finds a phrase of the reference repeated word for word, ignoring case, punctuation and very common words', () => {
    expect(phrases('Track every habit, in ONE place!')).toEqual(['Track every habit, in ONE place @0']);
    expect(phrases('现在一键同步所有设备的数据吧')).toEqual(['一键同步所有设备的数据 @2']);
    expect(phrases('Track your habits in one app')).toEqual([]);
    expect(phrases('一键同步')).toEqual([]);
  });

  it('leaves out a name the sources share with the reference, and a short one', () => {
    expect(phrases('Try Acme Cloud Notes free')).toEqual([]);
    expect(phrases('Acme Notes for teams')).toEqual([]);
  });
});

describe.skipIf(!ffmpeg)('describe and the scene check measure the empty share alike', () => {
  it('gives the same share for the same picture as RGB bytes and as a PNG', async () => {
    const W = 340, H = 192;
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const card = x >= 80 && x < 260 && y >= 50 && y < 140;
      rgb.set(card ? [250, 250, 250] : [20 + Math.round((y / H) * 40), 30, 70], (y * W + x) * 3);
    }
    const png = (await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', W + 'x' + H, '-i', 'pipe:0', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], Buffer.from(rgb))).stdout;
    const a = fillOfRgb(W, H, rgb) ?? -1, b = fillOfPng(new Uint8Array(png)) ?? -1;
    expect(a).toBeGreaterThan(0.2);
    expect(Math.abs(a - b)).toBeLessThan(0.005);
  });

  it('describe writes how much of each shot\'s middle picture is not ground into measure.json', async () => {
    await reference();
    expect((await runCli(rt, ['video', 'describe', 'ref.mp4', '--out', 'plain'])).code).toBe(0);
    const fills = (await readJson<Measure>('plain/measure.json')).shots.map((s) => s.fill ?? -1);
    console.log('reference shots, share not ground: ' + fills.join(', '));
    expect(fills).toHaveLength(3);
    expect(fills[0]).toBeLessThan(0.02);
    expect(fills[1]).toBeGreaterThan(0.2);
    expect(fills[2]).toBeGreaterThan(0.2);
  });
});

describe('the record is no source', () => {
  it('never reads the record or a directory written from the reference as a source of numbers', async () => {
    await put('texts/video.json', '{}');
    await put('texts/source/notes.md', 'Acme Notes has 12,000 users.');
    await put('texts/' + FACTS_FILE, '{"shots": [{"text": ["2.3k stars on GitHub"]}]}');
    await put('texts/ref/REFERENCE.md', '# Reference');
    await put('texts/ref/measure.json', '{}');
    await put('texts/ref/timeline.md', '2.3k stars on GitHub');
    await put('texts/template/template.json', '{}');
    await put('texts/template/slots.json', '{}');
    await put('texts/template/TEMPLATE.md', '2.3k stars on GitHub');
    await put('texts/template/reference-text.json', '{"shots": [["2.3k stars on GitHub"]]}');
    expect((await projectTexts(rt, at('texts'))).map((f) => f.file)).toEqual(['source/notes.md']);
  });
});

/** A text reader: a caption line in the bottom band every second for five seconds, and a label with a figure over the second shot. */
const OCR = `import { readFileSync, writeFileSync } from 'node:fs';
const [list, out] = process.argv.slice(2);
const CAPTIONS = ['Track every habit in one place', 'Never miss a day again', 'Loved by our whole team', 'Start your streak today', 'Download it now'];
const lines = (f) => [
  ...(f < 150 ? [{ text: CAPTIONS[Math.floor(f / 30)], confidence: 0.95, box: [0.15, 0.82, 0.7, 0.07] }] : []),
  ...(f >= 60 && f < 120 ? [{ text: '2.3k stars on GitHub', confidence: 0.95, box: [0.3, 0.1, 0.4, 0.08] }] : []),
];
writeFileSync(out, JSON.stringify(JSON.parse(readFileSync(list, 'utf8')).map((f) => ({ frame: f.frame, lines: lines(f.frame) }))));
`;

describe.skipIf(!ffmpeg)('the record round-trips: describe, template save, template fill', () => {
  let facts: ReferenceFacts;
  beforeAll(async () => {
    await reference();
    await put('ocr.mjs', OCR);
    const reading = { ...rt, env: { ...rt.env, POPOST_OCR_CMD: process.execPath + ' ' + at('ocr.mjs') } };
    expect((await runCli(reading, ['video', 'describe', 'ref.mp4', '--out', 'ref'])).code).toBe(0);
    expect((await runCli(rt, ['video', 'template', 'save', 'ref', '--out', 'tpl', '--name', 'habits'])).code).toBe(0);
    const slots = await readJson<{ captions?: { lines: unknown[] } }>('tpl/slots.json');
    await put('fill.json', JSON.stringify({ shots: [{ color: '#1d3557' }, { color: '#f4a261' }, { color: '#2a9d8f' }], captions: (slots.captions?.lines ?? []).map(() => 'A new line') }));
    const filled = await runCli(rt, ['video', 'template', 'fill', 'tpl', '--fill', 'fill.json', '--out', 'project']);
    expect(filled.code, JSON.stringify(rt.json())).toBe(0);
    expect(rt.json().written).toEqual(['video.json', 'reference.measure.json', FACTS_FILE]);
    facts = await readJson<ReferenceFacts>('project/' + FACTS_FILE);
  }, 120_000);

  it('keeps the template, the shots with their facts and the reference\'s text by shot', () => {
    console.log(JSON.stringify(facts, null, 1));
    expect(facts).toMatchObject({ format: 'popost-video-reference-facts', version: 1, template: { dir: '../tpl', name: 'habits' }, canvas: { width: 640, height: 360, fps: 30 } });
    expect(facts.shots.map((s) => [s.index, s.segment, s.frames, [...(s.text ?? [])].sort()])).toEqual([
      [0, 'shot-01', 60, ['Never miss a day again', 'Track every habit in one place']],
      [1, 'shot-02', 60, ['2.3k stars on GitHub', 'Loved by our whole team', 'Start your streak today']],
      [2, 'shot-03', 60, ['Download it now']],
    ]);
    expect(facts.shots.map((s) => typeof s.fill)).toEqual(['number', 'number', 'number']);
    expect(facts.captions?.style.size).toBeGreaterThan(0);
  });

  it('video check holds a hand edit of the captions to the reference\'s size, and only with the record', async () => {
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    expect(JSON.stringify(rt.json().problems)).not.toContain('times smaller');
    const project = await readJson<Project>('project/video.json');
    const captions = project.tracks.find((t) => t.type === 'caption');
    if (!captions || typeof captions.style !== 'object') throw new Error('template fill wrote no caption style');
    captions.style = { ...captions.style, size: (captions.style.size ?? 0) / 2 };
    await put('project/video.json', JSON.stringify(project));
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    const warned = (rt.json().problems as { at: string; message: string }[]).filter((p) => p.message.includes('times smaller'));
    console.log(JSON.stringify(warned, null, 1));
    expect(warned.map((p) => p.at)).toEqual(['tracks[' + project.tracks.indexOf(captions) + '].style.size']);
    expect(warned[0]?.message).toContain('2.0 times smaller than the reference\'s');
    await rm(at('project', FACTS_FILE));
    expect((await runCli(rt, ['video', 'check', 'project'])).code).toBe(0);
    expect(JSON.stringify(rt.json().problems)).not.toContain('times smaller');
  });
});

const W = 640, H = 360;
const page = (body: string): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden;background:linear-gradient(160deg,#1b2350,#090b18);font-family:sans-serif}'
  + '.t{position:absolute;left:40px;font:700 30px sans-serif;color:#fff}</style></head><body>' + body + '</body></html>';
const SCENES: Record<string, string> = {
  'scenes/copied.html': page('<div class="t" style="top:60px">Track every habit in one place</div><div class="t" style="top:160px">2.3k stars on GitHub</div>'),
  'scenes/own.html': page('<div class="t" style="top:60px">Acme Notes</div><div class="t" style="top:160px">12,000 users</div>'),
  'scenes/sparse.html': page('<div class="t" style="top:150px;font-size:18px">Acme Notes, for teams</div>'),
};
const seg = (id: string, scene: string): Project['segments'][number] => ({ id, frames: 30, base: { scene } });
const PROJECT: Project = {
  version: 1, canvas: { width: W, height: H, fps: 30 }, materials: [],
  segments: [seg('shot-01', 'scenes/copied.html'), seg('shot-02', 'scenes/own.html'), seg('shot-03', 'scenes/sparse.html')],
  tracks: [{ id: 'subs', type: 'caption', box: [0.05, 0.85, 0.9, 0.1], cues: [{ text: 'Over 2.3k stars already', during: { segment: 'shot-02', from: 0, to: 30 } }] }],
};
const shotFacts = (index: number, fill: number, text: string[]) => ({ index, segment: 'shot-0' + (index + 1), frames: 30, source: 'picture' as const, fill, text });
/** The record of a reference whose shots were a little fuller than the first two scenes and far fuller than the third, and its text. */
const FACTS: ReferenceFacts = {
  format: 'popost-video-reference-facts', version: 1, template: { dir: '../template', name: 'habits', label: 'habits', measure: 'sha256:0000000000000000' },
  canvas: { width: W, height: H, fps: 30 },
  shots: [shotFacts(0, 0.08, ['Track every habit in one place']), shotFacts(1, 0.08, ['2.3k stars on GitHub', 'Acme Notes']), shotFacts(2, 0.45, ['Your week at a glance'])],
};

describe.skipIf(!ffmpeg || !chrome)('scene check with the record of the reference', () => {
  const dir = at('scenes-project');
  const said = (problems: { at: string; message: string }[], where: string): string => problems.filter((p) => p.at === where).map((p) => p.message).join('\n');
  beforeAll(async () => {
    await put('scenes-project/video.json', JSON.stringify(PROJECT));
    for (const [file, html] of Object.entries(SCENES)) await put('scenes-project/' + file, html);
    await put('scenes-project/source/notes.md', 'Acme Notes has 12,000 users.\n');
  });

  it('reports the reference\'s words and numbers, and a scene far emptier than its shot, with both shares', async () => {
    await put('scenes-project/' + FACTS_FILE, JSON.stringify(FACTS));
    const r = await checkScenes(rt, dir);
    console.log(JSON.stringify(r.problems, null, 1));
    expect(r.problems.every((p) => p.level === 'warning')).toBe(true);
    const copied = said(r.problems, 'segments[0].base.scene');
    expect(copied).toContain('Segment "shot-01" ("scenes/copied.html") shows what the reference showed: "2.3k" (the reference\'s shot 2: "2.3k stars on GitHub"), "Track every habit in one place" (the reference\'s shot 1: "Track every habit in one place")');
    expect(copied).toContain('this is the reference\'s content; show what the sources of this video say.');
    // Reported as the reference's, not again as a number no file holds; the record that holds it is no source.
    expect(copied).not.toContain('found in no file');
    expect(said(r.problems, 'segments[1].base.scene')).toBe('');
    expect(said(r.problems, 'tracks[0].cues[0].text')).toBe('The caption "Over 2.3k stars already" (segment "shot-02") shows what the reference showed: "2.3k" (the reference\'s shot 2: "2.3k stars on GitHub"): this is the reference\'s content; show what the sources of this video say.');
    expect(said(r.problems, 'segments[2].base.scene')).toMatch(/^Half-way through segment "shot-03" \("scenes\/sparse.html"\) [\d.]+% of the picture stands out from its ground; in the middle of the reference's shot 3, which it re-creates, 45% did: the scene is far emptier than its shot/);
    expect(r.scenes.map((s) => s.referenceFill)).toEqual([0.08, 0.08, 0.45]);
  });

  it('without the record: the fixed floor for emptiness, and the number check as before', async () => {
    await rm(path.join(dir, FACTS_FILE));
    const r = await checkScenes(rt, dir);
    expect(r.problems.every((p) => p.level === 'warning')).toBe(true);
    expect(JSON.stringify(r.problems)).not.toContain('reference');
    expect(said(r.problems, 'segments[0].base.scene')).toMatch(/^The numbers shown in segment "shot-01" \("scenes\/copied.html"\) are found in no file of the project: 2\.3k /);
    expect(said(r.problems, 'tracks[0].cues[0].text')).toBe('The caption "Over 2.3k stars already" (segment "shot-02") shows numbers found in no file of the project: 2.3k.');
    expect(said(r.problems, 'segments[2].base.scene')).toBe('');
    expect(r.scenes.map((s) => s.referenceFill)).toEqual([undefined, undefined, undefined]);
  });
});
