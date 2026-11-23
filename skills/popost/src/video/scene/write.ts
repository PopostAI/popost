/**
 * A model writes the scene of every scene segment of a project, one shot at a time, from frames of the reference at
 * the segment's own time (author.ts writes one). Scenes not written yet get a placeholder first, so that the project
 * opens while the others are written; the first scene that passes is shown to the later ones, so that the video keeps
 * one look. Prints nothing: progress goes to onStep, the outcome is returned.
 */
import type { Runtime } from '../../runtime';
import type { Model } from '../plan/model';
import { checkProject } from '../project/check';
import { parseProject } from '../project/schema';
import { buildPage } from '../compile/index';
import { resolve } from '../timeline/resolve';
import type { Problem } from '../types';
import { writeScene, type SceneText, type WriteSceneResult } from './author';
import { sceneSegments } from './check';

/** What stands in for a scene that is not written yet, so that the project opens while the others are written. */
export const PLACEHOLDER = '<!doctype html><html><head><meta charset="utf-8"><!-- placeholder: scene write has not written this scene yet --><style>html,body{margin:0;width:100%;height:100%;background:#000}</style></head><body><div></div></body></html>\n';

export interface WriteScenesOptions {
  /** The project directory and the reference video, as the user typed them (against rt.cwd). */
  projectDir: string;
  reference: string;
  /** The customer's brief: the new subject. */
  brief: string;
  model: Model;
  /** Texts a reader found in the reference, in seconds of the reference. */
  texts?: SceneText[];
  /** Indexes (from 0) of the segments to write; the others keep their scene. Default: every scene segment. */
  only?: number[];
  /** Seconds of the reference where the project starts. Default 0. */
  offset?: number;
  attempts?: number;
  rounds?: number;
  /** Progress, for a person watching: the segment started, and each answer asked for. */
  onStep?: (what: string) => void;
}

export interface WrittenScene extends WriteSceneResult {
  /** Index of the segment (from 0). */
  segment: number;
}

export interface WriteScenesResult {
  /** The scenes written, in order. */
  scenes: WrittenScene[];
  /** The project's problems that kept anything from being written, or its errors once every scene passed. */
  problems: Problem[];
}

const exists = async (rt: Runtime, file: string): Promise<boolean> => (await rt.fs.stat(file)) !== null;

export const writeScenes = async (rt: Runtime, o: WriteScenesOptions): Promise<WriteScenesResult> => {
  const dir = rt.path.resolve(rt.cwd, o.projectDir);
  const parsed = parseProject(JSON.parse(await rt.fs.readText(rt.path.join(dir, 'video.json'))) as unknown);
  if (!parsed.project) return { scenes: [], problems: parsed.problems };
  // The scene files may not exist yet: the timeline is resolved from the project alone.
  const blocking = checkProject(parsed.project).filter((p) => p.level === 'error');
  if (blocking.length) return { scenes: [], problems: blocking };
  const r = resolve(parsed.project);
  const fps = r.canvas.fps;
  const offset = o.offset ?? 0;
  const library = (await exists(rt, rt.path.join(dir, 'lib', 'gsap.min.js'))) ? 'gsap' as const : undefined;
  const file = (src: string): string => rt.path.resolve(dir, src);
  // Every scene file must exist for the project to open: the ones still to come get a placeholder.
  for (const s of sceneSegments(r)) if (!(await exists(rt, file(s.src)))) await rt.fs.writeFile(file(s.src), PLACEHOLDER);
  let earlier: { file: string; html: string } | undefined;
  const scenes: WrittenScene[] = [];
  for (const s of sceneSegments(r)) {
    if (o.only && !o.only.includes(s.k)) {
      const html = await rt.fs.readText(file(s.src));
      if (!earlier && html !== PLACEHOLDER) earlier = { file: s.src, html };
      continue;
    }
    const from = s.start / fps + offset, to = s.end / fps + offset;
    const texts: SceneText[] = (o.texts ?? []).filter((t) => t.to > from && t.from < to).map((t) => ({ text: t.text, from: Math.max(0, t.from - from), to: Math.min(to, t.to) - from, box: t.box, ...(t.role ? { role: t.role } : {}) }));
    o.onStep?.('segment ' + (s.k + 1) + ' (' + s.src + ', ' + (to - from).toFixed(1) + ' s)');
    const result = await writeScene(rt, {
      projectDir: o.projectDir, segment: s.k, file: s.src, start: s.start, frames: s.end - s.start, canvas: r.canvas, reference: { video: o.reference, start: from, end: to }, brief: o.brief, model: o.model, texts,
      ...(library ? { library } : {}), ...(earlier ? { earlier } : {}), attempts: o.attempts ?? 3, rounds: o.rounds ?? 1,
      onStep: (what) => o.onStep?.('  ' + what + ' ...'),
    });
    scenes.push({ ...result, segment: s.k });
    if (result.passed && !earlier) earlier = { file: s.src, html: await rt.fs.readText(file(s.src)) };
  }
  if (scenes.some((s) => !s.passed)) return { scenes, problems: [] };
  const built = await buildPage(rt, o.projectDir);
  return { scenes, problems: built.problems.filter((p) => p.level === 'error') };
};
