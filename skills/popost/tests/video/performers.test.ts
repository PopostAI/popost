import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { castImages, completeCast, readCast } from '../../src/video/generate/cast';
import { checkRequests, makeMaterials } from '../../src/video/generate/index';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { checkSpeechLocks } from '../../src/video/generate/speech-lock';
import { sha256 } from '../../src/core/util';
import type { Resolved } from '../../src/video/types';
import { tinyPng } from '../image-helpers';

const rt=await createDiskRuntime();afterAll(()=>rt.cleanup());
const ffmpeg=await hasFfmpeg(rt);
const project=async(name:string,roles:unknown[])=>{const dir=rt.path.join(rt.cwd,name);await rt.fs.writeFile(rt.path.join(dir,'cast.json'),JSON.stringify({version:1,roles}));return dir;};
describe('identity policy across genres',()=>{
 it('defines a new single-appearance person without an image job but requires a shared image for recurring roles',async()=>{
  const dir=await project('single',[{id:'host',description:'A fictional presenter in round glasses'}]);
  expect((await castImages(rt,dir,['host'])).images).toEqual([]);
  await expect(castImages(rt,dir,['host'],new Map([['host',2]]))).rejects.toThrow('Recurring');
  const image=rt.path.join(dir,'generated.png');await rt.fs.writeFile(image,tinyPng([180,140,120]));
  await completeCast(rt,dir,'host',image,'host-image-tool');
  expect((await castImages(rt,dir,['host'],new Map([['host',2]]))).images).toEqual(['assets/cast/host.png']);
  await rt.fs.writeFile(rt.path.join(dir,'assets/cast/host.png'),new Uint8Array([4]));
  await expect(castImages(rt,dir,['host'])).rejects.toThrow('changed');
 });
 it('requires a same-person selection rather than a legacy format instruction',async()=>{
  const dir=await project('reference',[{id:'host',description:'A presenter',identity:'reference'}]);
  await expect(readCast(rt,dir)).rejects.toThrow('explicit instruction');
  for(const permission of ['Keep the presenter and avatar window in the same place.','Keep the male host on screen with the demonstrations.','Use the same person from my reference.']) {
   const legacy=await project('legacy-'+permission.length,[{id:'host',description:'A presenter',identity:'reference',permission}]);
   await expect(readCast(rt,legacy)).rejects.toThrow('Legacy permission text alone');
  }
  const selected=await project('selected',[{id:'host',description:'My selected presenter',identity:'reference',referenceSelection:'same-person',permission:'Use the same person from my reference.'}]);
  expect((await readCast(rt,selected)).roles[0]?.identity).toBe('reference');
  const supplied=await project('supplied',[{id:'host',description:'My supplied character',identity:'user'}]);
  expect((await readCast(rt,supplied)).roles[0]?.identity).toBe('user');
  const misplaced=await project('misplaced',[{id:'host',description:'A new presenter',identity:'new',referenceSelection:'same-person'}]);
  await expect(readCast(rt,misplaced)).rejects.toThrow('Remove it');
 });
 it('counts generated clips rather than timeline cuts when deciding whether an image is necessary',async()=>{
  const multi=await project('multi',[{id:'host',description:'A fictional presenter',shots:['intro','outro']}]);
  await expect(castImages(rt,multi,['host'])).rejects.toThrow('Recurring');
  const direct=await castImages(rt,multi,['host'],new Map([['host',1]]));
  expect(direct.images).toEqual([]);
  expect(direct.instruction).toContain('original facial proportions');
  await expect(castImages(rt,multi,['host'],new Map([['host',2]]))).rejects.toThrow('Recurring');
 });
 it('blocks unclassified visible people and raw creator footage while allowing a person-free scene',async()=>{
  const dir=await project('requests',[]);
  expect(await checkRequests(rt,[{file:'assets/a.mp4',prompt:'A woman demonstrates a tool'}],dir)).toEqual(expect.arrayContaining([expect.objectContaining({at:'[0].cast'})]));
  await rt.fs.writeFile(rt.path.join(dir,'reference.mp4'),new Uint8Array([1]));
  const wrong=await checkRequests(rt,[{file:'assets/a.mp4',prompt:'A presenter',cast:['host'],videos:['reference.mp4']}],dir);
  expect(wrong.some(p=>p.at==='[0].videos')).toBe(true);
  expect(await checkRequests(rt,[{file:'assets/a.mp4',prompt:'A tool on a desk',cast:[]}],dir)).toEqual([]);
 });
});
describe('visible speech source-time lock',()=>{
 it.skipIf(!ffmpeg)('publishes native audio with a readable final receipt and reuses the verified clip without another generation',async()=>{
  const dir=await project('native-publication',[{id:'host',description:'A fictional presenter'}]);
  const sample=rt.path.join(dir,'sample.mp4');
  await runFfmpegOk(rt,['-y','-loglevel','error','-f','lavfi','-i','color=gray:size=64x64:rate=24:duration=0.5','-f','lavfi','-i','sine=frequency=440:duration=0.5','-c:v','libx264','-c:a','aac',sample]);
  let calls=0;
  const generator={make:async(_kind:unknown,_request:unknown,out:string)=>{calls++;await rt.fs.writeFile(out,await rt.fs.readFile(sample));return{credits:7};}};
  const requests=[{file:'assets/host.mp4',prompt:'A presenter',cast:['host'],seconds:1,speech:{mode:'native' as const,speaker:'host',text:'Example'}}];
  const first=await makeMaterials(rt,{dir,requests,generator});
  expect(first.materials[0]).toMatchObject({made:true,credits:7});
  const receipt=JSON.parse(await rt.fs.readText(rt.path.join(dir,'assets/host.mp4.speech.json'))) as {audio:string;audioSha256:string};
  expect(sha256(await rt.fs.readFile(rt.path.join(dir,'assets',receipt.audio)))).toBe(receipt.audioSha256);
  expect((await makeMaterials(rt,{dir,requests,generator})).materials[0]?.made).toBe(false);
  expect(calls).toBe(1);
 });
 it('rejects independent replacement, source offset and speed drift',async()=>{
  const dir=rt.path.join(rt.cwd,'speech'),file=rt.path.join(dir,'speaker.mp4'),bytes=new Uint8Array([1,2,3]);
  await rt.fs.writeFile(file,bytes);await rt.fs.writeFile(file+'.speech.json',JSON.stringify({videoSha256:sha256(bytes)}));
  const r:Resolved={canvas:{width:180,height:320,fps:30},frames:60,segments:[{id:'a',index:0,start:0,end:60,base:{kind:'video',play:{material:'v',start:0,in:0,speed:1},fit:'cover',zoom:1,pan:[0,0]}}],items:[],footage:{v:{src:'speaker.mp4',fps:30,frames:60}},audio:[{id:'voice',src:'speaker.mp4',start:0,end:60,gain:0}]};
  expect(await checkSpeechLocks(rt,dir,r)).toEqual([]);
  for(const audio of [[],[{...r.audio[0]!,src:'different.wav'}],[{...r.audio[0]!,from:{frame:10,fps:30}}],[{...r.audio[0]!,speed:1.1}]])expect((await checkSpeechLocks(rt,dir,{...r,audio})).some(p=>p.level==='error')).toBe(true);
  await rt.fs.writeFile(file,new Uint8Array([9]));
  expect((await checkSpeechLocks(rt,dir,r))[0]?.message).toContain('changed');
 });
});
