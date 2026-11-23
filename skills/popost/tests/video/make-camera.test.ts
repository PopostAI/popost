import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { CameraMove, Problem, Project, ResolvedCameraMove } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { cameraAt, cameraPeak } from '../../src/video/timeline/frame';
import { edgeShown, fullMove, movesAt } from '../../src/video/presets/camera';
import { ease } from '../../src/video/presets/easing';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, pixelsWhere, playedAndJumped, projectDir } from './make-fixtures';

const W = 180;
const H = 320;

const project = (moves: CameraMove[], frames = 60): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'pic', kind: 'image', file: 'assets/pic.png' }],
  segments: [
    { id: 'a', frames: 10, base: { color: '#000000' } },
    { id: 'b', frames, base: { material: 'pic', camera: { moves } }, in: { transition: 'dissolve', frames: 6 } },
  ],
  tracks: [],
});

const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

/** Where the point p of the picture is on screen under the camera state (fractions). */
const onScreen = (state: { scale: number; translate: [number, number] }, p: [number, number]): [number, number] =>
  [0.5 + state.translate[0] + state.scale * (p[0] - 0.5), 0.5 + state.translate[1] + state.scale * (p[1] - 0.5)];

describe('camera moves: format, check and the maths', () => {
  /** "Cut, then zoom 2.6x towards the top right corner over 28 frames with ease-out, then hold." */
  const corner: CameraMove = { from: 0, to: 28, scale: [1, 2.6], focus: [1, 0], ease: 'out' };

  it('says the cut-zoom-hold of a real reference, and holds before the first and after the last move', () => {
    const m = fullMove(corner, 100);
    expect(m).toEqual({ from: 100, to: 128, scale: [1, 2.6], focus: [1, 0], shift: [[0, 0], [0, 0]], ease: 'out' });
    expect(movesAt([m], 90)).toEqual({ scale: 1, translate: [0, 0] });
    expect(movesAt([m], 114).scale).toBeCloseTo(1 + 1.6 * ease('out', 0.5), 12);
    expect(movesAt([m], 128).scale).toBeCloseTo(2.6, 12);
    expect(movesAt([m], 400)).toEqual(movesAt([m], 128));
    // The focus point stays where it is on screen at every frame of the move.
    for (const n of [100, 107, 114, 121, 128]) onScreen(movesAt([m], n), [1, 0]).forEach((v, i) => expect(v).toBeCloseTo([1, 0][i] ?? 0, 12));
    expect(edgeShown(m)).toBe(0);
  });

  it('holds between moves, eases each one, and shifts', () => {
    const moves: ResolvedCameraMove[] = [
      fullMove({ from: 0, to: 10, scale: [1, 2] }, 0),
      fullMove({ from: 20, to: 30, scale: [2, 1.5], focus: [0.25, 0.75], shift: [[0, 0], [0.1, 0]], ease: 'in-out' }, 0),
    ];
    expect(movesAt(moves, 15)).toEqual(movesAt(moves, 10));
    expect(movesAt(moves, 5).scale).toBeCloseTo(1.5, 12);
    expect(movesAt(moves, 25).scale).toBeCloseTo(1.75, 12);
    expect(movesAt(moves, 30).translate[0]).toBeCloseTo((1 - 1.5) * (0.25 - 0.5) + 0.1, 12);
    expect(edgeShown(moves[1] as ResolvedCameraMove)).toBeCloseTo(0, 12);
    expect(edgeShown(fullMove({ from: 0, to: 10, scale: [1.2, 1.2], shift: [[0, 0], [0.3, 0]] }, 0))).toBeCloseTo(0.2, 12);
  });

  it('refuses scales below 1, moves that run backwards or overlap, both forms at once; warns about a shift that shows an edge', () => {
    expect(checkProject(project([corner]))).toEqual([]);
    expect(at(checkProject(project([{ from: 0, to: 20, scale: [1, 0.8] }])), 'segments[1].base.camera.moves[0].scale').fix).toContain('[1.3, 1]');
    at(checkProject(project([{ from: 20, to: 20, scale: [1, 2] }])), 'segments[1].base.camera.moves[0].to');
    expect(at(checkProject(project([corner, { from: 20, to: 40, scale: [2.6, 1] }])), 'segments[1].base.camera.moves[1].from').message).toContain('before move 0 ends');
    expect(at(checkProject(project([{ from: 70, to: 80, scale: [1, 2] }])), 'segments[1].base.camera.moves[0].from').fix).toContain('at most 59');
    expect(at(checkProject(project([{ from: 0, to: 20, scale: [1.1, 1.1], shift: [[0, 0], [0.2, 0]] }])), 'segments[1].base.camera.moves[0].shift', 'warning').message).toContain('edge');
    const both = parseProject({ ...project([corner]), segments: [{ id: 'a', frames: 9, base: { material: 'pic', camera: { zoom: 0.1, moves: [corner] } } }] });
    expect(both.project).toBeUndefined();
    expect(at(both.problems, 'segments[0].base.camera').fix).toContain('"moves"');
    expect(parseProject({ ...project([corner]), segments: [{ id: 'a', frames: 9, base: { material: 'pic', camera: { moves: [{ ...corner, focal: [1, 0] }] } } }] }).problems.map((p) => p.at))
      .toEqual(['segments[0].base.camera.moves[0].focal']);
  });

  it('resolves moves in absolute frames, holds them through the transition into the segment, and knows the peak', () => {
    const r = resolve(project([corner]));
    const base = r.segments[1]?.base;
    expect(base).toMatchObject({ kind: 'image', zoom: 0, pan: [0, 0], moves: [{ from: 10, to: 38, scale: [1, 2.6], focus: [1, 0] }] });
    expect(cameraAt(r, 1, 7)).toEqual({ scale: 1, translate: [0, 0] });
    expect(cameraAt(r, 1, 69).scale).toBeCloseTo(2.6, 12);
    expect(cameraPeak(r, 1)).toBeCloseTo(2.6, 12);
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('camera moves: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  /** The picture: grey with a red 8 x 8 mark on pixels 64..71 x 116..123, so its middle is at (68, 120). */
  const MARK: [number, number] = [68 / W, 120 / H];
  const move: CameraMove = { from: 0, to: 20, scale: [1, 2], focus: [0.25, 0.25] };

  beforeAll(async () => {
    dir = await projectDir('make-camera-', project([move]));
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=' + W + 'x' + H, '-vf', 'drawbox=x=64:y=116:w=8:h=8:color=red:t=fill', '-frames:v', '1', path.join(dir, 'assets', 'pic.png')]);
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('puts the marked point where the maths says, before, during and after the move', async () => {
    if (!renderer) throw new Error('renderer not open');
    const r = resolve(project([move]));
    const rows: string[] = [];
    for (const n of [12, 20, 30, 45]) {
      const img = await decodePng(await renderer.frame(n));
      const red = pixelsWhere(img, [0, 0, W, H], (c) => c[0] > 150 && c[1] < 90 && c[2] < 90);
      const got = [red.reduce((s, p) => s + p[0] + 0.5, 0) / red.length, red.reduce((s, p) => s + p[1] + 0.5, 0) / red.length];
      const want = onScreen(cameraAt(r, 1, n), MARK).map((v, i) => v * (i === 0 ? W : H));
      rows.push(n + ': mark at ' + got.map((v) => v.toFixed(1)).join(',') + ', maths ' + want.map((v) => v.toFixed(1)).join(','));
      got.forEach((v, i) => expect(Math.abs(v - (want[i] ?? 0)), 'frame ' + n).toBeLessThan(1));
    }
    console.log(rows.join('\n'));
  });

  it('draws frames inside the move the same when played and when jumped to', async () => {
    if (!renderer) throw new Error('renderer not open');
    const r = renderer;
    for (const n of [11, 19, 25]) {
      const [played, jumped] = await playedAndJumped((f) => r.frame(f), n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });
});
