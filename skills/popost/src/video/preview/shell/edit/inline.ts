import type { Store } from '../app';
import { h, placeBox } from '../dom';
import { visibleSlots } from '../studio/scene-selection';
import { object, rows } from '../studio/ui';
import type { EditActions } from './controller';
import { boxOf, targetOf } from './source';

/** Inline editing writes the source, so the exported video and the inspector share the same text. */
export const mountInlineEdit = (frameBox: HTMLElement, iframe: HTMLIFrameElement, store: Store, edit: EditActions): void => {
  let area: HTMLTextAreaElement | undefined;
  const close = (save: boolean): void => {
    const current = area; if (!current) return;
    area = undefined;
    if (save) current.dispatchEvent(new Event('commit'));
    current.remove();
  };
  frameBox.addEventListener('studio:inline-edit', e => {
    if (area) return;
    const v = store.get(), selected = v.pinned;
    if (!selected || !v.state || (e.target as HTMLElement).closest('.handle')) return;
    const target = targetOf(v.state,selected);
    const item = selected.kind === 'item' ? v.state.resolved?.items.find(it=>it.id===selected.id) : undefined;
    const slot = selected.kind === 'slot' ? visibleSlots(iframe,store).find(x=>x.selection.id===selected.id&&x.selection.name===selected.name) : undefined;
    if (slot?.image || target?.kind === 'track' && target.track.type === 'image') {
      document.querySelector<HTMLElement>('#slot-inspector select, #edit-form select[data-path$=".material"]')?.focus(); return;
    }
    const text = slot?.value ?? item?.text;
    const box = slot?.box ?? (target ? boxOf(v.state,target) : undefined);
    if (text === undefined || !box) return;
    close(true); e.preventDefault(); e.stopPropagation();
    const input = h('textarea',{id:'stage-text-editor',class:'stage-text-editor',attrs:{'aria-label':v.lang==='zh'?'直接编辑文字':'Edit text on canvas'}});
    input.value=text; placeBox(input,box);
    input.style.fontSize=Math.max(14, (item?.style?.size ?? .04) * (v.state.resolved?.canvas.height ?? 1) * frameBox.clientWidth / (v.state.resolved?.canvas.width ?? 1))+'px';
    input.addEventListener('commit',()=>{
      if (input.value === text || !input.value.trim()) return;
      if (selected.kind === 'slot') {
        const state=store.get().state; const index=rows(object(state?.source).segments).findIndex(s=>s.id===selected.id);
        const base=object(rows(object(state?.source).segments)[index]?.base);
        void edit.send({op:'set',path:['segments',index,'base','slots'],value:{...object(base.slots),[selected.name]:input.value}});
      } else if (target?.kind === 'cue') void edit.send({op:'set',path:['tracks',target.index,'cues',target.cue,'text'],value:input.value});
      else if (target?.kind === 'track') void edit.send({op:'set',path:['tracks',target.index,'text'],value:input.value});
    });
    input.addEventListener('blur',()=>close(true));
    input.addEventListener('pointerdown',event=>event.stopPropagation());
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(false);}
      else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();close(true);}
    });
    frameBox.append(input); area=input; input.focus(); input.select();
  });
  store.subscribe((v,prev)=>{if(v.pinned!==prev.pinned||v.state!==prev.state||v.frame!==prev.frame)close(false);});
};
