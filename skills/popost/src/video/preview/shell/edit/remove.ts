import type { PreviewState } from '../../protocol';
import { freeId, isObj, rawSpan, segmentsOf, tracksOf, type Obj } from './source';

/** Ripple-delete a scene in one source revision, preserving the remaining media's source clocks. */
export const removeScene = (state:PreviewState,index:number):Obj|undefined=>{
 const r=state.resolved,segments=segmentsOf(state),deleted=r?.segments[index];
 if(!r||!deleted||segments.length<2||!isObj(state.source))return undefined;
 const source=structuredClone(state.source),remaining=segments.filter((_,i)=>i!==index);
 const length=deleted.end-deleted.start,anchor=String(remaining[0]!.id);
 const shift=(frame:number):number=>frame<=deleted.start?frame:frame>=deleted.end?frame-length:deleted.start;
 const during=(a:number,b:number):Obj=>({segment:anchor,from:shift(a),to:shift(b)});
 const used=tracksOf(state),out:Obj[]=[];
 for(const original of used){
  const track=structuredClone(original);
  if(track.type==='caption'&&Array.isArray(track.cues)){
   const cues=track.cues.flatMap((value,i)=>{
    if(!isObj(value))return [];
    const item=r.items.find(x=>x.cue?.track===track.id&&x.cue?.index===i);
    if(!item||shift(item.end)<=shift(item.start))return [];
    return [{...value,during:during(item.start,item.end)}];
   });
   if(cues.length)out.push({...track,cues});continue;
  }
  const item=track.type==='audio'?r.audio.find(x=>x.id===track.id):r.items.find(x=>x.id===track.id);
  const raw=rawSpan(r,track.during);
  const start=item?.start??raw?.start??0,end=item?.end??raw?.end??r.frames;
  if(shift(end)<=shift(start))continue;
  const media=track.type==='audio'||track.type==='video';
  const pieces=media&&start<deleted.start&&end>deleted.end?[[start,deleted.start],[deleted.end,end]]:[[start<deleted.end&&start>=deleted.start?deleted.end:start,end>deleted.start&&end<=deleted.end?deleted.start:end]];
  for(const [a,b] of pieces){
   if(a===undefined||b===undefined||b<=a)continue;
   const value:Obj={...track,during:during(a,b)};
   if(out.some(x=>x.id===value.id))value.id=freeId([...used,...out],String(value.id));
   if(media&&a>start){
    const play=track.type==='video'?r.items.find(x=>x.id===track.id)?.play:undefined;
    const rate=play?(r.footage?.[play.material]?.fps??r.canvas.fps)/r.canvas.fps*play.speed:track.bed?(r.footage?.[String(track.material)]?.fps??r.canvas.fps)/r.canvas.fps:1;
    value.in=Number(track.in??0)+Math.round((a-start)*rate);
   }
   if(a>start)delete value.enter;if(b<end)delete value.exit;out.push(value);
  }
 }
 source.segments=remaining;source.tracks=out;return source;
};
