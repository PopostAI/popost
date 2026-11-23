import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome } from '../../src/testing/disk';
import type { Problem, Project, ResolvedTransition, Segment } from '../../src/video/types';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { resolve } from '../../src/video/timeline/resolve';
import { expectedBoundaries, segmentsAt, transitionProgress, visibleRange } from '../../src/video/timeline/frame';
import { ONE_SIDED_TRANSITIONS, TRANSITION_DEFAULTS, transitionState, type TransitionName } from '../../src/video/presets/transition';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { openRenderer, type Renderer } from '../../src/video/render/index';
import { decodePng, pixelAt, pixelsWhere, playedAndJumped, projectDir, type Rgb } from './make-fixtures';

const W = 180;
const H = 320;
const CANVAS = { width: W, height: H };

/** Three 30-frame segments: red, then a picture (after a 10-frame transition into it), then green (after one out of it). */
const project = (into: Segment['in'], out?: Segment['in']): Project => ({
  version: 1,
  canvas: { width: W, height: H, fps: 30 },
  materials: [{ id: 'bar', kind: 'image', file: 'assets/bar.png' }],
  segments: [
    { id: 'red', frames: 30, base: { color: '#e01010' } },
    { id: 'pic', frames: 30, base: { material: 'bar' }, ...(into ? { in: into } : {}) },
    { id: 'green', frames: 30, base: { color: '#10c010' }, ...(out ? { in: out } : {}) },
  ],
  tracks: [],
});

const at = (problems: Problem[], where: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === where && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + where + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

const transition = (kind: TransitionName, side: 'after' | 'before', over: Partial<ResolvedTransition> = {}): ResolvedTransition => {
  const d = TRANSITION_DEFAULTS[kind];
  return { kind, a: side === 'after' ? 100 : 90, frames: 10, boundary: 100, direction: d.direction, mode: d.mode, via: d.via, ease: 'linear', side, strength: 1, ...over };
};

describe('one-sided transitions: format, check and timeline', () => {
  it('refuses a one-sided dissolve, wipe or slide with a fix, and warns about side or strength that do nothing', () => {
    for (const kind of ['dissolve', 'wipe', 'slide'] as const) {
      const p = at(checkProject(project({ transition: kind, side: 'after' })), 'segments[1].in.side');
      expect(p.allowed).toEqual(['both']);
      expect(p.fix).toContain('blur');
    }
    expect(at(checkProject(project({ transition: 'dissolve', side: 'before' })), 'segments[1].in.side').message).toContain('mixes the old and the new');
    expect(at(checkProject(project({ transition: 'cut', side: 'after' })), 'segments[1].in.side', 'warning').message).toContain('cut');
    expect(at(checkProject(project({ transition: 'wipe', strength: 2 })), 'segments[1].in.strength', 'warning').fix).toContain('Remove');
    expect(checkProject(project({ transition: 'blur', side: 'after', strength: 1.5 }))).toEqual([]);
    expect(parseProject({ ...project(undefined), segments: [{ id: 'a', frames: 9, base: { color: '#000' } }, { id: 'b', frames: 9, base: { color: '#fff' }, in: { transition: 'blur', side: 'later', strength: 3 } }] }).problems.map((p) => p.at))
      .toEqual(['segments[1].in.side', 'segments[1].in.strength']);
  });

  it('measures a one-sided span against its own side only, and refuses two transitions that need the same frames', () => {
    const short = (p: Project): Project => ({ ...p, segments: p.segments.map((s, k) => (k === 0 ? { ...s, frames: 8 } : s)) });
    expect(checkProject(short(project({ transition: 'blur', frames: 10, side: 'after' })))).toEqual([]);
    expect(at(checkProject(short(project({ transition: 'blur', frames: 10, side: 'before' }))), 'segments[1].in.frames').fix).toContain('at most 8');
    const both = at(checkProject(project({ transition: 'blur', frames: 20, side: 'after' }, { transition: 'zoom', frames: 15, side: 'before' })), 'segments[2].in');
    expect(both.message).toContain('first 20 frames');
    expect(both.message).toContain('last 15');
    expect(both.fix).toContain('at least 35');
  });

  it('places the span after or before the boundary, with its side, strength and a settling ease, and the boundary of the header', () => {
    const r = resolve(project({ transition: 'blur', frames: 10, side: 'after' }, { transition: 'zoom', frames: 6, side: 'before', strength: 2 }), {});
    expect(r.segments[1]?.transition).toMatchObject({ kind: 'blur', a: 30, frames: 10, boundary: 30, side: 'after', strength: 1, ease: 'out' });
    expect(r.segments[2]?.transition).toMatchObject({ kind: 'zoom', a: 54, frames: 6, boundary: 60, side: 'before', strength: 2, ease: 'in' });
    expect(resolve(project({ transition: 'blur', frames: 10 })).segments[1]?.transition).toMatchObject({ a: 25, side: 'both', strength: 1, ease: 'in-out' });
    expect(expectedBoundaries(r)).toEqual([
      { frame: 30, kind: 'blur', start: 29, end: 40, confidence: 1 },
      { frame: 60, kind: 'zoom', start: 53, end: 60, confidence: 1 },
    ]);
    // A one-sided transition shows nothing of the other side: no frame mixes two segments.
    expect(visibleRange(r, 0)).toEqual([0, 29]);
    expect(visibleRange(r, 1)).toEqual([30, 59]);
    expect(visibleRange(r, 2)).toEqual([60, 89]);
    for (let n = 0; n < 90; n++) expect(segmentsAt(r, n).layers).toHaveLength(1);
  });

  it('after: the new shot at full effect on the boundary frame, settling to none on frame a + F; before: the mirror', () => {
    const r = resolve(project({ transition: 'blur', frames: 10, side: 'after', ease: 'linear' }, { transition: 'blur', frames: 10, side: 'before', ease: 'linear' }), {});
    const blurAt = (n: number): number => segmentsAt(r, n).layers[0]?.state.blur ?? -1;
    expect(segmentsAt(r, 29).layers.map((l) => [l.index, l.state.blur])).toEqual([[0, 0]]);
    expect(segmentsAt(r, 30).layers[0]?.index).toBe(1);
    expect(blurAt(30)).toBeCloseTo(0.06, 9);
    expect(blurAt(35)).toBeCloseTo(0.03, 9);
    expect(blurAt(39)).toBeCloseTo(0.006, 9);
    expect(blurAt(40)).toBe(0);
    expect(segmentsAt(r, 49).layers.map((l) => [l.index, l.state.blur])).toEqual([[1, 0]]);
    expect(blurAt(50)).toBeCloseTo(0.006, 9);
    expect(segmentsAt(r, 59).layers.map((l) => l.index)).toEqual([1]);
    expect(blurAt(59)).toBeCloseTo(0.06, 9);
    expect(segmentsAt(r, 60).layers.map((l) => [l.index, l.state.blur])).toEqual([[2, 0]]);
    const into = r.segments[1]?.transition;
    if (!into) throw new Error('no transition');
    expect([30, 39].map((n) => transitionProgress(into, n))).toEqual([0, 0.9]);
  });

  it('scales the amount of a two-sided transition by strength, and leaves its timing alone', () => {
    const both = (kind: TransitionName, strength: number): ResolvedTransition => ({ ...transition(kind, 'after'), a: 95, side: 'both', strength });
    expect(transitionState(both('blur', 2), 0.5 - 1e-9, CANVAS).old.blur).toBeCloseTo(0.12, 6);
    expect(transitionState(both('blur', 0.5), 0.5 - 1e-9, CANVAS).old.blur).toBeCloseTo(0.03, 6);
    expect(transitionState(both('zoom', 2), 0.5, CANVAS).old.scale).toBeCloseTo(1.5, 9);
    expect(transitionState(both('flash', 0.5), 0.5, CANVAS).overlay?.opacity).toBeCloseTo(0.75, 9);
    expect(transitionState(both('dissolve', 2), 0.5, CANVAS)).toEqual(transitionState(both('dissolve', 1), 0.5, CANVAS));
  });

  it.each([...ONE_SIDED_TRANSITIONS])('%s shows one layer under the effect, full at the cut, none at the far end; strength scales it', (kind) => {
    const effect = (s: ReturnType<typeof transitionState>, side: 'after' | 'before'): number => {
      const l = side === 'after' ? s.next : s.old;
      return Math.abs(l.scale - 1) + l.blur + Math.abs(l.rotate) + Math.hypot(...l.translate) + l.smear[0] + l.smear[1] + (s.overlay?.opacity ?? 0);
    };
    for (const side of ['after', 'before'] as const) {
      const tr = transition(kind, side);
      const full = transitionState(tr, side === 'after' ? 0 : 1, CANVAS);
      const none = transitionState(tr, side === 'after' ? 1 : 0, CANVAS);
      expect((side === 'after' ? full.old : full.next).opacity).toBe(0);
      expect(effect(full, side), side).toBeGreaterThan(0.01);
      expect(effect(none, side), side).toBeLessThan(1e-9);
      if (kind !== 'flash' && kind !== 'fade') expect(effect(transitionState({ ...tr, strength: 2 }, side === 'after' ? 0 : 1, CANVAS), side)).toBeGreaterThan(effect(full, side) * 1.5);
    }
  });
});

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ready = (await hasFfmpeg(rt)) && hasChrome();

describe.skipIf(!ready)('one-sided transitions: render (Chrome + ffmpeg)', () => {
  let dir = '';
  let renderer: Renderer | undefined;
  const frame = async (n: number): Promise<Buffer> => {
    if (!renderer) throw new Error('renderer not open');
    return renderer.frame(n);
  };
  const rgb = async (n: number): Promise<Rgb> => decodePng(await frame(n));
  /** Pixels of a row across the bar's left edge (x 50..100) that are neither the blue ground nor the white bar. */
  const soft = (img: Rgb): number => pixelsWhere(img, [50, 160, 100, 161], (c) => !(c[2] > 180 && c[0] < 60) && !(c[0] > 200 && c[1] > 200 && c[2] > 200)).length;
  const reddish = (img: Rgb): number => pixelsWhere(img, [0, 0, W, H], (c) => c[0] > 120 && c[0] > c[2] + 60).length;

  beforeAll(async () => {
    // red (0..29); a hard cut at 30 into a blue picture with a white bar (x 72..107) that settles out of a blur on 30..39;
    // the picture goes into a blur on 54..59 (before), then a hard cut to green at 60.
    dir = await projectDir('make-sides-', project({ transition: 'blur', frames: 10, side: 'after' }, { transition: 'blur', frames: 6, side: 'before' }));
    await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1030e0:s=' + W + 'x' + H, '-vf', 'drawbox=x=72:y=0:w=36:h=' + H + ':color=white:t=fill', '-frames:v', '1', path.join(dir, 'assets', 'bar.png')]);
    renderer = await openRenderer(rt, dir);
  });
  afterAll(async () => {
    await renderer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('after: the boundary frame is the new shot, blurred, and no frame of the span shows the old one', async () => {
    const last = await rgb(29);
    expect(pixelAt(last, 90, 160)[0]).toBeGreaterThan(200);
    const cut = await rgb(30);
    const clean = await rgb(40);
    console.log('soft pixels across the edge: frame 30 ' + soft(cut) + ', frame 35 ' + soft(await rgb(35)) + ', frame 40 ' + soft(clean));
    expect(soft(cut)).toBeGreaterThan(8);
    expect(soft(clean)).toBeLessThanOrEqual(2);
    for (let n = 30; n < 40; n++) expect(reddish(await rgb(n)), 'frame ' + n).toBe(0);
  });

  it('before: the old shot goes into the blur up to the frame before the cut, and the cut frame is purely new', async () => {
    expect(soft(await rgb(53))).toBeLessThanOrEqual(2);
    expect(soft(await rgb(59))).toBeGreaterThan(8);
    const after = await rgb(60);
    expect(pixelsWhere(after, [0, 0, W, H], (c) => !(c[1] > 150 && c[0] < 60 && c[2] < 60))).toHaveLength(0);
  });

  it('draws frames inside one-sided spans the same when played and when jumped to', async () => {
    for (const n of [30, 33, 39, 55, 59]) {
      const [played, jumped] = await playedAndJumped(frame, n);
      expect(played.equals(jumped), 'frame ' + n).toBe(true);
    }
  });
});
