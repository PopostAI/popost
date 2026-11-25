import { afterAll, describe, expect, it } from 'vitest';
import { createDiskRuntime } from '../../src/testing/disk';
import { draftContent } from '../../src/video/draft/schema';
const rt=await createDiskRuntime();afterAll(()=>rt.cleanup());
describe('native editable draft schema',()=>{
 it.each(['jianying','capcut'] as const)('exports %s tracks with source and target times, distinct materials, and native caption text',target=>{
  const d=draftContent(rt,{id:'project',name:'Example',target,width:180,height:320,fps:30,duration:2e6,videos:[{id:'v1',file:'media/a.mp4',start:0,duration:1e6},{id:'v2',file:'media/b.mp4',start:1e6,duration:1e6}],audio:[{id:'a1',file:'media/a.wav',start:0,duration:2e6}],captions:[{text:'你好 👋',start:5e5,duration:1e6}]});
  expect(d.platform.app_source).toBe(target==='jianying'?'lv':'cc');
  expect(d.tracks.map(t=>t.type)).toEqual(['video','audio','text']);
  expect(d.tracks[0]?.segments[1]?.target_timerange).toEqual({start:1e6,duration:1e6});
  expect(d.tracks[2]?.segments[0]?.source_timerange).toBeNull();
  expect(d.tracks[1]?.segments[0]?.clip).toBeNull();
  expect(d.materials.speeds.map(s=>s.id)).toContain(d.tracks[0]?.segments[0]?.extra_material_refs[0]);
  expect(d.tracks[2]?.segments[0]?.render_index).toBeGreaterThan(10000);
  expect(d.tracks[0]?.segments[0]?.id).toMatch(/^[0-9a-f]{32}$/);
  const content=JSON.parse(d.materials.texts[0]!.content) as {text:string;styles:{range:number[]}[]};
  expect(content.text).toBe('你好 👋');expect(content.styles[0]?.range).toEqual([0,4]);
 });
});
