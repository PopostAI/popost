import type { PreviewState } from '../../protocol';
import type { Selection } from '../model';
import { freeId, isObj, rawSpan, segmentsOf, targetOf, tracksOf, type Obj } from './source';

export interface SplitResult { source: Obj; select: Selection }
export const splitSource = (state: PreviewState, selection: Selection | null, frame: number): SplitResult | undefined => {
 const target = targetOf(state, selection), r = state.resolved;
 if (!target || !r || !isObj(state.source)) return undefined;
 const source = structuredClone(state.source);
 if (target.kind === 'segment') {
  const seg = r.segments[target.index];
  if (!seg || frame <= seg.start || frame >= seg.end) return undefined;
  const segments = segmentsOf(state).map(x => structuredClone(x));
  const original = segments[target.index]!; const cut = frame - seg.start;
  const id = freeId(segments, String(original.id));
  const base = isObj(original.base) ? original.base : {};
  const nextBase = { ...base };
  if (base.scene) nextBase.offset = Number(base.offset ?? 0) + cut / r.canvas.fps;
  if (base.material && seg.base.kind === 'video') nextBase.in = seg.base.play.in + Math.round(cut * (r.footage?.[seg.base.play.material]?.fps ?? r.canvas.fps) * seg.base.play.speed / r.canvas.fps);
  const second: Obj = { ...original, id, frames: seg.end-frame, base: nextBase }; delete second.in;
  // Spans with an implicit end must keep their previous absolute end after the first half becomes shorter.
  const explicit = (span: unknown): unknown => isObj(span) && span.segment === original.id && span.phrase === undefined && span.to === undefined ? { ...span, to: seg.end-seg.start } : span;
  source.tracks = tracksOf(state).map(t => ({ ...t, ...(t.during ? { during: explicit(t.during) } : {}), ...(Array.isArray(t.cues) ? { cues: t.cues.map(c => isObj(c) ? { ...c, during: explicit(c.during) } : c) } : {}) }));
  segments.splice(target.index, 1, { ...original, frames: cut }, second); source.segments = segments;
  return { source, select: { kind: 'segment', id } };
 }
 const track = structuredClone(target.track);
 const cue = target.kind === 'cue' && Array.isArray(track.cues) ? track.cues[target.cue] : undefined;
 const item = target.kind === 'cue' ? cue : track;
 if (!isObj(item)) return undefined;
 if(!isObj(item.during)&&track.type==='audio'){const audio=r.audio.find(a=>a.id===track.id);if(audio)item.during={segment:r.segments[0]?.id,from:audio.start,to:audio.end??r.frames};}
 if(!isObj(item.during))return undefined;
 const span = rawSpan(r, item.during);
 if (!span || frame <= span.start || frame >= span.end) return undefined;
 const during = item.during;
 const left: Obj = { ...item, during: { ...during, to: frame-span.segment.start } };
 const right: Obj = { ...item, during: { ...during, from: frame-span.segment.start } };
 const tracks = tracksOf(state).map(x => structuredClone(x));
 if (target.kind === 'cue') {
  (track.cues as Obj[]).splice(target.cue,1,left,right); tracks[target.index]=track; source.tracks=tracks;
  return { source, select: { kind: 'item', id: String(track.id)+'#'+(target.cue+1) } };
 }
 const id = freeId(tracks, String(track.id)); right.id=id;
 if (track.type === 'video') {
  const resolved = r.items.find(it => it.id === track.id);
  if (resolved) right.in = Number(track.in ?? 0) + Math.round((frame-span.start) * Number(r.footage?.[resolved.play?.material ?? '']?.fps ?? r.canvas.fps) * Number(track.speed ?? 1) / r.canvas.fps);
 }
 if (track.type === 'audio') right.in = Number(track.in ?? 0) + Math.round((frame-span.start)*(track.bed?(r.footage?.[String(track.material)]?.fps??r.canvas.fps)/r.canvas.fps:1));
 delete left.exit; delete right.enter;
 tracks.splice(target.index,1,left,right);source.tracks=tracks;
 return { source, select: { kind: track.type === 'audio' ? 'audio' : 'item', id } };
};
