import { parseProject } from '../../project/schema';
import { transitionFrames, type TransitionName } from '../../presets/transition';
import { framesUsed } from '../../project/check-transition';
import type { MotionSpec, TransitionSpec } from '../../types';
import { resolveMotion } from '../../timeline/items';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.map(obj) : [];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const fitMotion = (track: Obj, length: number, fps: number): Obj => {
  const enter = resolveMotion(track.enter as MotionSpec | undefined, 'enter', fps).frames;
  const exit = resolveMotion(track.exit as MotionSpec | undefined, 'exit', fps).frames;
  if (enter + exit <= length || length < 1) return track;
  const a = Math.floor(length * enter / (enter + exit));
  const b = length - a;
  const phase = (key: 'enter' | 'exit', frames: number): Obj => frames > 0 ? { ...obj(track[key]), frames } : { preset: 'none' };
  return { ...track, ...(enter ? { enter: phase('enter', a) } : {}), ...(exit ? { exit: phase('exit', b) } : {}) };
};

const fitTransitions = (segments: Obj[], fps: number, reordered: boolean): Obj[] => {
  const out = segments.map((segment,index) => {
    const tr = obj(segment.in); if (!Object.keys(tr).length || tr.transition === 'cut') return segment;
    if (index === 0) return reordered ? Object.fromEntries(Object.entries(segment).filter(([key])=>key!=='in')) : segment;
    const side = tr.side ?? 'both';
    const cap = side === 'after' ? Number(segment.frames) : side === 'before' ? Number(segments[index-1]!.frames) : Math.min(Number(segment.frames),Number(segments[index-1]!.frames));
    const frames = Number(tr.frames ?? transitionFrames(tr.transition as TransitionName,fps));
    return frames <= cap ? segment : {...segment,in:{...tr,frames:cap}};
  });
  for (let j=0;j<out.length;j++) {
    const current=out[j]!, next=out[j+1];
    const into=framesUsed(current.in as TransitionSpec|undefined,fps,'into');
    const exit=framesUsed(next?.in as TransitionSpec|undefined,fps,'out');
    if(into+exit<=Number(current.frames))continue;
    const scale=Number(current.frames)/(into+exit);
    for(const index of [j,j+1]) {
      const segment=out[index];if(!segment)continue;
      const tr=obj(segment.in);if(!tr.transition||tr.transition==='cut')continue;
      const frames=Math.floor(Number(tr.frames??transitionFrames(tr.transition as TransitionName,fps))*scale);
      out[index]={...segment,in:frames>0?{...tr,frames}:{transition:'cut'}};
    }
  }
  return out;
};

/** Retiming keeps scene-local content in its scene; explicit spans crossing scenes keep that intent. */
export const retimeSource = (before: unknown, after: unknown): unknown => {
  if (!parseProject(after).project) return after;
  const old = obj(before), next = obj(after);
  const ordered = rows(next.segments);
  const reordered = !same(ordered.map(s=>s.id),rows(old.segments).map(s=>s.id));
  const fps = Number(obj(next.canvas).fps ?? 30);
  const previous = new Map(rows(old.segments).map(s => [s.id, s]));
  const shortened = new Map(ordered.filter(s => Number(s.frames) < Number(previous.get(s.id)?.frames)).map(s => [s.id, s]));
  const segments = shortened.size || reordered ? fitTransitions(ordered,fps,reordered) : ordered;
  const tracks = rows(next.tracks);
  const originals = new Map(rows(old.tracks).map(t => [t.id, t]));
  const changed = shortened.size > 0 || reordered || tracks.some(t => !same(t.during, originals.get(t.id)?.during) || !same(t.cues, originals.get(t.id)?.cues));
  if (!changed) return after;
  const starts = new Map<unknown, number>(); let total = 0;
  for (const s of segments) { starts.set(s.id, total); total += Number(s.frames); }
  const adapt = (value: unknown): unknown => {
    const span = obj(value), s = shortened.get(span.segment), prior = previous.get(span.segment);
    if (!s || !prior || span.phrase !== undefined) return value;
    const end = Number(s.frames);
    return { ...span, ...(typeof span.from === 'number' && span.from >= end ? { from: end - 1 } : {}),
      ...(typeof span.to === 'number' && span.to <= Number(prior.frames) && span.to > end ? { to: end } : {}) };
  };
  const lengthOf = (value: unknown): number | undefined => {
    const span = obj(value), start = starts.get(span.segment);
    const s = segments.find(s => s.id === span.segment);
    if (start === undefined || !s || span.phrase !== undefined) return undefined;
    return Math.max(1, Math.min(total, start + Number(span.to ?? s.frames)) - Math.max(0, start + Number(span.from ?? 0)));
  };
  return { ...next, segments, tracks: tracks.map(track => {
    const prior = originals.get(track.id);
    const cues = Array.isArray(track.cues) ? rows(track.cues).map(c => ({ ...c, during: adapt(c.during) })) : undefined;
    const position = (c: Obj): number | undefined => {const span=obj(c.during),start=starts.get(span.segment);return start===undefined||span.phrase!==undefined?undefined:start+Number(span.from??0);};
    if (reordered && cues?.every(c=>position(c)!==undefined)) cues.sort((a,b)=>position(a)!-position(b)!);
    const during = track.during ? adapt(track.during) : undefined;
    const adjusted = { ...track, ...(during ? { during } : {}), ...(cues ? { cues } : {}) };
    if (track.type === 'audio') return adjusted;
    const affected = (value: unknown): boolean => shortened.has(obj(value).segment);
    if (!affected(track.during) && !cues?.some(c => affected(c.during)) && same(track.during, prior?.during) && same(track.cues, prior?.cues)) return adjusted;
    const lengths = (cues ? cues.map(c => lengthOf(c.during)) : [lengthOf(during)]).filter((n): n is number => n !== undefined);
    return lengths.length ? fitMotion(adjusted, Math.min(...lengths), fps) : adjusted;
  }) };
};
