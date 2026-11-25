import type { Store } from '../app';
import type { EditActions } from '../edit/controller';
import type { RenderInfo } from '../../protocol';
import { h } from '../dom';
import { copy } from './copy';
import { button, field, note, request, select, title } from './ui';
import { showDraftImported } from './draft-result';
import type { NativeDraftResult } from '../../../draft/native';
import type { DraftApplication } from '../../../draft/targets';

export const openExport = (store: Store, edit: EditActions): void => {
 if (document.getElementById('studio-export')) return;
 const state=store.get().state; if (!state?.resolved || !state.edit) return;
 const r=state.resolved, zh=store.get().lang==='zh';
 const text=(cn:string,en:string):string=>zh?cn:en;
 let tab='video', target='jianying', resolution='1080', fps='', bitrate='', premium=false, drafting=false;
 let applications: (DraftApplication & { error?: string })[] | undefined, draftRequestId: string | undefined;
 const result=h('div',{class:'studio-export-result',attrs:{role:'status'}});
 const paid=h('div',{class:'studio-paid-info'});
 let pricingUrl: string | undefined;
 const progress=h('progress',{attrs:{max:'1',value:'0',hidden:''}});
 const body=h('fieldset',{class:'studio-export-fields'});
 const tabs=h('div',{class:'studio-segments export-tabs',attrs:{role:'tablist'}});
 const dialog=h('aside',{id:'studio-export',class:'studio-export',attrs:{role:'dialog','aria-modal':'true','aria-label':text('导出设置','Export settings')}});
 const close=():void=>{if(drafting)return;unsubscribe();scrim.remove();dialog.remove();document.getElementById('studio-export-open')?.focus();};
 const scrim=h('div',{class:'studio-scrim',on:{click:close}});
 const choose=(values:[string,string][],value:string,change:(value:string)=>void):HTMLElement=>h('div',{class:'studio-segments'},values.map(([id,label])=>{
  const b=button(label,()=>change(id),id===value?'selected':'');b.setAttribute('aria-pressed',String(id===value));return b;
 }));
 const groupField=(label:string,element:HTMLElement):HTMLElement=>{
  element.setAttribute('role','group');element.setAttribute('aria-label',label);
  return h('div',{class:'studio-field'},[h('span',{text:label}),element]);
 };
 const drawBody=():void=>{
  paid.hidden=tab!=='video';
  tabs.replaceChildren(...[['video',copy(store,'video')],['draft',text('剪映','Draft')]].map(([id,label])=>{
   const b=button(label!,()=>{tab=id!;result.replaceChildren();drawBody();draw();},tab===id?'selected':'');b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===id));return b;
  }));
  if(tab==='draft'){
   const limitations=h('details',{},[h('summary',{text:text('部分内容不支持','Some content is flattened')}),note(text('支持：字幕文字与时间、视频片段、音频片段。字幕样式需在目标编辑器中重新设置；复杂视觉效果烘焙到各个视频片段。','Supported: caption text/timing, video clips and audio clips. Reapply caption styles in the target editor. Complex visuals are baked per clip.'))]);
   const selected=applications?.find(app=>app.target===target);
   body.replaceChildren(note(text('把当前时间线直接保存为本机应用中可继续编辑的草稿。','Save the current timeline directly into your desktop editor’s local drafts.')),note(text('导出成功后可一键重启应用，在本地草稿中继续编辑。','After export, restart the app with one click and continue editing from local drafts.')),groupField(text('应用','Application'),choose([['jianying',text('剪映专业版','Jianying Pro')],['capcut','CapCut']],target,v=>{target=v;draftRequestId=undefined;drawBody();draw();})),limitations);
   if(!applications)body.append(note(text('正在检查本机应用…','Checking desktop editors…')));
   else if(!selected?.usable)body.append(note(selected?.error??text('请在运行此编辑器的电脑上安装并打开所选应用，再重新打开导出设置。','Install and open the selected app on the computer running this editor, then reopen export settings.'),'bad'));
   return;
  }
  const res=choose([['480','480p'],['720','720p'],['1080','1080p'],['2160','4K']],resolution,v=>{
   resolution=v;drawBody();draw();
  });
  const hdr=h('button',{text:'HDR',attrs:{type:'button',disabled:'',title:copy(store,'hdrUnavailable')}});
  body.replaceChildren(groupField(copy(store,'dynamicRange'),h('div',{class:'studio-segments'},[button('SDR',()=>undefined,'selected'),hdr])),groupField(copy(store,'resolution'),res),field(copy(store,'fps'),select([['',copy(store,'match')+' ('+r.canvas.fps+' fps)'],...[24,25,30,50,60].map(n=>[String(n),n+' fps'] as [string,string])],fps,copy(store,'fps'),v=>{fps=v;})),field(text('视频码率','Video bitrate'),select([['',copy(store,'recommended')],...[2,5,8,12,20,40].map(n=>[String(n),n+' Mbps'] as [string,string])],bitrate,copy(store,'bitrate'),v=>{bitrate=v;})));
  paid.replaceChildren();
  if(!premium){const b=res.lastElementChild;if(b)b.append(h('span',{class:'export-pro',text:'PRO'}));}
  if(resolution==='2160'&&!premium)paid.append(note(text('4K 为付费分辨率。升级套餐后即可导出；1080p 及以下可继续使用。','4K requires a paid plan. Upgrade to export in 4K, or choose 1080p or below.')),...(pricingUrl?[h('a',{class:'studio-btn',text:copy(store,'unlock'),attrs:{href:pricingUrl,target:'_blank',rel:'noopener'}})]:[note(copy(store,'loading'))]),button(copy(store,'refreshPlan'),()=>{void request<{premium:boolean;pricingUrl?:string}>('/api/export-options').then(a=>{premium=a.premium;drawBody();draw();});}));
 };
 const submit=button(text('导出','Export'),()=>{void (async()=>{
  try{
   if(tab==='draft'){
    drafting=true;draw();
    draftRequestId??=crypto.randomUUID();
    const answer=await request<{result:NativeDraftResult}>('/api/studio/draft',{target,requestId:draftRequestId});
    drafting=false;close();showDraftImported(store,answer.result);
   }else{
    const answer=await request<{render:RenderInfo}>('/api/render',{name:'Popost-video',resolution,dynamicRange:'sdr',fps:fps?Number(fps):null,bitrate:bitrate?Number(bitrate):null,audio:true});edit.setRender(answer.render);
   }
  }catch(e){result.replaceChildren(note(String(e),'bad'));}
  finally{drafting=false;draw();}
 })();},'primary');
 const draw=():void=>{
  const job=store.get().edit.render, busy=drafting||(tab==='video'&&job?.state==='running');body.disabled=busy;submit.disabled=busy||(tab==='video'&&resolution==='2160'&&!premium)||(tab==='draft'&&!applications?.find(app=>app.target===target)?.usable);closeButton.disabled=drafting;
  tabs.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{b.disabled=busy;});
  progress.hidden=!busy;submit.textContent=busy?text('正在导出…','Exporting…'):text('导出','Export');
  if(tab==='draft'){if(drafting)progress.removeAttribute('value');return;}
  if(job?.state==='running'){progress.value=job.total?job.frame/job.total:0;result.replaceChildren();}
  if(job?.state==='failed')result.replaceChildren(note(job.message,'bad'));
  if(job?.state==='done')result.replaceChildren(note(text('导出完成，视频已保存到工程目录。','Export complete. The video is saved in your project folder.')));
 };
 const closeButton=button('×',close);
 dialog.append(h('div',{class:'studio-export-header'},[title(text('导出设置','Export settings')),closeButton]),tabs,body,paid,progress,submit,result);
 document.body.append(scrim,dialog);drawBody();draw();
 void request<{premium:boolean;pricingUrl?:string}>('/api/export-options').then(a=>{premium=a.premium;pricingUrl=a.pricingUrl??pricingUrl;drawBody();draw();}).catch(()=>undefined);
 void request<{result:{applications:(DraftApplication & {error?:string})[]}}>('/api/studio/draft-targets',{}).then(a=>{applications=a.result.applications;drawBody();draw();}).catch(error=>{applications=[];result.replaceChildren(note(String(error),'bad'));drawBody();draw();});
 const unsubscribe=store.subscribe((v,prev)=>{if(dialog.isConnected&&v.edit.render!==prev.edit.render)draw();});
 dialog.addEventListener('keydown',e=>{if(e.key==='Escape')close();});submit.focus();
};
