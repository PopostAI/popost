/**
 * Our own renderer's clips read back: synthetic projects (src/synth) rendered by Chrome at a quarter of their size,
 * as the round trip does, with the transitions the reading half used to confuse (spin, shake, glitch, blur, zoom,
 * whip, flash) and element entrances. Each clip is also re-encoded at half its size and a low bitrate, and the two
 * readings are compared: a reading must not depend on the encoding. Development seeds (1-40): the round trip's
 * validation (71-100) and unseen seeds (41-70, 101-130) are not to be looked into, and with five segments, a subset of
 * the kinds and pictures only, these seeds give projects of their own.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, hasChrome, type DiskRuntime } from '../../src/testing/disk';
import type { Boundary, Measure, TransitionKind } from '../../src/video/types';
import { buildPage } from '../../src/video/compile/index';
import { runFfmpegOk } from '../../src/video/media/ffmpeg';
import { measureVideo } from '../../src/video/measure/index';
import { renderVideo } from '../../src/video/render/index';
import { scoreMeasures } from '../../src/video/score/index';
import { synthCase } from '../../src/video/synth/generate';
import { truthMeasure } from '../../src/video/synth/truth';
import { writeCase } from '../../src/video/synth/write';
import { ffmpegReady } from './read-clips';

const ready = (await ffmpegReady()) && hasChrome();
let rt: DiskRuntime;

const CASES: Array<{ seed: number; transitions: TransitionKind[] }> = [
  { seed: 1, transitions: ['spin', 'shake', 'glitch', 'blur'] },
  { seed: 2, transitions: ['zoom', 'whip', 'flash'] },
  { seed: 3, transitions: ['spin', 'glitch', 'zoom', 'shake'] },
  { seed: 4, transitions: ['dissolve', 'wipe', 'slide', 'fade'] },
];

interface Result { seed: number; truth: Measure; got: Measure; again: Measure }

const pair = (truth: Boundary[], got: Boundary[]): Array<[Boundary, Boundary | undefined]> => {
  const used = new Set<number>();
  return truth.map((t) => {
    const tol = Math.max(2, Math.ceil((t.end - t.start) / 2));
    const i = got.findIndex((g, k) => !used.has(k) && Math.abs(g.frame - t.frame) <= tol);
    if (i >= 0) used.add(i);
    return [t, i >= 0 ? got[i] : undefined];
  });
};

describe.skipIf(!ready)('read: our renderer, and the same clips re-encoded (Chrome + ffmpeg)', () => {
  let dir = '';
  let results: Result[] = [];
  beforeAll(async () => {
    rt = await createDiskRuntime();
    dir = rt.dir;
    results = [];
    for (const c of CASES) {
      const cd = join(dir, 'case-' + c.seed);
      await mkdir(cd, { recursive: true });
      await writeCase(rt, synthCase({ seed: c.seed, segments: 5, transitions: c.transitions, pictureShare: 1 }), cd, 0.5);
      const page = await buildPage(rt, cd);
      if (!page.resolved) throw new Error('case ' + c.seed + ' did not build');
      const truth = truthMeasure(page.resolved);
      await writeFile(join(cd, 'truth.json'), JSON.stringify(truth));
      const out = join(cd, 'render.mp4'), half = join(cd, 'half.mp4');
      await renderVideo(rt, { projectDir: cd, out, scale: 0.25 });
      await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', out, '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-an', half]);
      results.push({ seed: c.seed, truth, got: await measureVideo(rt, out), again: await measureVideo(rt, half) });
    }
    console.info(report(results));
  }, 300_000);
  afterAll(() => rt.cleanup());

  const pairs = (): Array<[Boundary, Boundary | undefined]> => results.flatMap((r) => pair(r.truth.boundaries, r.got.boundaries));

  it('finds the transitions of our renders and names their kinds', () => {
    const p = pairs(), hit = p.filter((x): x is [Boundary, Boundary] => x[1] !== undefined);
    expect(hit.length / p.length).toBeGreaterThanOrEqual(RECALL);
    expect(hit.filter(([t, g]) => t.kind === g.kind).length / hit.length).toBeGreaterThanOrEqual(KIND_EXACT);
  });

  it('reads the elements of our renders', () => {
    const motion = results.reduce((s, r) => s + scoreMeasures(r.truth, r.got).dimensions.motion.score, 0) / results.length;
    expect(motion).toBeGreaterThanOrEqual(MOTION);
  });

  it('reads a half-size, low-bitrate re-encode the same way', () => {
    const p = results.flatMap((r) => pair(r.got.boundaries, r.again.boundaries));
    expect(p.filter(([a, b]) => b && b.kind === a.kind && Math.abs(b.frame - a.frame) <= 1).length / p.length).toBeGreaterThanOrEqual(SAME_BOUNDARY);
    const shots = results.flatMap((r) => r.got.shots.map((s, i) => [s.camera.kind, r.again.shots[i]?.camera.kind] as const));
    expect(shots.filter(([a, b]) => a === b).length / shots.length).toBeGreaterThanOrEqual(SAME_CAMERA);
    const motion = results.reduce((s, r) => s + scoreMeasures(r.got, r.again).dimensions.motion.score, 0) / results.length;
    expect(motion).toBeGreaterThanOrEqual(SAME_MOTION);
  });
});

// What the code meets on these clips (see the printed table); a regression below them fails the suite.
// Until 2026-11-21 the clips were seeds 103-113, inside a range that is not to be looked into; on them round 1 met
// recall 16/16, kind exact 12/16, motion 0.590 (re-encode: same boundary 13/16, same camera 19/21, motion 0.455) and
// round 2 kind exact 13/16, motion 0.614 (re-encode 13/16, 18/20, 0.621). Those numbers do not carry over to other clips.
// Development seeds 1-4, measured on 2026-11-21 with the round 2 reading (gradient pictures now the same on every run):
// recall 15/16 (a dissolve between two cellauto pictures is missed), kind exact 11/15 (glitch read as a cut, shake as a
// dissolve, a zoom as a dissolve, a spin as a cut), motion 0.752; re-encode: as many boundaries in every clip, same
// camera 19/19 shots, motion 0.708. RECALL and KIND_EXACT were set to those values; the other floors were met as they were.
// The same day the aliasing textures (cellauto, life) were taken from under cameras and transforming transitions, which
// changed some pictures of seeds 1-4: recall 15/16 (the dissolve of seed 4 is still missed), kind exact 14/15 (glitch
// read as a cut), one extra boundary (seed 2), motion 0.777; re-encode: as many boundaries in every clip, same camera
// 19/20 shots, motion 0.717. KIND_EXACT rose to that value.
const RECALL = 0.93;
const KIND_EXACT = 0.93;
const MOTION = 0.6;
const SAME_BOUNDARY = 0.8;
const SAME_CAMERA = 0.85;
const SAME_MOTION = 0.6;

const report = (rs: Result[]): string => rs.map((r) => {
  const p = pair(r.truth.boundaries, r.got.boundaries);
  const kinds = p.map(([t, g]) => t.kind + '>' + (g ? g.kind : 'MISS')).join(' ');
  const s = scoreMeasures(r.truth, r.got), st = scoreMeasures(r.got, r.again);
  return 'seed ' + r.seed + ': ' + kinds + ' | extra ' + (r.got.boundaries.length - p.filter(([, g]) => g).length) +
    ' | motion vs truth ' + s.dimensions.motion.score.toFixed(3) + ' | re-encode: boundaries ' + r.got.boundaries.length + '/' + r.again.boundaries.length +
    ', cameras ' + r.got.shots.map((x) => x.camera.kind[0]).join('') + '/' + r.again.shots.map((x) => x.camera.kind[0]).join('') +
    ', motion ' + st.dimensions.motion.score.toFixed(3) + ', composite ' + st.composite.toFixed(3);
}).join('\n');
