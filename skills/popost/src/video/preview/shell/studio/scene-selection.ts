import type { Store } from '../app';
import { h } from '../dom';
import { segmentAt, type Selection } from '../model';
import type { EditActions } from '../edit/controller';
import { object, rows, input, field, note, request } from './ui';
import type { StudioMeta } from './sidebar';

export interface SlotBox { selection: Extract<Selection, {kind:'slot'}>; box: [number,number,number,number]; value: string; image: boolean }
/** Read the same-origin scene DOM after applyFrame; hidden phases never become selectable. */
export const visibleSlots = (iframe: HTMLIFrameElement, store: Store): SlotBox[] => {
 const v=store.get(), r=v.state?.resolved; if(!r) return [];
 const segment=segmentAt(r,v.frame); if(!segment) return [];
 const page=iframe.contentDocument; if(!page) return [];
 const out: SlotBox[]=[];
 for(const scene of Array.from(page.querySelectorAll<HTMLIFrameElement>('iframe'))) {
  const doc=scene.contentDocument, window=scene.contentWindow; if(!doc || !window) continue;
  if(scene.parentElement?.dataset.segment !== segment.id)continue;
  const outer=scene.getBoundingClientRect(); if(!outer.width || !outer.height) continue;
  // The scene's parent layer is removed from layout while another segment plays.
  if(window.getComputedStyle(scene).visibility==='hidden') continue;
  for(const node of Array.from(doc.querySelectorAll<HTMLElement>('[data-slot]'))) {
   let visible=true; let opacity=1;
   for(let el: Element|null=node;el;el=el.parentElement){const style=window.getComputedStyle(el);opacity*=Number(style.opacity);if(style.display==='none'||style.visibility==='hidden')visible=false;}
   const rect=node.getBoundingClientRect();if(!visible||opacity<.1||!rect.width||!rect.height)continue;
   const name=node.dataset.slot;if(!name)continue;
   out.push({selection:{kind:'slot',id:segment.id,name},box:[(outer.left+rect.left*outer.width/(scene.clientWidth||r.canvas.width))/r.canvas.width,(outer.top+rect.top*outer.height/(scene.clientHeight||r.canvas.height))/r.canvas.height,rect.width/r.canvas.width,rect.height/r.canvas.height],value:node.tagName==='IMG'?node.getAttribute('src')??'':node.textContent??'',image:node.tagName==='IMG'});
  }
 }
 return out;
};
export const slotInspector = (store: Store, edit: EditActions): HTMLElement => {
 const v=store.get(),selection=v.pinned;const root=h('div',{class:'form',id:'slot-inspector'});
 if(selection?.kind!=='slot')return root;
 const zh=v.lang==='zh',source=object(v.state?.source);const index=rows(source.segments).findIndex(x=>x.id===selection.id);
 root.append(h('div',{class:'sel-title',text:zh?'场景元素':'Scene element'}));
 void request<StudioMeta>('/api/studio').then(meta=>{
  if(!root.isConnected)return;const slot=meta.slots.find(x=>x.segment===selection.id&&x.name===selection.name);if(!slot)return;
  const control=slot.kind==='image'?input(slot.value,zh?'图片地址':'Image path'):h('textarea',{class:'studio-input',attrs:{rows:'5','aria-label':zh?'文字内容':'Text content'}});control.value=slot.value;
  const save=(value:string):void=>{const base=object(rows(object(store.get().state?.source).segments)[index]?.base);void edit.send({op:'set',path:['segments',index,'base','slots'],value:{...object(base.slots),[slot.name]:value}});};
  control.addEventListener('change',()=>save(control.value));
  control.addEventListener('keydown',event=>{const e=event as KeyboardEvent;if((e.ctrlKey||e.metaKey)&&e.key==='Enter')control.blur();});
  if(slot.kind==='image'){
   const base=object(rows(source.segments)[index]?.base),scene=String(base.scene??'');
   const url=new URL(slot.value,location.origin+'/project/'+scene);
   if(url.origin===location.origin&&url.pathname.startsWith('/project/'))root.append(h('img',{class:'studio-slot-preview',attrs:{src:url.href,alt:zh?'当前图片':'Current image'}}));
   const materials=rows(source.materials).filter(x=>x.kind==='image');
   if(materials.length){
    const choose=h('select',{class:'studio-input',attrs:{'aria-label':zh?'替换图片':'Replace image'}},[h('option',{text:zh?'选择素材中的图片':'Choose an image',attrs:{value:''}}),...materials.map((m,i)=>h('option',{text:String(m.note??m.file??(zh?'图片 ':'Image ')+(i+1)),attrs:{value:String(m.id)}}))]);
    choose.addEventListener('change',()=>{const material=materials.find(m=>m.id===choose.value);if(material)save('../'.repeat(scene.split('/').length-1)+String(material.file));});root.append(field(zh?'替换图片':'Replace image',choose));
   }else root.append(note(zh?'先在素材中导入图片，再回到这里替换。':'Import an image in Media, then select it here.'));
   root.append(h('details',{},[h('summary',{text:zh?'图片地址':'Image path'}),control]));
  }else root.append(field(zh?'文字内容':'Text content',control));
  root.append(note(zh?'修改会保存到当前工程，并用于视频导出。':'Changes are saved to this project and used in the exported video.'));
 }).catch(error=>root.append(note(String(error),'bad')));return root;
};
