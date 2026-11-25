import type { Store } from '../app';
import type { EditActions } from '../edit/controller';
import type { RenderInfo } from '../../protocol';
import { h } from '../dom';
import { copy } from './copy';
import { button, field, note, notify, request, select, title } from './ui';

export const openExport = (store: Store, edit: EditActions): void => {
 if (document.getElementById('studio-export')) return;
 const state=store.get().state; if (!state?.resolved || !state.edit) return;
 const r=state.resolved, zh=store.get().lang==='zh';
 const text=(cn:string,en:string):string=>zh?cn:en;
 let tab='video', target='jianying', resolution='1080', fps='', bitrate='', premium=false, drafting=false;
 const result=h('div',{class:'studio-export-result',attrs:{role:'status'}});
 const progress=h('progress',{attrs:{max:'1',value:'0',hidden:''}});
 const body=h('fieldset',{class:'studio-export-fields'});
 const tabs=h('div',{class:'studio-segments export-tabs',attrs:{role:'tablist'}});
 const dialog=h('aside',{id:'studio-export',class:'studio-export',attrs:{role:'dialog','aria-modal':'true','aria-label':text('导出设置','Export settings')}});
 const close=():void=>{unsubscribe();scrim.remove();dialog.remove();document.getElementById('studio-export-open')?.focus();};
 const scrim=h('div',{class:'studio-scrim',on:{click:close}});
 const choose=(values:[string,string][],value:string,change:(value:string)=>void):HTMLElement=>h('div',{class:'studio-segments'},values.map(([id,label])=>{
  const b=button(label,()=>change(id),id===value?'selected':'');b.setAttribute('aria-pressed',String(id===value));return b;
 }));
 const groupField=(label:string,element:HTMLElement):HTMLElement=>{
  element.setAttribute('role','group');element.setAttribute('aria-label',label);
  return h('div',{class:'studio-field'},[h('span',{text:label}),element]);
 };
 const drawBody=():void=>{
  tabs.replaceChildren(...[['video',copy(store,'video')],['draft',text('剪映','Draft')]].map(([id,label])=>{
   const b=button(label!,()=>{tab=id!;result.replaceChildren();drawBody();draw();},tab===id?'selected':'');b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===id));return b;
  }));
  if(tab==='draft'){
   const limitations=h('details',{},[h('summary',{text:text('部分内容不支持','Some content is flattened')}),note(text('支持：字幕文字与时间、视频片段、音频片段。字幕样式需在目标编辑器中重新设置；复杂视觉效果烘焙到各个视频片段。','Supported: caption text/timing, video clips and audio clips. Reapply caption styles in the target editor. Complex visuals are baked per clip.'))]);
   body.replaceChildren(note(text('把当前时间线导出为可继续编辑的草稿。','Export the current timeline as an editable draft.')),note(text('解压后运行 Import.command（Mac）或 install.py（Windows），再打开目标应用。请保留导入后的素材目录。','Extract and run Import.command (Mac) or install.py (Windows), then open the target app. Keep its imported media folder in place.')),groupField(text('应用','Application'),choose([['jianying',text('剪映专业版','Jianying Pro')],['capcut','CapCut']],target,v=>{target=v;drawBody();})),limitations);
   return;
  }
  const res=choose([['480','480p'],['720','720p'],['1080','1080p'],['2160','4K']],resolution,v=>{
   if(v==='2160'&&!premium){notify(store,copy(store,'paidInfo'));return;}resolution=v;drawBody();
  });
  const hdr=h('button',{text:'HDR',attrs:{type:'button',disabled:'',title:copy(store,'hdrUnavailable')}});
  body.replaceChildren(groupField(copy(store,'dynamicRange'),h('div',{class:'studio-segments'},[button('SDR',()=>undefined,'selected'),hdr])),groupField(copy(store,'resolution'),res),field(copy(store,'fps'),select([['',copy(store,'match')+' ('+r.canvas.fps+' fps)'],...[24,25,30,50,60].map(n=>[String(n),n+' fps'] as [string,string])],fps,copy(store,'fps'),v=>{fps=v;})),field(text('视频码率','Video bitrate'),select([['',copy(store,'recommended')],...[2,5,8,12,20,40].map(n=>[String(n),n+' Mbps'] as [string,string])],bitrate,copy(store,'bitrate'),v=>{bitrate=v;})));
  if(!premium){const b=res.lastElementChild;if(b)b.append(h('span',{class:'export-pro',text:'PRO'}));}
 };
 const submit=button(text('导出','Export'),()=>{void (async()=>{
  try{
   if(tab==='draft'){
    drafting=true;draw();
    const answer=await request<{result:{url:string;target:string;clips:number;audio:number;captions:number}}>('/api/studio/draft',{target});
    result.replaceChildren(note(text('草稿已准备好，包含视频片段、音频片段和字幕。','Draft ready with editable video, audio and captions.')),h('a',{class:'studio-btn primary',text:text('下载草稿 ZIP','Download draft ZIP'),attrs:{href:answer.result.url,download:'Popost-'+answer.result.target+'.zip'}}));
   }else{
    const answer=await request<{render:RenderInfo}>('/api/render',{name:'Popost-video',resolution,dynamicRange:'sdr',fps:fps?Number(fps):null,bitrate:bitrate?Number(bitrate):null,audio:true});edit.setRender(answer.render);
   }
  }catch(e){result.replaceChildren(note(String(e),'bad'));}
  finally{drafting=false;draw();}
 })();},'primary');
 const draw=():void=>{
  const job=store.get().edit.render, busy=drafting||(tab==='video'&&job?.state==='running');body.disabled=busy;submit.disabled=busy;
  tabs.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{b.disabled=busy;});
  progress.hidden=!busy;submit.textContent=busy?text('正在导出…','Exporting…'):text('导出','Export');
  if(tab==='draft')return;
  if(job?.state==='running'){progress.value=job.total?job.frame/job.total:0;result.replaceChildren();}
  if(job?.state==='failed')result.replaceChildren(note(job.message,'bad'));
  if(job?.state==='done')result.replaceChildren(note(text('视频已导出','Video exported')),note([job.width&&job.height?job.width+' × '+job.height:'',job.fps?job.fps+' fps':''].filter(Boolean).join(' · ')),button(copy(store,'play'),()=>{edit.togglePlayRender();store.set({compare:true});close();}),h('a',{class:'studio-btn primary',text:copy(store,'downloadVideo'),attrs:{href:job.url,download:'Popost-video.mp4'}}));
 };
 dialog.append(h('div',{class:'studio-export-header'},[title(text('导出设置','Export settings')),button('×',close)]),tabs,body,progress,submit,result);
 document.body.append(scrim,dialog);drawBody();draw();
 void request<{premium:boolean}>('/api/export-options').then(a=>{premium=a.premium;drawBody();}).catch(()=>undefined);
 const unsubscribe=store.subscribe((v,prev)=>{if(dialog.isConnected&&v.edit.render!==prev.edit.render)draw();});
 dialog.addEventListener('keydown',e=>{if(e.key==='Escape')close();});submit.focus();
};
