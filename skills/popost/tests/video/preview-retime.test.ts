import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/video/types';
import { parseProject } from '../../src/video/project/schema';
import { checkProject } from '../../src/video/project/check';
import { resolve } from '../../src/video/timeline/resolve';
import { retimeSource } from '../../src/video/preview/edit/retime';
import { duplicateScene } from '../../src/video/preview/shell/edit/scenes';
import type { PreviewState } from '../../src/video/preview/protocol';

const project = (): Project => ({version:1,canvas:{width:320,height:180,fps:30},materials:[],
  segments:[{id:'a',frames:120,base:{color:'#eeeeee'}},{id:'b',frames:120,base:{color:'#ffffff'},in:{transition:'fade',frames:20}}],
  tracks:[{id:'title',type:'text',text:'Editable title',box:[.1,.2,.8,.2],during:{segment:'a'},enter:{preset:'fade',frames:10}},
    {id:'rule',type:'shape',shape:'rect',color:'#123456',box:[.1,.8,.8,.01],during:{segment:'a',from:15},enter:{preset:'wipe',frames:78}},
    {id:'caption',type:'caption',box:[.1,.7,.8,.1],cues:[{text:'One',during:{segment:'a',from:15,to:120}},{text:'Two',during:{segment:'b'}}],enter:{preset:'fade',frames:6}}]});
const parse = (value: unknown): Project => {
  const parsed=parseProject(value); expect(parsed.problems.filter(p=>p.level==='error')).toEqual([]);
  expect(parsed.project).toBeDefined();return parsed.project!;
};
const valid = (p: Project): void => {expect(checkProject(p).filter(p=>p.level==='error')).toEqual([]);expect(()=>resolve(p)).not.toThrow();};

describe('retiming editable content',()=>{
  it('shortens a scene and fits the entrance inside the remaining span, preserving its contents',()=>{
    const before=project(),after=structuredClone(before);after.segments[0]!.frames=90;
    const result=parse(retimeSource(before,after)); valid(result);
    expect(resolve(result).frames).toBe(210);
    expect(resolve(result).items.find(x=>x.id==='rule')).toMatchObject({start:15,end:90,enter:{frames:75}});
    expect(result.tracks[0]).toEqual(before.tracks[0]);
    expect(result.tracks[2]?.type==='caption'&&result.tracks[2].cues[0]?.during.to).toBe(90);
    expect(before.segments[0]!.frames).toBe(120);expect(after.tracks[1]).toEqual(before.tracks[1]);
  });
  it('fits motion for a trimmed item and supports one-frame scenes without an invalid animation',()=>{
    const before=project(),after=structuredClone(before);after.segments[0]!.frames=1;
    const result=parse(retimeSource(before,after));valid(result);
    expect(resolve(result).items.find(x=>x.id==='rule')).toMatchObject({start:0,end:1});
    expect(resolve(result).segments[1]?.transition?.frames).toBeLessThanOrEqual(1);
  });
  it('reorders a scene with an incoming transition into the first position safely',()=>{
    const before=project(),after=structuredClone(before);after.segments.reverse();
    const result=parse(retimeSource(before,after));valid(result);
    expect(result.segments.map(s=>s.id)).toEqual(['b','a']);expect(result.segments[0]?.in).toBeUndefined();
  });
  it('duplicates a scene with its title, shape and only its own caption cues',()=>{
    const source=project();const state={source,resolved:resolve(source)} as PreviewState;
    const copy=duplicateScene(state,0)!;const result=parse(copy.source);valid(result);
    expect(result.segments.map(s=>s.id)).toEqual(['a',copy.id,'b']);
    const children=resolve(result).items.filter(it=>it.start>=120&&it.end<=240);
    expect(children.map(it=>it.text??it.type).sort()).toEqual(['Editable title','One','shape'].sort());
    expect(source.tracks).toHaveLength(3);
  });
});
