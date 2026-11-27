import type { PreviewState } from '../../protocol';
import { isObj, tracksOf, type Obj, type Target } from './source';

/** Assign explicit stacking ranks so moving a layer also works for sources that already use z values. */
export const reorderLayer = (state: PreviewState, target: Target, delta: number): Obj | undefined => {
  if (target.kind === 'segment' || target.track.type === 'audio' || !isObj(state.source)) return undefined;
  const tracks = tracksOf(state);
  const visual = tracks.map((track,index)=>({track,index})).filter(x=>x.track.type!=='audio')
    .sort((a,b)=>Number(a.track.z??a.index)-Number(b.track.z??b.index)||a.index-b.index);
  const selected=state.resolved?.items.filter(it=>it.id===target.track.id||it.cue?.track===target.track.id)??[];
  const visible=new Set((state.resolved?.items??[]).filter(it=>selected.some(s=>s.start<it.end&&s.end>it.start)).map(it=>it.cue?.track??it.id));
  const local=visual.filter(x=>visible.has(String(x.track.id)));
  const localIndex=local.findIndex(x=>x.index===target.index);
  const neighbor=local[localIndex+delta];
  if(!neighbor)return undefined;
  const from=visual.findIndex(x=>x.index===target.index), to=visual.indexOf(neighbor);
  if(from<0||to<0||to>=visual.length)return undefined;
  const moved=visual.splice(from,1)[0]!;visual.splice(to,0,moved);
  const rank=new Map(visual.map((x,index)=>[x.index,index]));
  return {...state.source,tracks:tracks.map((track,index)=>rank.has(index)?{...track,z:rank.get(index)}:track)};
};
