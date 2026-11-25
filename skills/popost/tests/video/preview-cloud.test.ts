import {describe,expect,it} from 'vitest';
import {createTestRuntime} from '../../src/testing/memory';
import {resolve} from '../../src/video/timeline/resolve';
import type {PreviewState} from '../../src/video/preview/protocol';
import type {Project} from '../../src/video/types';
import {createVideoCloud,projectFiles} from '../../src/video/preview/cloud';
import {CloudService,type CloudProjectAdapter} from '../../src/cloud/service';
import type {CloudRecord} from '../../src/cloud/state';
import {settled} from '../cloud-helpers';

describe('video cloud serialization',()=>{
 it('collects only referenced media and recursive scene dependencies',async()=>{
  const rt=createTestRuntime({files:{'/work/P/assets/actor.mp4':'video','/work/P/scenes/a.html':'<link href="look.css"><img src="../assets/card.png"><script src="clock.js"></script>','/work/P/scenes/look.css':'body{background:url(../assets/bg.png)}','/work/P/scenes/clock.js':'/* scene */','/work/P/assets/card.png':'picture','/work/P/assets/bg.png':'background','/work/P/credentials.json':'private','/work/P/.studio/notes.json':'private'}});
  const files=await projectFiles(rt,'/work/P',{materials:[{file:'assets/actor.mp4'}],segments:[{base:{scene:'scenes/a.html'}}]});
  expect(files.map(f=>f.path)).toEqual(['assets/actor.mp4','assets/bg.png','assets/card.png','scenes/a.html','scenes/clock.js','scenes/look.css']);
 });
 it('refuses a scene dependency that escapes the project folder',async()=>{
  const rt=createTestRuntime({files:{'/work/P/a.html':'<img src="../private.png">','/work/private.png':'private'}});
  await expect(projectFiles(rt,'/work/P',{segments:[{base:{scene:'a.html'}}]})).rejects.toThrow('outside the project');
 });
 it('reuses the image editor authorization and keyed auto-save lifecycle with a video adapter',async()=>{
  const rt=createTestRuntime({env:{POPOST_API_KEY:'test-key'}});let revision='one',record:CloudRecord|null=null,pushes=0;
  const adapter:CloudProjectAdapter={info:async()=>({projectId:'project-video-01',title:'Video',pages:1}),record:async()=>record,revision:async()=>revision,push:async()=>{pushes++;record={projectId:'project-video-01',assets:{},deckId:'deck',webUrl:'https://popost.ai/zh/workspace/projects/deck',fingerprint:revision};}};
  const service=new CloudService(rt,()=>'/work/P',{project:adapter,debounceMs:1});service.autoStart();await settled(()=>pushes===1);expect((await service.status()).dirty).toBe(false);revision='two';service.scheduleAutoPush();await new Promise(r=>setTimeout(r,10));await settled(()=>pushes===2);expect((await service.status()).state).toBe('saved');service.dispose();
 });
 it('does not upload anonymous projects before authorization',async()=>{
  const rt=createTestRuntime();let pushes=0;const adapter:CloudProjectAdapter={info:async()=>({projectId:'project-video-01',title:'Video',pages:1}),record:async()=>null,revision:async()=>'one',push:async()=>{pushes++;}};
  const service=new CloudService(rt,()=>'/work/P',{project:adapter});service.autoStart();service.scheduleAutoPush();expect((await service.status()).mode).toBe('anonymous');const flow=await service.start('zh',4317);expect(new URL(flow.authorizeUrl).searchParams.get('project')).toBe('project-video-01');expect(pushes).toBe(0);expect(service.callback('wrong','wrong').ok).toBe(false);service.dispose();
 });
 it('syncs the real video adapter, preserves source and reuses media after a text edit without persisting credentials',async()=>{
  const syncs:Record<string,unknown>[]=[],uploads:Record<string,unknown>[]=[];let puts=0;
  const rt=createTestRuntime({env:{POPOST_API_KEY:'video-test-key'},files:{'/work/P/assets/card.png':'picture-bytes'},fetchHandler:async request=>{
   const url=new URL(request.url);
   if(url.hostname==='storage.test'){
    expect(request.method).toBe('PUT');expect(request.headers.get('authorization')).toBeNull();expect(await request.text()).toBe('picture-bytes');puts++;return new Response('',{status:200});
   }
   const body=await request.json() as Record<string,unknown>;
   if(url.pathname.endsWith('/uploads')){uploads.push(body);return Response.json({success:true,data:{uploadId:'file-upload',uploadUrl:'https://storage.test/upload',headers:{'content-type':'application/octet-stream'}}});}
   if(url.pathname.endsWith('/projects/sync')){syncs.push(body);return Response.json({success:true,data:{deckId:'saved-video',webUrl:'https://popost.ai/zh/workspace/projects/saved-video',assetsUrl:'https://popost.ai/zh/assets',version:syncs.length}});}
   throw Error('Unexpected request');
  }});
  const p:Project={version:1,canvas:{width:320,height:180,fps:30},materials:[{id:'card',kind:'image',file:'assets/card.png'}],segments:[{id:'a',frames:60,base:{color:'#111111'}}],tracks:[]};
  let state:PreviewState={generation:0,project:{dir:'/work/P',name:'Video'},source:p,resolved:resolve(p),problems:[],measure:null,referenceMeasure:null,score:null,notes:null,reference:null,messages:[]};
  const cloud=createVideoCloud(rt,'/work/P',async()=>state);
  expect((await cloud.push({lang:'zh'})).state).toBe('saved');
  const updated:Project={...p,tracks:[{id:'text',type:'text',text:'Edited caption',box:[0,0,1,.1],during:{segment:'a',from:0,to:60}}]};state={...state,source:updated,resolved:resolve(updated)};
  expect((await cloud.status()).dirty).toBe(true);expect((await cloud.push({lang:'zh'})).dirty).toBe(false);
  expect(uploads).toHaveLength(1);expect(puts).toBe(1);expect(syncs).toHaveLength(2);expect(syncs[1]?.projectId).toBe(syncs[0]?.projectId);
  expect(syncs[1]?.video).toMatchObject({source:updated,files:[{path:'assets/card.png',uploadId:'file-upload'}]});expect(syncs[1]?.html).toBeUndefined();
  expect(await rt.fs.readText('/work/P/.studio/cloud.json')).not.toContain('video-test-key');cloud.dispose();
 });

});
