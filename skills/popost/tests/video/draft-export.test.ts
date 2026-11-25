import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { draftContent } from '../../src/video/draft/schema';
import { INSTALLER } from '../../src/video/draft/installer';
const rt=await createDiskRuntime();afterAll(()=>rt.cleanup());
describe('portable editable drafts',()=>{
 it.each(['jianying','capcut'] as const)('exports %s tracks with source and target times, distinct materials, and native caption text',target=>{
  const d=draftContent(rt,{id:'project',name:'Example',target,width:180,height:320,fps:30,duration:2e6,videos:[{id:'v1',file:'media/a.mp4',start:0,duration:1e6},{id:'v2',file:'media/b.mp4',start:1e6,duration:1e6}],audio:[{id:'a1',file:'media/a.wav',start:0,duration:2e6}],captions:[{text:'你好 👋',start:5e5,duration:1e6}]});
  expect(d.platform.app_source).toBe(target==='jianying'?'lv':'cc');
  expect(d.tracks.map(t=>t.type)).toEqual(['video','audio','text']);
  expect(d.tracks[0]?.segments[1]?.target_timerange).toEqual({start:1e6,duration:1e6});
  expect(d.tracks[2]?.segments[0]?.source_timerange).toBeNull();
  const content=JSON.parse(d.materials.texts[0]!.content) as {text:string;styles:{range:number[]}[]};
  expect(content.text).toBe('你好 👋');expect(content.styles[0]?.range).toEqual([0,4]);
 });
 it('installs to a fresh folder, rebases media, preserves prior drafts and backs up their registry',async()=>{
  if(!rt.programs)return;
  const dir=rt.path.join(rt.cwd,'package'),root=rt.path.join(rt.cwd,'draft-root');
  await rt.fs.writeFile(rt.path.join(dir,'draft/media/a.mp4'),new Uint8Array([1]));
  await rt.fs.writeFile(rt.path.join(dir,'popost-draft.json'),JSON.stringify({target:'capcut',name:'Example'}));
  await rt.fs.writeFile(rt.path.join(dir,'draft/draft_content.json'),JSON.stringify({materials:{videos:[{path:'media/a.mp4'}]}}));
  await rt.fs.writeFile(rt.path.join(dir,'draft/draft_meta_info.json'),JSON.stringify({draft_name:'Example',draft_materials:[{type:0,value:[{file_Path:'media/a.mp4'}]}]}));
  await rt.fs.writeFile(rt.path.join(dir,'install.py'),INSTALLER);
  await rt.fs.writeFile(rt.path.join(root,'root_meta_info.json'),JSON.stringify({all_draft_store:[{draft_id:'prior',draft_name:'Keep me'}]}));
  const ran=await rt.programs.run(['python3',rt.path.join(dir,'install.py'),root]);expect(ran.code,ran.stderr).toBe(0);
  const registry=JSON.parse(await rt.fs.readText(rt.path.join(root,'root_meta_info.json'))) as {all_draft_store:{draft_id:string;draft_fold_path:string}[]};
  expect(registry.all_draft_store).toHaveLength(2);expect(registry.all_draft_store[1]?.draft_id).toBe('prior');
  const installed=registry.all_draft_store[0]!.draft_fold_path;
  const draft=JSON.parse(await rt.fs.readText(rt.path.join(installed,'draft_info.json'))) as {materials:{videos:{path:string}[]}};
  expect(draft.materials.videos[0]?.path).toBe(rt.path.join(installed,'media/a.mp4'));
  expect((await rt.fs.readdir(root)).some(n=>n.startsWith('root_meta_info.popost-backup-'))).toBe(true);
 });
});
