import type { Store } from '../app';
import { reorderLayer } from '../edit/layer-order';
import type { EditActions } from '../edit/controller';
import { h, icon } from '../dom';
import { copy } from './copy';
import { button } from './ui';

export const mountStudioTimeline = (root: HTMLElement, store: Store, edit: EditActions): void => {
  const zoom = h('input', { attrs: { type: 'range', min: '100', max: '500', value: '100', 'aria-label': copy(store, 'zoom') } });
  const scale = (): void => root.parentElement?.style.setProperty('--timeline-zoom', String(Number(zoom.value) / 100));
  zoom.addEventListener('input', scale); scale();
  const zh = store.get().lang === 'zh';
  const toggle = (key: 'layers' | 'snapping', label: string): HTMLButtonElement => {
    const el = button(label, () => {
      const value = store.get().timeline ?? { layers: true, snapping: true };
      store.set({ timeline: { ...value, [key]: !value[key] } });
    });
    el.id = 'timeline-' + key;
    return el;
  };
  const layers = toggle('layers', zh ? '图层' : 'Layers'); layers.prepend(icon('layers'));
  const snap = toggle('snapping', zh ? '吸附' : 'Snap');
  const split = button(zh ? '分割' : 'Split', () => void edit.split()); split.id = 'edit-split';
  const order = (delta: number): HTMLButtonElement => button(delta < 0 ? (zh ? '前移' : 'Earlier') : (zh ? '后移' : 'Later'), () => {
    const target = edit.target(); const state = store.get().state;
    if (!state || !target) return;
    if (target.kind === 'segment') void edit.send({op:'move',path:['segments',target.index],to:target.index+delta});
    else {const next=reorderLayer(state,target,delta);if(next)void edit.replace(next,state.source);}
  });
  const earlier = order(-1), later = order(1);
  earlier.id = 'scene-earlier'; later.id = 'scene-later';
  const selection = h('span', { id: 'timeline-selection', class: 'timeline-selection' });
  root.append(h('span', { id: 'edit-slot' }), split, earlier, later, h('span', {class:'timeline-divider'}), layers, snap,
    selection, h('span', {class:'spacer'}), button(copy(store,'viewAll'), () => {zoom.value='100';scale();}), zoom);
  const draw = (): void => {
    const v = store.get(), target = edit.target();
    layers.classList.toggle('selected', v.timeline?.layers !== false);
    snap.classList.toggle('selected', v.timeline?.snapping !== false);
    layers.setAttribute('aria-pressed', String(v.timeline?.layers !== false));
    snap.setAttribute('aria-pressed', String(v.timeline?.snapping !== false));
    split.disabled = Boolean(v.edit.saving) || !edit.canSplit();
    earlier.hidden = later.hidden = !target || target.kind !== 'segment' && target.track.type === 'audio';
    earlier.textContent=target?.kind==='segment'?(zh?'前移':'Earlier'):(zh?'下移图层':'Send backward');
    later.textContent=target?.kind==='segment'?(zh?'后移':'Later'):(zh?'上移图层':'Bring forward');
    earlier.disabled = target?.kind==='segment' ? target.index===0 : !(v.state&&target&&reorderLayer(v.state,target,-1));
    later.disabled = target?.kind==='segment' ? target.index >= (v.state?.resolved?.segments.length ?? 0)-1 : !(v.state&&target&&reorderLayer(v.state,target,1));
    if(v.edit.saving)earlier.disabled=later.disabled=true;
    const picked = v.pinned;
    const field = picked?.kind === 'slot' ? v.slots?.find(s=>s.segment===picked.id&&s.name===picked.name) : undefined;
    const item = picked?.kind === 'item' ? v.state?.resolved?.items.find(it=>it.id===picked.id) : undefined;
    selection.textContent = picked ? picked.kind === 'slot' ? field?.kind==='image'?(zh?'图片':'Image'):field?.value??copy(store,'selected') : item?.text ?? (target?.kind === 'segment' ? (zh?'镜头 ':'Shot ')+(target.index+1) : picked.kind === 'audio' ? copy(store,'audioTrack') : copy(store,'selected')) : (zh ? '点选镜头或画面内容进行编辑' : 'Select a shot or canvas element to edit');
    selection.title = selection.textContent;
  };
  store.subscribe((v,prev)=>{if(v.state!==prev.state||v.pinned!==prev.pinned||v.timeline!==prev.timeline||v.frame!==prev.frame||v.edit.saving!==prev.edit.saving)draw();}); draw();
};
