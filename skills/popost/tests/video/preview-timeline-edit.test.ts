import {describe,expect,it} from 'vitest';
import type {Project} from '../../src/video/types';
import {resolve} from '../../src/video/timeline/resolve';
import type {PreviewState} from '../../src/video/preview/protocol';
import {splitSource} from '../../src/video/preview/shell/edit/split';
import {removeScene} from '../../src/video/preview/shell/edit/remove';
import {parseProject} from '../../src/video/project/schema';

const facts={clip:{width:320,height:180,fps:25,frames:300,hasAudio:false}};
const project=():Project=>({version:1,canvas:{width:320,height:180,fps:30},materials:[{id:'clip',kind:'video',file:'clip.mp4'},{id:'voice',kind:'audio',file:'voice.wav'}],segments:[{id:'a',frames:30,base:{color:'#111111'}},{id:'b',frames:30,base:{scene:'scene.html'}},{id:'c',frames:30,base:{color:'#222222'}}],tracks:[{id:'actor',type:'video',material:'clip',in:10,box:[0,0,1,1],during:{segment:'a',from:0,to:90}},{id:'voice',type:'audio',material:'voice'},{id:'captions',type:'caption',box:[0,.8,1,.1],cues:[{text:'Words',during:{segment:'a',from:10,to:80}}]}]});
const state=(source=project()):PreviewState=>({generation:1,project:{dir:'P',name:'Test'},source,resolved:resolve(source,facts),problems:[],measure:null,referenceMeasure:null,score:null,notes:null,reference:null,messages:[]});
const parsed=(value:unknown):Project=>{const result=parseProject(value);if(!result.project)throw Error(JSON.stringify(result.problems));return result.project;};

describe('timeline source edits',()=>{
 it('splits a video at the playhead without repeating its source frames',()=>{
  const result=splitSource(state(),{kind:'item',id:'actor'},30)!;
  const source=parsed(result.source),r=resolve(source,facts);
  expect(r.frames).toBe(90);expect(r.items.filter(x=>x.type==='video').map(x=>[x.start,x.end,x.play?.in])).toEqual([[0,30,10],[30,90,35]]);
 });
 it('splits an audio track that covers the whole timeline',()=>{
  const result=splitSource(state(),{kind:'audio',id:'voice'},45)!;
  const source=parsed(result.source),r=resolve(source,facts);
  expect(r.audio.map(a=>[a.start,a.end,a.from?.frame??0])).toEqual([[0,45,0],[45,90,45]]);
 });
 it('splits a caption into separately editable cues',()=>{
  const result=splitSource(state(),{kind:'item',id:'captions#0'},40)!;
  const r=resolve(parsed(result.source),facts);expect(r.items.filter(x=>x.cue).map(x=>[x.text,x.start,x.end])).toEqual([['Words',10,40],['Words',40,80]]);
 });
 it('preserves scene clock and implicit overlay end when splitting a scene',()=>{
  const p=project();p.tracks.push({id:'label',type:'text',text:'Label',box:[0,0,1,.1],during:{segment:'b'}});
  const result=splitSource(state(p),{kind:'segment',id:'b'},45)!;
  const r=resolve(parsed(result.source),facts);expect(r.frames).toBe(90);expect(r.segments[2]?.base).toMatchObject({kind:'scene',offset:.5});expect(r.items.find(x=>x.id==='label')).toMatchObject({start:30,end:60});
 });
 it('ripple-deletes a scene and closes the gap in audio, video and captions',()=>{
  const r=resolve(parsed(removeScene(state(),1)),facts);expect(r.frames).toBe(60);expect(r.segments.map(s=>s.id)).toEqual(['a','c']);expect(r.audio.map(a=>[a.start,a.end,a.from?.frame??0])).toEqual([[0,30,0],[30,60,60]]);expect(r.items.filter(x=>x.type==='video').map(x=>[x.start,x.end,x.play?.in])).toEqual([[0,30,10],[30,60,60]]);expect(r.items.find(x=>x.cue)).toMatchObject({start:10,end:50});
 });
 it('refuses a split at the ends and deletion of the last scene',()=>{
  expect(splitSource(state(),{kind:'item',id:'actor'},0)).toBeUndefined();expect(splitSource(state(),{kind:'item',id:'actor'},90)).toBeUndefined();const p=project();p.segments=p.segments.slice(0,1);p.tracks=[];expect(removeScene(state(p),0)).toBeUndefined();
 });
});
