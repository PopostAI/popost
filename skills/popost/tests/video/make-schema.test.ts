import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiskRuntime, type DiskRuntime } from '../../src/testing/disk';
import type { Problem, Project, Segment, TextTrack } from '../../src/video/types';
import { parseProject } from '../../src/video/project/schema';
import { checkProject, readProjectFiles } from '../../src/video/project/check';
import { resolve } from '../../src/video/timeline/resolve';
import { goodProject, variant } from './make-fixtures';

const complete = (p: Problem): void => {
  expect(p.at.length, JSON.stringify(p)).toBeGreaterThan(0);
  expect(p.message.length, JSON.stringify(p)).toBeGreaterThan(0);
  expect(p.fix?.length ?? 0, JSON.stringify(p)).toBeGreaterThan(0);
};

/** The problems of a raw JSON value: schema problems, then (when it parses) check problems. */
const problemsOf = (json: unknown): Problem[] => {
  const parsed = parseProject(json);
  const all = parsed.project ? [...parsed.problems, ...checkProject(parsed.project)] : parsed.problems;
  all.forEach(complete);
  return all;
};

/** The same, with the files of the project in dir read first. */
const problemsOnDisk = async (rt: DiskRuntime, json: unknown, dir: string): Promise<Problem[]> => {
  const parsed = parseProject(json);
  const all = parsed.project ? [...parsed.problems, ...checkProject(parsed.project, { files: await readProjectFiles(rt, parsed.project, dir) })] : parsed.problems;
  all.forEach(complete);
  return all;
};

const find = (problems: Problem[], at: string, level: Problem['level'] = 'error'): Problem => {
  const p = problems.find((x) => x.at === at && x.level === level);
  if (!p) throw new Error('No ' + level + ' at ' + at + ' among: ' + JSON.stringify(problems, null, 1));
  return p;
};

const raw = (change: (p: Record<string, unknown>) => void): unknown => {
  const p = structuredClone(goodProject()) as unknown as Record<string, unknown>;
  change(p);
  return p;
};
const seg = (p: Project, k: number): Segment => p.segments[k] as Segment;
const text = (p: Project): TextTrack => p.tracks[0] as TextTrack;

describe('parseProject and checkProject', () => {
  it('accepts the good project without any problem', () => {
    const parsed = parseProject(goodProject());
    expect(parsed.problems).toEqual([]);
    expect(parsed.project).toBeDefined();
    expect(checkProject(parsed.project as Project)).toEqual([]);
  });

  it('reports schema errors with a path, the allowed values and a fix', () => {
    const enumP = find(problemsOf(raw((p) => { (p.segments as Record<string, unknown>[])[2] = { id: 'detail', frames: 30, base: { color: '#fff' }, in: { transition: 'slid' } }; })), 'segments[2].in.transition');
    expect(enumP.allowed).toContain('slide');
    expect(enumP.fix).toContain('"slide"');
    find(problemsOf(raw((p) => { p.canvas = { width: 1080, height: 1920 }; })), 'canvas.fps');
    expect(find(problemsOf(raw((p) => { (p.tracks as Record<string, unknown>[])[0] = { ...((p.tracks as object[])[0]), box: [0, 0, 1] }; })), 'tracks[0].box').message).toContain('[x, y, width, height]');
    expect(find(problemsOf(raw((p) => { (p.tracks as Record<string, unknown>[])[0] = { id: 'x', type: 'txt' }; })), 'tracks[0].type').allowed).toEqual(['text', 'image', 'shape', 'video', 'audio', 'caption']);
    expect(find(problemsOf(raw((p) => { (p.segments as Record<string, unknown>[])[1] = { id: 'proof', frames: 30, base: { color: '#000', material: 'desk' } }; })), 'segments[1].base').allowed).toEqual(['material', 'color', 'scene']);
    find(problemsOf(raw((p) => { (p.segments as Record<string, unknown>[])[1] = { id: 'proof', frames: 30, base: { color: 'blu' } }; })), 'segments[1].base.color');
    expect(find(problemsOf(raw((p) => { (p.tracks as Record<string, unknown>[])[0] = { ...((p.tracks as object[])[0]), style: 'headlin' }; })), 'tracks[0].style').fix).toContain('"headline"');
    find(problemsOf(raw((p) => { (p.tracks as Record<string, unknown>[])[0] = { ...((p.tracks as object[])[0]), style: { size: 'big' } }; })), 'tracks[0].style.size');
    find(problemsOf(raw((p) => { p.version = 2; })), 'version');
    find(problemsOf(raw((p) => { p.segments = []; })), 'segments');
    find(problemsOf(42), '(root)');
  });

  it('warns about unknown fields and suggests the field that was meant', () => {
    const problems = problemsOf(raw((p) => { (p.tracks as Record<string, unknown>[])[1] = { ...((p.tracks as object[])[1]), enter: { preset: 'slide', dirction: 'left' } }; }));
    const w = find(problems, 'tracks[1].enter.dirction', 'warning');
    expect(w.fix).toContain('"direction"');
    expect(parseProject(raw((p) => { p.duck = true; })).project).toBeDefined();
  });

  it('reports duplicate ids and broken references with the existing ids', () => {
    find(problemsOf(variant((p) => { seg(p, 1).id = 'hook'; })), 'segments[1].id');
    find(problemsOf(variant((p) => { (p.materials[1] as { id: string }).id = 'desk'; })), 'materials[1].id');
    const span = find(problemsOf(variant((p) => { text(p).during.segment = 'hoook'; })), 'tracks[0].during.segment');
    expect(span.allowed).toEqual(['hook', 'proof', 'detail', 'end']);
    const base = find(problemsOf(variant((p) => { seg(p, 0).base = { material: 'nope' }; })), 'segments[0].base.material');
    expect(base.allowed).toEqual(['desk', 'logo']);
    expect(find(problemsOf(variant((p) => { text(p).sound = 'desk'; })), 'tracks[0].sound').allowed).toEqual(['pop', 'music']);
  });

  it('reports timeline errors: first transition, missing length, long transition, empty and outside spans', () => {
    find(problemsOf(variant((p) => { seg(p, 0).in = { transition: 'fade' }; })), 'segments[0].in');
    expect(find(problemsOf(variant((p) => { delete seg(p, 1).frames; })), 'segments[1].frames').message).toContain('no speech');
    expect(find(problemsOf(variant((p) => { seg(p, 2).in = { transition: 'slide', frames: 31 }; })), 'segments[2].in.frames').fix).toContain('at most 30');
    expect(find(problemsOf(variant((p) => { seg(p, 1).frames = 5; seg(p, 2).in = { transition: 'wipe' }; })), 'segments[2].in').message).toContain('default');
    find(problemsOf(variant((p) => { text(p).during = { segment: 'hook', from: 10, to: 10 }; })), 'tracks[0].during');
    expect(find(problemsOf(variant((p) => { text(p).during = { segment: 'end', from: 40, to: 50 }; })), 'tracks[0].during').message).toContain('outside');
    find(problemsOf(variant((p) => { text(p).enter = { preset: 'pop', frames: 20 }; text(p).exit = { preset: 'fade', frames: 10 }; })), 'tracks[0].enter');
    expect(find(problemsOf(variant((p) => { seg(p, 2).in = { transition: 'slide', direction: 'center-out' }; })), 'segments[2].in.direction').allowed).toEqual(['left', 'right', 'up', 'down']);
  });

  it('reports what this version cannot do: phrases without a words file, a scene that is not an HTML file, typing a shape; and materials of the wrong kind', () => {
    const phrase = find(problemsOf(variant((p) => { text(p).during = { segment: 'hook', phrase: 'two weeks' }; })), 'tracks[0].during.phrase');
    expect(phrase.message).toBe('Item "claim" is anchored to the phrase "two weeks", but phrase anchors need a sound with a words file: no audio track plays a material with "words".');
    // A scene base is an HTML file of the project (tests/make-scene.test.ts renders one).
    expect(problemsOf(variant((p) => { seg(p, 1).base = { scene: 'scenes/a.html' }; })).filter((x) => x.at.startsWith('segments[1].base'))).toEqual([]);
    expect(find(problemsOf(variant((p) => { seg(p, 1).base = { scene: 'scenes/a.png' }; })), 'segments[1].base.scene').message).toContain('is not an HTML file');
    expect(find(problemsOf(variant((p) => { p.materials.push({ id: 'clip', kind: 'video', file: 'a.mp4' }); p.tracks.push({ id: 'img', type: 'image', material: 'clip', box: [0, 0, 1, 1], during: { segment: 'hook' } }); })), 'tracks[4].material').message).toContain('"clip" is a video material');
    find(problemsOf(variant((p) => { p.tracks.push({ id: 'img', type: 'image', material: 'pop', box: [0, 0, 1, 1], during: { segment: 'hook' } }); })), 'tracks[4].material');
    find(problemsOf(variant((p) => { p.tracks.push({ id: 'bgm2', type: 'audio', material: 'desk' }); })), 'tracks[4].material');
    find(problemsOf(variant((p) => { p.tracks[1] = { ...(p.tracks[1] as object), enter: { preset: 'type' } } as Project['tracks'][number]; })), 'tracks[1].enter.preset');
    find(problemsOf(variant((p) => { delete (p.materials[0] as { file?: string }).file; })), 'segments[0].base.material');
  });

  it('warns about boxes outside the canvas, small text and odd canvas sizes', () => {
    find(problemsOf(variant((p) => { text(p).box = [0.5, 0.1, 0.8, 0.1]; })), 'tracks[0].box', 'warning');
    expect(find(problemsOf(variant((p) => { text(p).style = { size: 0.015 }; })), 'tracks[0].style.size', 'warning').message).toContain('2.2%');
    find(problemsOf(variant((p) => { p.canvas.width = 1081; })), 'canvas', 'warning');
  });

  describe('with a project directory', () => {
    let dir = '';
    let rt: DiskRuntime;
    beforeAll(async () => {
      rt = await createDiskRuntime();
      dir = await mkdtemp(path.join(tmpdir(), 'make-schema-'));
      await mkdir(path.join(dir, 'assets'));
      await Promise.all(['desk.png', 'logo.png', 'pop.wav'].map((f) => writeFile(path.join(dir, 'assets', f), 'x')));
    });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); await rt.cleanup(); });

    it('reports material files that do not exist or lie outside the project', async () => {
      const problems = await problemsOnDisk(rt, goodProject(), dir);
      expect(find(problems, 'materials[3].file').message).toContain('does not exist');
      expect(problems.filter((p) => p.level === 'error')).toHaveLength(1);
      find(await problemsOnDisk(rt, variant((p) => { (p.materials[0] as { file: string }).file = '../desk.png'; }), dir), 'materials[0].file');
    });
  });

  it('resolve refuses a project that check rejects, naming the problem', () => {
    expect(() => resolve(variant((p) => { seg(p, 0).in = { transition: 'fade' }; }))).toThrow(/segments\[0\]\.in/);
  });
});
