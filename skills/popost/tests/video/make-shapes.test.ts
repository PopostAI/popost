import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Problem, Project, Track } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { fillColor, gradientCss } from '../../src/video/presets/fill';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, isNear, pixelAt, projectDir, type Rgb } from './make-fixtures';

const W = 180;
const H = 320;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const GREEN = [0, 255, 0];

/** A box of w x h pixels centred on (cx, cy), as fractions of the canvas. */
const boxPx = (cx: number, cy: number, w: number, h: number): [number, number, number, number] => [(cx - w / 2) / W, (cy - h / 2) / H, w / W, h / H];

/**
 * One 2-frame segment per look, each on its own frame pair: 0 a linear gradient base (red to blue, left to right);
 * 1 a radial gradient ellipse over black; 2 a 60 px square turned 45 degrees; 3 a bordered rect at half opacity; 4 a
 * picture masked to an ellipse and one with rounded corners; 5 a rect with a drop shadow on white.
 */
const project = (): Project => {
  const seg = (id: string, base: Project['segments'][number]['base']): Project['segments'][number] => ({ id, frames: 2, base });
  const during = (segment: string) => ({ segment });
  const tracks: Track[] = [
    { id: 'radial', type: 'shape', shape: 'rect', box: [0, 0, 1, 1], during: during('radial'), color: { type: 'radial', stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#0000ff' }] } },
    { id: 'turned', type: 'shape', shape: 'rect', color: '#ffffff', box: boxPx(90, 160, 60, 60), rotate: 45, during: during('turned') },
    { id: 'framed', type: 'shape', shape: 'rect', color: '#ffffff', box: boxPx(90, 160, 120, 120), opacity: 0.5, border: { color: '#ff0000', width: 0.05 }, during: during('framed') },
    { id: 'oval', type: 'image', material: 'green', fit: 'cover', mask: 'ellipse', box: boxPx(90, 80, 120, 80), during: during('masked') },
    { id: 'round', type: 'image', material: 'green', fit: 'cover', radius: 0.5, box: boxPx(90, 240, 120, 80), during: during('masked') },
    { id: 'lifted', type: 'shape', shape: 'rect', color: '#0000ff', box: boxPx(90, 160, 80, 80), shadow: { color: '#000000', blur: 0, x: 0.05, y: 0.05 }, during: during('shadow') },
  ];
  return {
    version: 1,
    canvas: { width: W, height: H, fps: 30 },
    materials: [{ id: 'green', kind: 'image', file: 'assets/green.png' }],
    segments: [
      seg('linear', { color: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } }),
      seg('radial', { color: '#000000' }),
      seg('turned', { color: '#000000' }),
      seg('framed', { color: '#000000' }),
      seg('masked', { color: '#000000' }),
      seg('shadow', { color: '#ffffff' }),
    ],
    tracks,
  };
};

const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

describe('fills and the look of items: format, check and resolve', () => {
  it('accepts every new field, and resolves a gradient with one colour for whoever needs one', () => {
    const parsed = parseProject(project());
    expect(parsed.problems).toEqual([]);
    expect(checkProject(parsed.project as Project)).toEqual([]);
    const r = resolve(project());
    expect(r.segments[0]?.base).toEqual({ kind: 'color', color: '#ff0000', gradient: { type: 'linear', angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }] } });
    expect(r.items.find((i) => i.id === 'framed')).toMatchObject({ opacity: 0.5, border: { color: '#ff0000', width: 0.05 } });
    expect(r.items.find((i) => i.id === 'lifted')?.shadow).toEqual({ color: '#000000', blur: 0, x: 0.05, y: 0.05 });
    expect(r.items.find((i) => i.id === 'oval')).toMatchObject({ mask: 'ellipse', radius: 0 });
    expect(fillColor({ type: 'linear', stops: [{ at: 0, color: 'a' }, { at: 0.4, color: 'b' }, { at: 1, color: 'c' }] })).toBe('b');
    expect(gradientCss({ type: 'linear', stops: [{ at: 0, color: '#000' }, { at: 1, color: '#fff' }] })).toBe('linear-gradient(180deg, #000 0%, #fff 100%)');
  });

  it('reports stops out of order, bad gradient fields, and a radius that a mask overrides', () => {
    const p = project();
    p.segments[0] = { id: 'linear', frames: 2, base: { color: { type: 'linear', stops: [{ at: 0.6, color: '#000' }, { at: 0.2, color: '#fff' }] } } };
    expect(at(checkProject(p), 'segments[0].base.color.stops[1].at').fix).toContain('at least 0.6');
    const raw = { ...project(), segments: [{ id: 's', frames: 2, base: { color: { type: 'conic', stops: [{ at: 0, color: '#000' }] } } }], tracks: [] };
    expect(parseProject(raw).problems.map((x) => x.at)).toEqual(['segments[0].base.color.type', 'segments[0].base.color.stops']);
    const odd = { ...project(), segments: [{ id: 's', frames: 2, base: { color: { type: 'linear', stops: [{ at: 0, color: '#000', pos: 1 }, { at: 1, color: '#fff' }] } } }], tracks: [] };
    expect(parseProject(odd).problems.map((x) => x.level + ' ' + x.at)).toEqual(['warning segments[0].base.color.stops[0].pos']);
    const both = project();
    both.tracks[3] = { ...(both.tracks[3] as Extract<Track, { type: 'image' }>), radius: 0.2 };
    at(checkProject(both), 'tracks[3].radius', 'warning');
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('fills and the look of items: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const shot = async (segment: number): Promise<Rgb> => {
    if (!renderer) throw new Error('renderer not open');
    return decodePng(await renderer.frame(2 * segment + 1));
  };
  const is = (want: number[], tol = 24) => (c: number[]): boolean => isNear(c, want, tol);

  beforeAll(async () => {
    dir = await projectDir('make-shapes-', project());
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=64x64', '-frames:v', '1', path.join(dir, 'assets', 'green.png')]);
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives a gradient\'s ends the stop colours: linear at the left and right edges, radial at the centre and corners', async () => {
    const linear = await shot(0);
    expect(pixelAt(linear, 0, 160)).toSatisfy(is(RED, 6));
    expect(pixelAt(linear, W - 1, 160)).toSatisfy(is(BLUE, 6));
    expect(pixelAt(linear, 90, 160)).toSatisfy(is([128, 0, 127], 6));
    const radial = await shot(1);
    expect(pixelAt(radial, 90, 160)).toSatisfy(is(WHITE, 6));
    expect(pixelAt(radial, 0, 0)).toSatisfy(is(BLUE, 8));
    expect(pixelAt(radial, W - 1, H - 1)).toSatisfy(is(BLUE, 8));
  });

  it('turns a square 45 degrees: its corners reach past the box on the axes, and the box\'s corners are empty', async () => {
    const img = await shot(2);
    expect(pixelAt(img, 90 + 38, 160)).toSatisfy(is(WHITE));
    expect(pixelAt(img, 90, 160 - 38)).toSatisfy(is(WHITE));
    expect(pixelAt(img, 90 + 26, 160 + 26)).toSatisfy(is(BLACK));
    expect(pixelAt(img, 90 - 26, 160 - 26)).toSatisfy(is(BLACK));
  });

  it('draws a border inside the box and multiplies the item by its opacity', async () => {
    const img = await shot(3);
    // Border: 5% of the smaller side (9 px) inside the 120 px box; the whole item at opacity 0.5 over black.
    expect(pixelAt(img, 90 - 60 + 4, 160)).toSatisfy(is([128, 0, 0], 6));
    expect(pixelAt(img, 90, 160)).toSatisfy(is([128, 128, 128], 6));
    expect(pixelAt(img, 90 - 60 - 3, 160)).toSatisfy(is(BLACK, 4));
  });

  it('masks a picture to an ellipse and rounds the corners of another', async () => {
    const img = await shot(4);
    expect(pixelAt(img, 90, 80)).toSatisfy(is(GREEN));
    expect(pixelAt(img, 90 - 58, 80 - 38)).toSatisfy(is(BLACK));
    expect(pixelAt(img, 90 - 58, 80)).toSatisfy(is(GREEN));
    expect(pixelAt(img, 90, 240)).toSatisfy(is(GREEN));
    expect(pixelAt(img, 90 - 59, 240 - 39)).toSatisfy(is(BLACK));
  });

  it('casts an item\'s shadow beside it, on the side of its offset', async () => {
    const img = await shot(5);
    // Offset 5% of 180 px = 9 px right and down, no blur.
    expect(pixelAt(img, 90 + 40 + 4, 160 + 20)).toSatisfy(is(BLACK, 10));
    expect(pixelAt(img, 90 - 40 - 4, 160 - 20)).toSatisfy(is(WHITE, 4));
    expect(pixelAt(img, 90, 160)).toSatisfy(is(BLUE, 4));
  });
});
