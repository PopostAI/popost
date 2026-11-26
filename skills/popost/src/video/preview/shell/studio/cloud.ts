import type { Store } from '../app';
import type { CloudStatus } from '../../../../cloud/service';
import { h } from '../dom';
import { button, request } from './ui';

/** Match the image editor's CloudButton lifecycle, including retrying a retained upload credential. */
export const mountCloud = (root: HTMLElement, store: Store, saveLocal: () => Promise<boolean>): void => {
 const zh=store.get().lang==='zh';const text=(cn:string,en:string):string=>zh?cn:en;
 const area=h('div',{class:'studio-cloud',id:'studio-cloud',attrs:{'aria-live':'polite'}});root.append(area);
 let current:CloudStatus|undefined,failure:CloudStatus['error'],busy:'start'|'push'|undefined,lastAction:'start'|'push'='push';
 let lastView='';
 let link='',showLink=false,copied=false,alive=true,timer:ReturnType<typeof setTimeout>|undefined;
 const errorText=(code?:string):string=>({
  UNAUTHORIZED:text('登录已过期或已使用，请重新点击“保存到云端”。','The login expired or was already used. Save to Cloud again.'),
  LOGIN_REQUIRED:text('请先登录，再保存到云端。','Sign in to save to cloud.'),
  STORAGE_FULL:text('云端存储空间已满。','Your cloud storage is full.'),
  STORAGE_QUOTA_EXCEEDED:text('云端存储空间已满。','Your cloud storage is full.'),
  RATE_LIMITED:text('上传过于频繁，请稍后再试。','Too many uploads. Try again in a moment.'),
  DECK_INVALID:text('云端无法接收这个作品。','The cloud could not accept this project.'),
  NETWORK:text('无法连接 popost.ai。','Could not reach popost.ai.'),
  LOCAL_SAVE_FAILED:text('本地改动保存失败。请先保存作品，再上传到云端。','Could not save local edits. Save the project before uploading.'),
 }[code??'']??text('上传失败，请重试。','Upload failed. Try again.'));
 const status=(label:string,error=false):HTMLElement=>h('span',{class:'studio-cloud-state'+(error?' bad':''),text:label,attrs:{role:'status'},title:failure?.message??current?.error?.message??label});
 const open=():HTMLElement[]=>current?.webUrl?[h('a',{class:'studio-btn',text:text('打开','Open'),attrs:{href:current.webUrl,target:'_blank',rel:'noopener noreferrer',title:text('在 popost 打开','Open in popost')}})]:[];
 const fail=(error:unknown):void=>{failure={code:'NETWORK',message:error instanceof Error?error.message:String(error)};};
 const refresh=async():Promise<void>=>{
  try{current=await request<CloudStatus>('/api/cloud/status');}catch{/* Actions report failures; status polling can recover. */}
  if(!alive)return;draw();clearTimeout(timer);
  if(!current||busy||current?.state==='waiting'||current?.state==='uploading'||(current?.mode==='keyed'&&current.state==='idle'&&current.dirty))timer=setTimeout(()=>void refresh(),2000);
 };
 const start=async():Promise<void>=>{
  if(busy)return;const win=window.open('about:blank','_blank');lastAction='start';failure=undefined;copied=false;busy='start';draw();
  try{
   if(!await saveLocal()){win?.close();failure={code:'LOCAL_SAVE_FAILED',message:''};return;}
   const answer=await request<{result:{authorizeUrl:string}}>('/api/studio/cloud/start',{lang:store.get().lang});
   link=answer.result.authorizeUrl;showLink=!win;
   if(win){win.opener=null;win.location.href=link;}
   lastAction='push';await refresh();
  }catch(error){win?.close();fail(error);}finally{busy=undefined;await refresh();}
 };
 const push=async(force=false):Promise<void>=>{
  if(busy)return;lastAction='push';failure=undefined;busy='push';draw();
  try{
   if(!await saveLocal()){failure={code:'LOCAL_SAVE_FAILED',message:''};return;}
   const answer=await request<{result:CloudStatus}>('/api/studio/cloud/push',{lang:store.get().lang,force});
   current=answer.result;
   if(!current.ok&&current.error?.code==='LOGIN_REQUIRED'){busy=undefined;await start();}
  }catch(error){fail(error);}finally{busy=undefined;await refresh();}
 };
 const copy=async():Promise<void>=>{try{await navigator.clipboard.writeText(link);copied=true;}catch{showLink=true;}draw();};
 const retry=():void=>{
  const code=failure?.code??current?.error?.code;
  if(lastAction==='start'||(current?.mode==='anonymous'&&(code==='LOGIN_REQUIRED'||code==='UNAUTHORIZED')))void start();else void push();
 };
 const draw=():void=>{
  const view=JSON.stringify([current,failure,busy,link,showLink,copied]);if(view===lastView)return;lastView=view;
  area.hidden=current?.mode==='off';area.replaceChildren();if(area.hidden)return;
  const state=busy==='push'?'uploading':busy==='start'?'starting':failure?'failed':current?.state??'idle';
  if(state==='uploading'||state==='starting')area.append(status(state==='starting'?text('等待登录…','Waiting for login…'):current?.mode==='keyed'?text('同步中…','Syncing…'):text('上传中…','Uploading…')));
  else if(state==='waiting'){
   area.append(status(text('等待登录…','Waiting for login…')),button(copied?text('链接已复制','Link copied'):text('复制链接','Copy link'),()=>void copy()));
   if(showLink&&link){const input=h('input',{class:'studio-cloud-link',attrs:{readonly:'','aria-label':text('登录链接','Login link')}});input.value=link;input.addEventListener('focus',()=>input.select());area.append(input);}
  }else if(state==='saved')area.append(status(current?.mode==='keyed'?text('已同步','Synced'):text('已保存到云端','Saved to cloud')),...open());
  else if(state==='failed')area.append(status(errorText(failure?.code??current?.error?.code),true),button(text('重试','Retry'),retry));
  else if(state==='conflict'){
   area.append(status(text('网页端已有修改','Edited on the web'),true),...open());
   if(current?.mode==='keyed'){const overwrite=button(text('覆盖','Overwrite'),()=>void push(true));overwrite.title=text('用本地版本替换网页端的版本','Replace the web copy with this local version');area.append(overwrite);}
  }else{
   const b=button(current?.mode==='keyed'?text('立即同步','Sync now'):current?.webUrl&&current.dirty?text('本地改动未上传','Local changes not uploaded'):text('保存到云端','Save to Cloud'),()=>{if(current?.mode==='keyed')void push();else void start();});
   b.id='studio-cloud-save';b.disabled=!current;b.title=text('在 popost 网页端管理你的所有资产','Manage all your assets on the Popost website');area.append(b);
  }
 };
 store.subscribe((v,previous)=>{if(v.state?.source!==previous.state?.source)void refresh();});
 window.addEventListener('pagehide',()=>{alive=false;clearTimeout(timer);});draw();void refresh();
};
