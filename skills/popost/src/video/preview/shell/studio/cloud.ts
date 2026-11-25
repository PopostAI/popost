import type { Store } from '../app';
import type { CloudStatus } from '../../../../cloud/service';
import { button, notify, request } from './ui';

export const mountCloud = (root: HTMLElement, store: Store): void => {
 const zh=store.get().lang==='zh';let current:CloudStatus|undefined,busy=false;
 const b=button(zh?'保存到云端':'Save to cloud',()=>{void save();},'studio-cloud');b.id='studio-cloud-save';root.append(b);
 const draw=():void=>{
  b.hidden=current?.mode==='off';
  b.disabled=busy||!current||current?.state==='uploading';
  b.textContent=busy||current?.state==='uploading'?(zh?'正在同步…':'Syncing…'):current?.state==='saved'&&!current.dirty?(zh?'云端已保存':'Saved to cloud'):current?.state==='waiting'?(zh?'等待授权':'Awaiting sign-in'):current?.state==='failed'||current?.state==='conflict'?(zh?'同步未完成':'Sync needs attention'):(zh?'保存到云端':'Save to cloud');
  b.title=current?.error?.message??(zh?'本机自动保存；授权后同步到 Popost 资产。':'Saved locally. Connect Popost to sync this project to your assets.');
 };
 const refresh=async():Promise<void>=>{try{current=await request<CloudStatus>('/api/cloud/status');draw();}catch{/* Local editing remains available when cloud status cannot load. */}};
 const save=async():Promise<void>=>{
  if(busy)return;busy=true;draw();
  // Open during the click gesture so the authorization flow is not blocked by popup protection.
  const login=current?.mode==='anonymous'?window.open('about:blank','popost-cloud-save'):null;
  try{
   if(current?.mode==='anonymous'){const answer=await request<{result:{authorizeUrl:string}}>('/api/studio/cloud/start',{lang:store.get().lang});if(login)login.location.href=answer.result.authorizeUrl;else location.href=answer.result.authorizeUrl;}
   else{const answer=await request<{result:CloudStatus}>('/api/studio/cloud/push',{lang:store.get().lang});current=answer.result;if(current.error)notify(store,current.error.message);}
  }catch(error){login?.close();notify(store,String(error));}finally{busy=false;await refresh();}
 };
 draw();void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},5000);window.addEventListener('pagehide',()=>clearInterval(timer));
};
