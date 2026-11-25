import { CloudService, type CloudProjectAdapter } from '../../cloud/service';
import type { CloudRecord } from '../../cloud/state';
import { sha256 } from '../../core/util';
import { PopostClient } from '../../providers/api';
import type { Runtime } from '../../runtime';
import { resolveInside } from './files';
import type { PreviewState } from './protocol';

interface Saved { scope?: string; projectId: string; record?: CloudRecord; uploads?: Record<string,string> }
interface File { path: string; hash: string; bytes: number; absolute: string }
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const rows=(v:unknown):Record<string,unknown>[]=>Array.isArray(v)?v.map(object):[];
const hashes=new Map<string,{signature:string;hash:string}>();
const MAX_FILE=250*1024*1024;
/** Only dependencies named by video.json and its scene documents are uploaded. Cache, logs and credentials stay local. */
export const projectFiles = async (rt: Runtime, dir: string, source: unknown): Promise<File[]> => {
 const pending=[...rows(object(source).materials).flatMap(m=>[m.file,m.words].filter((v):v is string=>typeof v==='string')),...rows(object(source).segments).flatMap(s=>typeof object(s.base).scene==='string'?[String(object(s.base).scene)]:[])];
 const seen=new Set<string>(), files:File[]=[];
 while(pending.length){
  const path=pending.shift()!;const absolute=await resolveInside(rt,dir,path);
  if(!absolute)throw new Error('Cloud save: project dependency is outside the project: '+path);
  const relative=rt.path.relative(dir,absolute).replace(/\\/g,'/');if(seen.has(relative))continue;seen.add(relative);
  const stat=await rt.fs.stat(absolute);if(!stat?.isFile)throw new Error('Missing cloud dependency: '+relative);if(stat.size>MAX_FILE)throw new Error('Cloud save accepts files up to 250 MB: '+relative);
  const signature=stat.size+':'+stat.mtimeMs;let hash=hashes.get(absolute)?.signature===signature?hashes.get(absolute)!.hash:undefined;
  if(!hash){hash=sha256(await rt.fs.readFile(absolute));hashes.set(absolute,{signature,hash});}
  files.push({path:relative,hash,bytes:stat.size,absolute});
  if(/\.(html?|css|js)$/i.test(path)){
   const text=await rt.fs.readText(absolute);
   const refs=[...text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)|(?:import\s*.*?from\s*|import\s*|import\()?["'](\.[^"']+\.(?:js|css))["']/g)].map(m=>m[1]??m[2]??m[3]??'');
   for(const ref of refs){if(/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref))continue;const clean=decodeURIComponent(ref.split(/[?#]/)[0]!);if(clean)pending.push(rt.path.relative(dir,rt.path.resolve(rt.path.dirname(absolute),clean)));}
  }
 }
 return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
};
export const createVideoCloud = (rt: Runtime, dir: string, state: ()=>Promise<PreviewState>, enabled=true): CloudService => {
 const path=rt.path.join(dir,'.studio','cloud.json');let queue=Promise.resolve();
 const scope=():string=>sha256(new PopostClient(rt).baseUrl+'|'+(rt.env.POPOST_API_KEY??'browser-or-device'));
 const read=async():Promise<Saved>=>{try{return JSON.parse(await rt.fs.readText(path)) as Saved;}catch{return {projectId:rt.randomUUID()};}};
 const write=async(value:Saved):Promise<void>=>{const temp=path+'.tmp';await rt.fs.writeFile(temp,JSON.stringify(value,null,2));await rt.fs.rename(temp,path);};
 const saved=async():Promise<Saved>=>{let value:Saved|undefined;queue=queue.then(async()=>{value=await read();if(!await rt.fs.stat(path))await write(value);});await queue;return value!;};
 const snapshot=async()=>{const s=await state();if(!s.source||!s.resolved)throw new Error('Fix the project before saving it to the cloud.');const files=await projectFiles(rt,dir,s.source);return {state:s,files,fingerprint:sha256(JSON.stringify([s.source,files.map(f=>[f.path,f.hash])]))};};
 const push=async(client:PopostClient,force:boolean,lang:'zh'|'en'):Promise<void>=>{
  const local=await saved(),snap=await snapshot();const uploads=local.scope===scope()?{...local.uploads}:{};const files=[];
  for(const file of snap.files){
   let uploadId=uploads[file.hash];
   if(!uploadId){
    const ticket=object(await client.request('POST','/uploads',{body:{purpose:'video-project',projectId:local.projectId,fileName:rt.path.basename(file.path),mimeType:'application/octet-stream',bytes:file.bytes,sha256:file.hash}}));
    const url=new URL(String(ticket.uploadUrl));if(url.protocol!=='https:')throw new Error('Cloud upload requires HTTPS.');
    const response=await rt.fetch(url.href,{method:'PUT',headers:object(ticket.headers) as Record<string,string>,body:Uint8Array.from(await rt.fs.readFile(file.absolute)).buffer});if(!response.ok)throw new Error('Cloud upload failed: '+response.status);
    uploadId=String(ticket.uploadId);uploads[file.hash]=uploadId;await write({...local,scope:scope(),uploads});
   }
   files.push({path:file.path,sha256:file.hash,bytes:file.bytes,uploadId});
  }
  const r=snap.state.resolved!;
  const reply=object(await client.request('POST','/projects/sync',{body:{projectId:local.projectId,title:object(snap.state.source).title??snap.state.project.name,width:r.canvas.width,height:r.canvas.height,assets:[],force,locale:lang,video:{source:snap.state.source,files,duration:r.frames/r.canvas.fps,fps:r.canvas.fps}}}));
  if(typeof reply.deckId!=='string'||!reply.deckId||!Number.isSafeInteger(reply.version)||Number(reply.version)<0||typeof reply.webUrl!=='string')throw new Error('Cloud save returned an invalid project revision.');
  const webUrl=String(reply.webUrl);if(new URL(webUrl).origin!==new URL(client.baseUrl).origin)throw new Error('Cloud save returned an invalid project URL.');
  await write({scope:scope(),projectId:local.projectId,uploads,record:{assets:uploads,projectId:local.projectId,deckId:String(reply.deckId),webUrl,assetsUrl:String(reply.assetsUrl),version:Number(reply.version),fingerprint:snap.fingerprint,syncedAt:rt.now().toISOString()}});
 };
 const adapter:CloudProjectAdapter={info:async()=>{const local=await saved();const s=await state();return {projectId:local.projectId,title:String(object(s.source).title??s.project.name),pages:0};},record:async()=>{const local=await saved();return local.scope===scope()?local.record??null:null;},revision:async()=>(await snapshot()).fingerprint,push};
 return new CloudService(rt,()=>dir,{project:adapter,enabled});
};
