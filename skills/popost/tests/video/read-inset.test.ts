/**
 * The frame around the content (describe/inset.ts) on clips made with ffmpeg: four shots inside a constant decorated
 * frame (a ground, a border, a strip along the top), the same shots full frame, the same shots letterboxed (16:9 in
 * 4:3), and a clip where only the first shot has the frame. Then describe and the template card say it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { findInset, insetSamples, insetText, type Inset } from '../../src/video/describe/inset';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { templateCard } from '../../src/video/template/card';
import { slotsOf } from '../../src/video/template/slots';
import { templateFrom } from '../../src/video/template/structure';
import type { TextCue, TextTrack } from '../../src/video/text/types';
import type { Template } from '../../src/video/template/types';
import type { Box, Measure } from '../../src/video/types';
import { ffmpegReady } from './read-clips';

const ok = await ffmpegReady();
let rt: DiskRuntime;

const SOURCES = ['testsrc', 'mandelbrot', 'smptehdbars', 'testsrc2'];
const FRAMES = 45;
/** The framed clip: 640x360, the content in [80, 40, 480, 280]. */
const BOX = [80, 40, 480, 280];

type Shot = 'framed' | 'full' | 'letterbox' | 'designed' | 'captioned';

/** Captioned: letterboxed, a new caption line every shot on the black below the picture, a still title on the black above. */
const CAPTION_WIDTHS = [180, 260, 340, 220];
const captionBox = (k: number): Box => {
  const w = CAPTION_WIDTHS[k % CAPTION_WIDTHS.length] as number;
  return [320 - w / 2, 436, w, 26];
};
const TITLE: Box = [260, 22, 120, 14];
const drawn = (b: Box): string => 'drawbox=x=' + b[0] + ':y=' + b[1] + ':w=' + b[2] + ':h=' + b[3] + ':color=white:t=fill';

/** Designed shots on one plain ground: a picture of another size in another place in each. */
const PATCHES = [[40, 40, 320, 220], [280, 100, 320, 220], [160, 20, 280, 300], [60, 150, 520, 180]];

/** One shot's chain from input k: the content source, framed, full frame or letterboxed. */
const chain = (shot: Shot, k: number): { inputs: string[]; filter: string } => {
  const src = SOURCES[k % SOURCES.length] as string;
  const cut = 'trim=end_frame=' + FRAMES + ',setpts=N/30/TB';
  if (shot === 'full') return { inputs: ['-f', 'lavfi', '-i', src + '=s=640x360:r=30'], filter: '[IN0]' + cut + ',format=yuv420p[OUT]' };
  if (shot === 'designed') {
    const [x, y, w, h] = PATCHES[k % PATCHES.length] as number[];
    return { inputs: ['-f', 'lavfi', '-i', 'color=c=0x1d2b53:s=640x360:r=30', '-f', 'lavfi', '-i', src + '=s=' + w + 'x' + h + ':r=30'], filter: '[IN1]' + cut + '[C];[IN0]' + cut + '[G];[G][C]overlay=' + x + ':' + y + ',format=yuv420p[OUT]' };
  }
  if (shot === 'captioned') return { inputs: ['-f', 'lavfi', '-i', src + '=s=640x360:r=30'], filter: '[IN0]' + cut + ',pad=640:480:0:60:black,' + drawn(captionBox(k)) + ',' + drawn(TITLE) + ',format=yuv420p[OUT]' };
  if (shot === 'letterbox') return { inputs: ['-f', 'lavfi', '-i', src + '=s=640x360:r=30'], filter: '[IN0]' + cut + ',pad=640:480:0:60:black,format=yuv420p[OUT]' };
  return {
    inputs: ['-f', 'lavfi', '-i', 'color=c=0xe8dcc4:s=640x360:r=30', '-f', 'lavfi', '-i', src + '=s=480x280:r=30'],
    filter: '[IN1]' + cut + '[C];[IN0]' + cut + '[G];[G][C]overlay=' + BOX[0] + ':' + BOX[1] + ',drawbox=x=74:y=34:w=492:h=292:color=0xa0302a:t=6,drawbox=x=0:y=0:w=640:h=14:color=0x2a4d69:t=fill,format=yuv420p[OUT]',
  };
};

/** Shots joined by hard cuts into one clip. */
const clip = async (name: string, shots: Shot[]): Promise<string> => {
  const out = rt.path.join(rt.dir, name);
  const inputs: string[] = [];
  const filters: string[] = [];
  shots.forEach((shot, k) => {
    const c = chain(shot, k);
    const first = inputs.length / 4;
    inputs.push(...c.inputs);
    filters.push(c.filter.replace(/\[IN(\d)\]/g, (_m, i: string) => '[' + (first + Number(i)) + ':v]').replace(/\[(C|G)\]/g, (_m, x: string) => '[' + x + k + ']').replace('[OUT]', '[s' + k + ']'));
  });
  filters.push(shots.map((_s, k) => '[s' + k + ']').join('') + 'concat=n=' + shots.length + ':v=1:a=0[v]');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out]);
  return out;
};

const read = async (file: string, text?: TextTrack): Promise<{ m: Measure; inset: Inset | undefined }> => {
  const m = await measureVideo(rt, file);
  return { m, inset: findInset(await insetSamples(rt, file), m, text) };
};

/** A cue as the reader would leave it, its box in canvas pixels of the 640x480 clips. */
const cue = (text: string, role: TextCue['role'], start: number, end: number, b: Box): TextCue =>
  ({ text, role, start, end, box: [b[0] / 640, b[1] / 480, b[2] / 640, b[3] / 480], size: b[3] / 480, samples: 3, confidence: 0.9 });
const captionedText: TextTrack = {
  step: 15, sampled: 12,
  cues: [...CAPTION_WIDTHS.map((_w, k) => cue('line ' + (k + 1), 'caption', k * FRAMES, (k + 1) * FRAMES, captionBox(k))), cue('brand', 'watermark', 0, 4 * FRAMES, TITLE)],
};

describe.skipIf(!ok)('describe: a constant frame around the content', () => {
  const clips: Record<string, string> = {};
  beforeAll(async () => {
    rt = await createDiskRuntime();
    clips.framed = await clip('framed.mp4', ['framed', 'framed', 'framed', 'framed']);
    clips.full = await clip('full.mp4', ['full', 'full', 'full', 'full']);
    clips.letterbox = await clip('letterbox.mp4', ['letterbox', 'letterbox', 'letterbox', 'letterbox']);
    clips.once = await clip('once.mp4', ['framed', 'full', 'full', 'full']);
    clips.designed = await clip('designed.mp4', ['designed', 'designed', 'designed', 'designed']);
    clips.captioned = await clip('captioned.mp4', ['captioned', 'captioned', 'captioned', 'captioned']);
  }, 120_000);
  afterAll(() => rt.cleanup());

  it('finds a decorated frame that every shot shows, and the box of the content within a few pixels', async () => {
    const { m, inset } = await read(clips.framed as string);
    expect(m.shots).toHaveLength(4);
    expect(inset).toMatchObject({ kind: 'frame', shots: 4, of: 4 });
    inset?.pixels.forEach((v, i) => expect(Math.abs(v - (BOX[i] as number)), 'box[' + i + '] ' + v).toBeLessThanOrEqual(4));
    // The ground, the strip along the top and the border, the ground first.
    expect(inset?.colours[0]?.hex).toMatch(/^#e[5-9a-c]d[8-9a-f]c[0-9a-f]$/);
    expect(inset?.colours.length).toBe(3);
  });

  it('finds nothing when the same shots fill the frame', async () => {
    const { m, inset } = await read(clips.full as string);
    expect(m.shots).toHaveLength(4);
    expect(inset).toBeUndefined();
  });

  it('calls letterbox bars black bars, with the box of the picture', async () => {
    const { inset } = await read(clips.letterbox as string);
    expect(inset).toMatchObject({ kind: 'bars', shots: 4, of: 4 });
    [0, 60, 640, 360].forEach((v, i) => expect(Math.abs((inset?.pixels[i] ?? -99) - v), 'box[' + i + ']').toBeLessThanOrEqual(4));
  });

  it('finds the bars when a new caption every shot sits on the black below the picture, given the lines the reader read', async () => {
    // Without the reader's lines, the white caption pixels count as the ground's, and a ground that is not black is no bars.
    expect((await read(clips.captioned as string)).inset).not.toMatchObject({ kind: 'bars' });
    const { inset } = await read(clips.captioned as string, captionedText);
    expect(inset).toMatchObject({ kind: 'bars', shots: 4, of: 4, captions: 'below', constantText: 1 });
    [0, 60, 640, 360].forEach((v, i) => expect(Math.abs((inset?.pixels[i] ?? -99) - v), 'box[' + i + ']').toBeLessThanOrEqual(4));
    const said = insetText(inset as Inset, 4);
    expect(said).toContain('black around it; the captions sit on the black below it.');
    expect(said).toContain('Text that stays all through sits on the bars too (a watermark in text.json): the scene draws it.');
    expect(said).toContain('filling the canvas would put the captions over the picture.');
    expect(said).toContain('video-scenes.md, "Footage inside a scene"');
  });

  it('puts the caption band beside the bars line in the template card; titles on the bars also keep the picture in its box', async () => {
    const { m, inset } = await read(clips.captioned as string, captionedText);
    const base = templateFrom({ measure: m, inset, name: 'captioned', label: 'captioned', hash: 'x' });
    const beats = [0, 1, 2, 3].map((k) => ({ start: k * FRAMES + 3, end: (k + 1) * FRAMES - 3 }));
    const captions = { box: [0.1, 0.9, 0.8, 0.06], style: { size: 0.03, weight: 800, color: '#ffffff', align: 'center' }, line: { centre: 0.93, size: 0.054 }, beats, script: 'latin' };
    const tpl = { ...base, captions } as Template;
    const card = templateCard(tpl, slotsOf(tpl, undefined)).text;
    expect(card).toContain('the captions sit on the black below it.');
    expect(card).toMatch(/as an item in that box[^\n]* The caption band is \[0\.1, 0\.9, 0\.8, 0\.06\] \(y \d+ to \d+ px\): leave it black\./);
    const titled: TextTrack = { step: 15, sampled: 12, cues: [cue('Top tools', 'title', 0, 2 * FRAMES, [200, 20, 240, 24])] };
    const t = (await read(clips.letterbox as string, titled)).inset;
    expect(t).toMatchObject({ kind: 'bars', titles: 1 });
    expect(t?.captions).toBeUndefined();
    const said = insetText(t as Inset, 4);
    expect(said).toContain('Titles sit on the black outside the picture too (1 in text.json): the scene draws them.');
    expect(said).toContain('filling the canvas would put that text over the picture.');
    expect(said).not.toContain('fill the canvas');
  });

  it('says captions over the content as over, and keeps the plain advice for bars without text on them', async () => {
    const over: TextTrack = { step: 15, sampled: 12, cues: [0, 1, 2, 3].map((k) => cue('line ' + (k + 1), 'caption', k * FRAMES, (k + 1) * FRAMES, [200, 300, 240, 24])) };
    expect((await read(clips.framed as string, over)).inset).toMatchObject({ kind: 'frame', captions: 'over' });
    const { inset } = await read(clips.letterbox as string, over);
    expect(inset).toMatchObject({ kind: 'bars', captions: 'over' });
    expect(insetText(inset as Inset, 4)).toContain('To re-create: fill the canvas, the bars are no design');
  });

  it('does not call a border that only one shot has a constant frame', async () => {
    const { m, inset } = await read(clips.once as string);
    expect(m.shots).toHaveLength(4);
    expect(inset).toBeUndefined();
  });

  it('does not call a plain ground shared by designed shots a frame: what changes on it does not fill a box', async () => {
    const { m, inset } = await read(clips.designed as string);
    expect(m.shots).toHaveLength(4);
    expect(inset).toBeUndefined();
  });

  it('is said by describe (REFERENCE.md, inset.json, its JSON) and by the template card', async () => {
    expect((await runCli(rt, ['video', 'describe', 'framed.mp4', '--out', 'ref'])).code).toBe(0);
    const printed = rt.json() as { files: string[]; inset?: Inset & { note: string } };
    expect(printed.files).toContain('inset.json');
    expect(printed.inset).toMatchObject({ kind: 'frame', shots: 4, of: 4 });
    expect(printed.inset?.note).toContain('Frame: in all 4 shots the content sits inside the same frame');
    const card = await rt.fs.readText(rt.path.join(rt.dir, 'ref', 'REFERENCE.md'));
    expect(card).toContain('- Frame: in all 4 shots the content sits inside the same frame, in [0.1');
    expect(card).toContain('video-scenes.md, "A screen inside a scene"');
    const inset = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'ref', 'inset.json'))) as Inset;
    const m = JSON.parse(await rt.fs.readText(rt.path.join(rt.dir, 'ref', 'measure.json'))) as Measure;
    const tpl = templateFrom({ measure: m, inset, name: 'framed', label: 'framed', hash: 'x' });
    expect(tpl.inset).toEqual(inset);
    expect(templateCard(tpl, slotsOf(tpl, undefined)).text).toContain('\nFrame: in all 4 shots the content sits inside the same frame');
    // A describe that finds no frame leaves no inset.json from an earlier one behind.
    expect((await runCli(rt, ['video', 'describe', 'full.mp4', '--out', 'ref'])).code).toBe(0);
    expect(rt.json()).not.toHaveProperty('inset');
    expect(await rt.fs.stat(rt.path.join(rt.dir, 'ref', 'inset.json'))).toBeNull();
  });
});
