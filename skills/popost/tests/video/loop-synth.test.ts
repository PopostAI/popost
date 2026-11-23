import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { checkProject } from '../../src/video/project/check';
import { parseProject } from '../../src/video/project/schema';
import { rng, synthCase } from '../../src/video/synth/generate';
import { truthBoundaries, truthMeasure } from '../../src/video/synth/truth';
import { makePicture } from '../../src/video/synth/write';
import { ffmpegReady } from './read-clips';
import { resolve } from '../../src/video/timeline/resolve';
import type { Resolved, ResolvedItem, ResolvedMotion } from '../../src/video/types';

const motion = (preset: ResolvedMotion['preset'], frames: number, extra: Partial<ResolvedMotion> = {}): ResolvedMotion =>
  ({ preset, frames, ease: 'out', overshoot: 0.12, direction: 'left', distance: 0.25, ...extra });

const item = (id: string, start: number, end: number, enter: ResolvedMotion, exit: ResolvedMotion): ResolvedItem =>
  ({ id, type: 'shape', start, end, box: [0.1, 0.1, 0.5, 0.2], z: 0, enter, exit, shape: 'rect', color: '#ff0000' });

/** Three segments of 60, 90 and 45 frames: a hard cut into the second, a 9-frame slide into the third. */
const resolved: Resolved = {
  canvas: { width: 1080, height: 1920, fps: 30 },
  frames: 195,
  segments: [
    { id: 'a', index: 0, start: 0, end: 60, base: { kind: 'color', color: '#101010' } },
    { id: 'b', index: 1, start: 60, end: 150, base: { kind: 'image', src: 'assets/b.png', fit: 'cover', zoom: 0.04, pan: [0, 0] } },
    { id: 'c', index: 2, start: 150, end: 195, base: { kind: 'color', color: '#f0f0f0' },
      transition: { kind: 'slide', a: 146, frames: 9, boundary: 150, direction: 'left', mode: 'push', via: 'black', ease: 'in-out' } },
  ],
  items: [
    item('pop', 70, 130, motion('pop', 8), motion('fade', 6)),
    item('typed', 10, 195, motion('type', 12), motion('none', 0)),
    item('cut-off', 20, 60, motion('none', 0), motion('none', 0)),
    item('blink', 30, 40, motion('none', 0), motion('none', 0)),
    item('slid', 160, 190, motion('slide', 10, { direction: 'up' }), motion('slide', 10, { direction: 'up' })),
  ],
  audio: [],
};

describe('synthetic cases', () => {
  it('gives the same project for the same seed and a different one for another seed', () => {
    expect(synthCase({ seed: 7 })).toEqual(synthCase({ seed: 7 }));
    expect(JSON.stringify(synthCase({ seed: 7 }).project)).not.toBe(JSON.stringify(synthCase({ seed: 8 }).project));
  });

  it('keeps the generator stable: the first numbers of seed 1 never change', () => {
    const r = rng(1);
    expect([r.next(), r.next(), r.next()].map((x) => x.toFixed(6))).toEqual(['0.627074', '0.002736', '0.527447']);
  });

  it('passes the schema and the checks, for every seed tried', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const parsed = parseProject(JSON.parse(JSON.stringify(synthCase({ seed }).project)));
      const problems = [...parsed.problems, ...(parsed.project ? checkProject(parsed.project) : [])];
      expect(problems.filter((p) => p.level === 'error'), 'seed ' + seed).toEqual([]);
    }
  });

  it('keeps old seeds unchanged when new features exist, and draws them only when asked', () => {
    const plain = synthCase({ seed: 7 }).project;
    expect(JSON.stringify(plain)).not.toMatch(/"side"|"moves"|"strength"/);
    let sided = 0, moved = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const p = synthCase({ seed, features: ['sides', 'moves'] }).project;
      const parsed = parseProject(JSON.parse(JSON.stringify(p)));
      expect([...parsed.problems, ...(parsed.project ? checkProject(parsed.project) : [])].filter((x) => x.level === 'error'), 'seed ' + seed).toEqual([]);
      sided += p.segments.filter((s) => s.in?.side).length;
      moved += p.segments.filter((s) => 'material' in s.base && s.base.camera && 'moves' in s.base.camera).length;
    }
    expect(sided).toBeGreaterThan(10);
    expect(moved).toBeGreaterThan(10);
  });

  it('puts no aliasing texture (cellauto, life) under a camera or a transition that transforms the picture', () => {
    let kept = 0;
    for (let seed = 1; seed <= 150; seed++) {
      for (const features of [[], ['sides', 'moves']] as const) {
        const c = synthCase({ seed, features });
        c.project.segments.forEach((s, k) => {
          const pic = c.pictures.find((p) => p.file === 'assets/' + s.id + '.png');
          if (!pic || (pic.recipe.source !== 'cellauto' && pic.recipe.source !== 'life')) return;
          kept++;
          expect('material' in s.base && s.base.camera, 'seed ' + seed + ' ' + s.id).toBeFalsy();
          const next = c.project.segments[k + 1];
          for (const t of [s.in, next?.in]) expect(['slide', 'whip', 'zoom', 'spin', 'shake', 'glitch'], 'seed ' + seed + ' ' + s.id).not.toContain(t?.transition);
        });
      }
    }
    // still drawn where nothing transforms them
    expect(kept).toBeGreaterThan(20);
  });

  it('draws only what was asked for', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const c = synthCase({ seed, transitions: ['cut', 'wipe'], motions: ['pop'], segments: 4 });
      expect(c.project.segments).toHaveLength(4);
      expect(c.project.segments[0]?.in).toBeUndefined();
      for (const s of c.project.segments) if (s.in) expect(s.in.transition).toBe('wipe');
      for (const t of c.project.tracks) if (t.type !== 'audio') expect(t.enter?.preset).toBe('pop');
      expect(c.pictures.map((p) => p.file).sort()).toEqual(c.project.materials.map((m) => m.file ?? '').sort());
    }
  });

  it('places every item inside its segment, clear of the transitions', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const c = synthCase({ seed });
      for (const t of c.project.tracks) {
        if (t.type === 'audio' || t.type === 'caption') continue;
        const segment = c.project.segments.find((s) => s.id === t.during.segment);
        expect(segment).toBeDefined();
        const frames = segment?.frames ?? 0;
        const from = t.during.from ?? 0;
        expect(from).toBeGreaterThanOrEqual(15);
        expect(t.during.to ?? frames).toBeLessThanOrEqual(frames);
        // At least 0.4 s (12 frames at 30 fps) of standing still between the entrance and the exit.
        expect((t.during.to ?? frames) - from).toBeGreaterThanOrEqual((t.enter?.frames ?? 0) + (t.exit?.frames ?? 0) + 12);
      }
    }
  });
});

describe('truth of a resolved timeline', () => {
  it('follows the frame conventions for cuts and transitions', () => {
    expect(truthBoundaries(resolved)).toEqual([
      { frame: 60, kind: 'cut', start: 59, end: 60, confidence: 1 },
      { frame: 150, kind: 'slide', start: 145, end: 155, direction: 'left', mode: 'push', confidence: 1 },
    ]);
  });

  it('turns entrances and exits into events of the shot they start in', () => {
    const m = truthMeasure(resolved);
    // "cut-off" stops where its segment ends, so only its entrance is an event; "blink" has both.
    expect(m.shots.map((s) => s.events.length)).toEqual([4, 2, 2]);
    expect(m.shots[0]?.events.map((e) => [e.start, e.kind, e.how])).toEqual([[10, 'appear', 'wipe'], [20, 'appear', 'instant'], [30, 'appear', 'instant'], [40, 'disappear', 'instant']]);
    expect(m.shots[0]?.events[0]).toMatchObject({ start: 10, end: 22, kind: 'appear', how: 'wipe', direction: 'right', ease: 'linear' });
    expect(m.shots[1]?.events[0]).toMatchObject({ start: 70, end: 78, kind: 'appear', how: 'scale', overshoot: 0.12, ease: 'out' });
    expect(m.shots[1]?.events[1]).toMatchObject({ start: 124, end: 130, kind: 'disappear', how: 'fade' });
    // Entering or leaving, the direction is the way the element travels.
    expect(m.shots[2]?.events[0]).toMatchObject({ start: 160, end: 170, kind: 'appear', how: 'slide', direction: 'up' });
    expect(m.shots[2]?.events[1]).toMatchObject({ start: 180, end: 190, kind: 'disappear', how: 'slide', direction: 'up' });
  });

  it('reports keyframed camera moves in the absolute frames resolve() gives them', () => {
    const moved: Resolved = {
      ...resolved,
      segments: resolved.segments.map((s) => (s.id === 'b' && s.base.kind === 'image'
        ? { ...s, base: { ...s.base, zoom: 0, moves: [{ from: 75, to: 100, scale: [1, 1.6], focus: [0.2, 0.75], shift: [[0, 0], [0, 0]], ease: 'out' }] } }
        : s)),
    };
    const shot = truthMeasure(moved).shots[1];
    expect(shot?.camera.moves).toEqual([{ start: 75, end: 100, scale: [1, 1.6], focus: [0.2, 0.75] }]);
    expect(shot?.camera.zoomPerS).toBe(0.2);
  });

  it('puts every move of a generated project inside its own shot', () => {
    let moves = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const built = resolve(synthCase({ seed, features: ['moves'] }).project);
      for (const shot of truthMeasure(built).shots) {
        for (const mv of shot.camera.moves ?? []) {
          moves++;
          expect(mv.start, 'seed ' + seed).toBeGreaterThanOrEqual(shot.start);
          expect(mv.end, 'seed ' + seed).toBeLessThanOrEqual(shot.end);
        }
      }
    }
    expect(moves).toBeGreaterThan(10);
  });

  it('reports the camera in the units of the project', () => {
    const m = truthMeasure(resolved);
    expect(m.shots.map((s) => s.camera.kind)).toEqual(['static', 'move', 'static']);
    expect(m.shots[1]?.camera.zoomPerS).toBe(0.04);
    expect(m.source).toMatchObject({ frames: 195, fps: 30, duration: 6.5, hasAudio: false });
  });
});

describe.skipIf(!(await ffmpegReady()))('synthetic pictures (ffmpeg)', () => {
  it('writes every source as rgb24, and the same picture for the same recipe', async () => {
    const rt = await createDiskRuntime();
    const dir = rt.dir;
    try {
      for (const source of ['gradients', 'mandelbrot', 'testsrc2', 'cellauto', 'smptebars', 'life'] as const) {
        const recipe = { source, seed: 4321, hue: 40 };
        const [a, b] = [join(dir, source + '-a.png'), join(dir, source + '-b.png')];
        await makePicture(rt, recipe, a, 64, 96);
        await makePicture(rt, recipe, b, 64, 96);
        const [x, y] = [await readFile(a), await readFile(b)];
        // IHDR colour type (byte 25 of a PNG): 2 is RGB, 6 would be RGB with alpha
        expect(x[25], source).toBe(2);
        expect(x.equals(y), source).toBe(true);
      }
    } finally {
      await rt.cleanup();
    }
  });
});
