import path from 'node:path';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Project } from '../../src/video/types';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { parseProject } from '../../src/video/project/schema';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, isNear, pixelAt, projectDir } from './make-fixtures';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

/** A wide red picture (160x40) shown whole on a 180x320 canvas: it sits in the middle, and the ground shows above and below. */
const project = (ground?: string): Project => ({
  version: 1,
  canvas: { width: 180, height: 320, fps: 30 },
  materials: [{ id: 'wide', kind: 'image', file: 'assets/wide.png' }],
  segments: [{ id: 'a', frames: 10, base: { material: 'wide', fit: 'contain', ...(ground ? { ground } : {}) } }],
  tracks: [],
});

describe('the ground of a material base', () => {
  it('is a fill like any other, and only a material base has one', () => {
    const plain = parseProject(project('#00c040'));
    expect(plain.problems).toEqual([]);
    expect(plain.project?.segments[0]?.base).toEqual({ material: 'wide', fit: 'contain', ground: '#00c040' });
    const gradient = { type: 'linear', angle: 90, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] };
    expect(parseProject({ ...project(), segments: [{ id: 'a', frames: 10, base: { material: 'wide', ground: gradient } }] }).problems).toEqual([]);
    const onColour = parseProject({ ...project(), segments: [{ id: 'a', frames: 10, base: { color: '#101014', ground: '#00c040' } }] });
    expect(onColour.problems.some((p) => p.at === 'segments[0].base.ground')).toBe(true);
  });
});

describe.skipIf(!ready)('the ground of a material base: render (Chrome + ffmpeg)', () => {
  const dirs: string[] = [];
  const renderers: Renderer[] = [];
  const open = async (ground?: string): Promise<Renderer> => {
    const dir = await projectDir('make-ground-', project(ground));
    dirs.push(dir);
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe01010:size=160x40', '-frames:v', '1', path.join(dir, 'assets', 'wide.png')]);
    const r = await openRenderer(rt, dir);
    renderers.push(r);
    return r;
  };
  let green: Renderer;
  let plain: Renderer;
  beforeAll(async () => { green = await open('#00c040'); plain = await open(); });
  afterAll(async () => {
    await Promise.all(renderers.map((r) => r.close()));
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('shows the whole picture in the middle and the ground around it; black without one', async () => {
    const img = await decodePng(await green.frame(0));
    expect(pixelAt(img, 90, 160), 'the picture').toSatisfy((c: number[]) => isNear(c, [224, 16, 16]));
    expect(pixelAt(img, 90, 40), 'above').toSatisfy((c: number[]) => isNear(c, [0, 192, 64]));
    expect(pixelAt(img, 90, 280), 'below').toSatisfy((c: number[]) => isNear(c, [0, 192, 64]));
    const bare = await decodePng(await plain.frame(0));
    expect(pixelAt(bare, 90, 160)).toSatisfy((c: number[]) => isNear(c, [224, 16, 16]));
    expect(pixelAt(bare, 90, 40)).toSatisfy((c: number[]) => isNear(c, [0, 0, 0]));
  });
});
