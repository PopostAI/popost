import type { PreviewState } from '../../protocol';
import { freeId, isObj, segmentsOf, tracksOf, type Obj } from './source';

/** Duplicate the scene and its owned overlays together, without copying a timeline-wide soundtrack. */
export const duplicateScene = (state: PreviewState, index: number): { source: Obj; id: string } | undefined => {
  if (!isObj(state.source)) return undefined;
  const segments = segmentsOf(state), original = segments[index];
  if (!original) return undefined;
  const id = freeId(segments,String(original.id));
  const tracks = tracksOf(state).map(t=>structuredClone(t));
  const during = (value: unknown): unknown => isObj(value) && value.segment === original.id ? {...value,segment:id} : value;
  for (const track of tracksOf(state)) {
    const cues = Array.isArray(track.cues) ? track.cues.filter(c=>isObj(c)&&isObj(c.during)&&c.during.segment===original.id) : [];
    if (!cues.length && (!isObj(track.during) || track.during.segment !== original.id)) continue;
    const copy = { ...structuredClone(track), id:freeId(tracks,String(track.id)),
      ...(track.during ? {during:during(track.during)} : {}),
      ...(cues.length ? {cues:cues.map(c=>({...c as Obj,during:during((c as Obj).during)}))} : {}) };
    tracks.push(copy);
  }
  const next = segments.map(s=>structuredClone(s));
  next.splice(index+1,0,{...structuredClone(original),id});
  return {source:{...state.source,segments:next,tracks},id};
};
