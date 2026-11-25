import JSZip from 'jszip';
import type { Runtime } from '../../runtime';
import { sha256 } from '../../core/util';
import { renderVideo } from '../render/index';
import { runFfmpegOk } from '../media/ffmpeg';
import { buildPage } from '../compile/index';
import type { Project } from '../types';
import { draftContent, type DraftMedia, type DraftTarget } from './schema';
import { INSTALLER } from './installer';

const tempo = (speed: number): string => {
  const factors: number[] = []; let left = speed;
  while (left > 2) { factors.push(2); left /= 2; }
  while (left < .5) { factors.push(.5); left *= 2; }
  return [...factors,left].map(n=>'atempo='+n).join(',');
};
export const exportDraft = async (rt: Runtime, dir: string, source: Project, target: DraftTarget) => {
  if (!['jianying','capcut'].includes(target)) throw new Error('Choose Jianying Pro or CapCut.');
  const built = await buildPage(rt,dir,{source}), r = built.resolved;
  if (!r || built.problems.some(p=>p.level==='error')) throw new Error(built.problems.map(p=>p.message).join('\n'));
  const assets=await Promise.all(source.materials.filter(m=>m.file).map(async m=>[m.file,sha256(await rt.fs.readFile(rt.path.resolve(dir,m.file!)))]));
  const hash = sha256(JSON.stringify({source,assets,renderer:'draft-visual-1'})), path = '.studio/drafts/'+hash.slice(0,16), out = rt.path.join(dir,path);
  await rt.fs.mkdir(out);
  const visual = rt.path.join(out,'visual.mp4');
  if (!(await rt.fs.stat(visual))) await renderVideo(rt,{projectDir:dir,out:visual,audioEnabled:false,source:{...source,tracks:source.tracks.filter(t=>t.type!=='caption'&&t.type!=='audio')}});
  const zip = new JSZip(), videos: DraftMedia[] = [], audio: DraftMedia[] = [];
  const us = (n: number): number => Math.round(n/r.canvas.fps*1e6);
  for (const s of r.segments) {
    const file='media/video-'+String(s.index+1).padStart(3,'0')+'.mp4', local=rt.path.join(out,file);
    if (!(await rt.fs.stat(local))) {
      await rt.fs.mkdir(rt.path.dirname(local));
      await runFfmpegOk(rt,['-y','-loglevel','error','-ss',String(s.start/r.canvas.fps),'-i',visual,'-t',String((s.end-s.start)/r.canvas.fps),'-an','-c:v','libx264','-preset','fast','-crf','18','-movflags','+faststart',local]);
    }
    zip.file('draft/'+file,await rt.fs.readFile(local));
    videos.push({id:rt.randomUUID(),file,start:us(s.start),duration:us(s.end-s.start),width:r.canvas.width,height:r.canvas.height});
  }
  for (const [i,a] of r.audio.entries()) {
    const file='media/audio-'+String(i+1).padStart(3,'0')+'.wav',local=rt.path.join(out,file),length=(a.end??r.frames)-a.start;
    if (length<=0) continue;
    if (!(await rt.fs.stat(local))) await runFfmpegOk(rt,['-y','-loglevel','error','-ss',String(a.from ? a.from.frame/a.from.fps : 0),'-i',rt.path.resolve(dir,a.src),'-t',String(length/r.canvas.fps),'-vn','-af',tempo(a.speed??1)+',apad','-ar','48000','-ac','2','-c:a','pcm_s16le',local]);
    zip.file('draft/'+file,await rt.fs.readFile(local));
    audio.push({id:rt.randomUUID(),file,start:us(a.start),duration:us(length),gain:10**(a.gain/20)});
  }
  const captions = r.items.filter(it=>it.cue&&it.text).map(it=>({text:it.text!,start:us(it.start),duration:us(it.end-it.start)}));
  const id=rt.randomUUID(),name='Popost-'+target+'-'+hash.slice(0,8),duration=us(r.frames);
  const draft=draftContent(rt,{id,name,target,width:r.canvas.width,height:r.canvas.height,fps:r.canvas.fps,duration,videos,audio,captions});
  const library=[...videos,...audio].map(m=>({id:m.id,file_Path:m.file,extra_info:m.file.split('/').pop(),duration:m.duration,width:m.width??0,height:m.height??0,type:0,metetype:m.width?'video':'audio',item_source:1,create_time:-1,import_time:-1,import_time_ms:-1,roughcut_time_range:{start:0,duration:m.duration},sub_time_range:{start:-1,duration:-1},md5:''}));
  const meta={draft_id:id,draft_name:name,draft_fold_path:'',draft_root_path:'',draft_cover:'draft_cover.jpg',draft_deeplink_url:'',draft_enterprise_info:{},draft_materials:[0,1,2,3,6,7,8].map(type=>({type,value:type===0?library:[]})),draft_materials_copied_info:[],draft_segment_extra_info:[],draft_is_invisible:false,draft_is_ai_shorts:false,draft_cloud_last_action_download:false,draft_cloud_materials:[],tm_draft_create:0,tm_draft_modified:0,tm_duration:duration};
  const cover=rt.path.join(out,'cover.jpg');
  if(!(await rt.fs.stat(cover)))await runFfmpegOk(rt,['-y','-loglevel','error','-i',visual,'-frames:v','1','-vf','scale=320:-2',cover]);
  zip.file('draft/draft_cover.jpg',await rt.fs.readFile(cover));
  for(const empty of ['.backup','Resources','adjust_mask','common_attachment','matting','qr_upload','smart_crop','subdraft'])zip.folder('draft/'+empty);
  const json=JSON.stringify(draft);
  zip.file('draft/draft_content.json',json);zip.file('draft/draft_info.json',json);zip.file('draft/template-2.tmp',json);zip.file('draft/draft_meta_info.json',JSON.stringify(meta));
  zip.file('draft/draft_settings','[General]\ndraft_create_time=0\ndraft_last_edit_time=0\nreal_edit_keys=1\nreal_edit_seconds=0\n');
  zip.file('popost-draft.json',JSON.stringify({version:1,name,target,sourceHash:hash,clips:videos.length,audio:audio.length,captions:captions.length}));
  zip.file('install.py',INSTALLER,{unixPermissions:0o755});
  zip.file('Import.command','#!/bin/sh\ncd -- "$(dirname -- "$0")"\npython3 ./install.py\n',{unixPermissions:0o755});
  zip.file('README.txt','Close the target editor, extract this entire ZIP, then run Import.command on macOS or python install.py on Windows. Reopen the editor and choose the Popost project.\nA custom draft root may be passed to install.py. Keep the imported project and media together. Existing drafts are preserved and registry changes are backed up.\nVideo segments, audio segments and caption text/timing remain editable. Complex visuals are baked per segment; caption styling must be reapplied.\n');
  const file=path+'/Popost-'+target+'.zip';await rt.fs.writeFile(rt.path.join(dir,file),await zip.generateAsync({type:'uint8array',platform:'UNIX'}));
  return {file,url:'/project/'+file,target,clips:videos.length,audio:audio.length,captions:captions.length,sourceHash:hash};
};
