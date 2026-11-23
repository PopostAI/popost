/**
 * Where a render of a project has the change into each reference shot: from its segments, not from measuring the
 * render again. A segment's number in its id (shot-03) names the reference shot it re-makes; else, when the counts are
 * equal, they pair in order. A transition leads into its segment from its first mixed frame; no transition is a cut
 * at the segment's start. Undefined when the project cannot say (the caller then maps by share of the length).
 */
import type { Project } from '../types';
import { resolveTransition } from '../timeline/resolve';
import { timelineOf } from '../timeline/spans';
import type { Window } from './shot-transition';

/** The video may last this many seconds more or less than the project's segments and still be its render. */
const RENDER_SLACK_S = 0.5;

const idNumber = (id: string): number | undefined => {
  const m = /^\D*(\d+)\D*$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

/** For each reference shot (index from 0) the first segment that re-makes it, or undefined. */
const firstSegments = (project: Pick<Project, 'segments'>, shots: number): (number | undefined)[] | undefined => {
  const nums = project.segments.map((s) => idNumber(s.id));
  const named = nums.filter((x): x is number => x !== undefined);
  if (named.length && named.every((x) => x >= 1 && x <= shots)) return Array.from({ length: shots }, (_, i) => { const k = nums.indexOf(i + 1); return k < 0 ? undefined : k; });
  return project.segments.length === shots ? project.segments.map((_s, k) => k) : undefined;
};

export const changeWindows = (project: Pick<Project, 'segments' | 'canvas'>, shots: number, videoSeconds: number): (Window | undefined)[] | undefined => {
  const fps = project.canvas?.fps;
  if (!(fps > 0) || !project.segments?.length || project.segments.some((s) => !(Number.isInteger(s.frames) && (s.frames as number) > 0))) return undefined;
  const tl = timelineOf(project);
  if (Math.abs(tl.total / fps - videoSeconds) > RENDER_SLACK_S) return undefined;
  const first = firstSegments(project, shots);
  if (!first) return undefined;
  return first.map((k) => {
    if (k === undefined || k === 0) return undefined;
    const t = resolveTransition(project.segments[k]?.in, tl.starts[k] as number, fps);
    const spec = project.segments[k]?.in;
    return t ? { from: t.a / fps, to: (t.a + t.frames) / fps, declared: { kind: t.kind, residual: 0, ...(spec?.direction ? { direction: spec.direction } : {}), ...(spec?.mode ? { mode: spec.mode } : {}), ...(spec?.via ? { via: spec.via } : {}) } } : { from: (tl.starts[k] as number) / fps, to: (tl.starts[k] as number) / fps };
  });
};
