/**
 * The sound cues of a project's scenes, in the project's time. A scene declares where its sounds belong
 * (page/contract.ts, SceneCue): the Skill's motion helper adds a cue for every effect to window.__popostScene.cues,
 * and a scene can write them as JSON in <script type="application/json" id="popost-cues">. Here every scene of the
 * project is opened (no frame is rendered), its cues are read and moved to the time of its segment, so that whoever
 * places sound effects has one list: at which second of the video, which kind of sound, how loud against the others.
 * Without a browser only the cues written as JSON are read, and the result says so.
 */
import type { Runtime } from '../../runtime';
import { BrowserUnavailableError } from '../../render/browser';
import { buildPage } from '../compile/index';
import type { SceneCue } from '../page/contract';
import { openSession } from '../render/session';
import type { Problem } from '../types';
import { sceneSegments } from './check';

export interface ProjectCue {
  /** Seconds and frame of the project. */
  at: number;
  frame: number;
  cue: string;
  gain: number;
  effect?: string;
  /** The segment (its id) and the scene file it comes from, and its time inside the scene. */
  segment: string;
  scene: string;
  local: number;
}

export interface CueRead {
  cues: ProjectCue[];
  scenes: { segment: string; scene: string; seconds: [number, number]; cues: number; dropped: number }[];
  problems: Problem[];
  /** 'page': read from the opened scenes; 'static': only the JSON blocks were read (no browser). */
  from: 'page' | 'static';
}

const BLOCK = /<script\b[^>]*\bid\s*=\s*["']popost-cues["'][^>]*>([\s\S]*?)<\/script>/i;

/** The cues a scene's source writes as JSON (the static half of the contract). */
export const writtenCues = (html: string): SceneCue[] => {
  const text = BLOCK.exec(html)?.[1];
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.flatMap((c: { at?: unknown; cue?: unknown; gain?: unknown; effect?: unknown }) =>
      (c && typeof c.at === 'number' && typeof c.cue === 'string' ? [{ at: c.at, cue: c.cue, gain: typeof c.gain === 'number' ? c.gain : 0.7, ...(typeof c.effect === 'string' ? { effect: c.effect } : {}) }] : [])) : [];
  } catch { return []; }
};

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Every scene's cues in project time. projectDir: as the user typed it. */
export const readCues = async (rt: Runtime, projectDir: string): Promise<CueRead> => {
  const built = await buildPage(rt, projectDir);
  if (built.problems.some((p) => p.level === 'error') || !built.resolved) return { cues: [], scenes: [], problems: built.problems, from: 'static' };
  const resolved = built.resolved, fps = resolved.canvas.fps;
  const wanted = sceneSegments(resolved);
  const root = rt.path.resolve(rt.cwd, projectDir);
  const perScene = new Map<number, SceneCue[]>();
  let from: CueRead['from'] = 'page';
  const session = wanted.length ? await openSession(rt, projectDir, { reuse: false }).catch((e: unknown) => { if (e instanceof BrowserUnavailableError) return undefined; throw e; }) : undefined;
  if (session) {
    try {
      for (const s of wanted) perScene.set(s.k, (await session.scenes({ frame: s.start, segment: s.k }))[0]?.cues ?? []);
    } finally { await session.close(); }
  } else {
    from = 'static';
    for (const s of wanted) perScene.set(s.k, writtenCues(await rt.fs.readText(rt.path.join(root, s.src)).catch(() => '')));
  }
  const cues: ProjectCue[] = [], scenes: CueRead['scenes'] = [];
  for (const s of wanted) {
    const id = resolved.segments[s.k]?.id ?? String(s.k), length = (s.end - s.start) / fps;
    const mine = perScene.get(s.k) ?? [];
    // A cue after the end of its segment belongs to a longer copy of the scene: it is left out and counted.
    const kept = mine.filter((c) => c.at < length);
    for (const c of kept) cues.push({ at: r3(s.start / fps + c.at), frame: s.start + Math.round(c.at * fps), cue: c.cue, gain: c.gain, ...(c.effect ? { effect: c.effect } : {}), segment: id, scene: s.src, local: c.at });
    scenes.push({ segment: id, scene: s.src, seconds: [r3(s.start / fps), r3(s.end / fps)], cues: kept.length, dropped: mine.length - kept.length });
  }
  cues.sort((a, b) => a.at - b.at);
  return { cues, scenes, problems: built.problems, from };
};
