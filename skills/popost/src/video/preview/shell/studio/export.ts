import type { Store } from '../app';
import type { EditActions } from '../edit/controller';
import { h } from '../dom';
import type { RenderInfo } from '../../protocol';
import { copy } from './copy';
import { button, field, input, note, notify, request, select, title } from './ui';

export const openExport = (store: Store, edit: EditActions): void => {
 if (document.getElementById('studio-export')) return;
 const state = store.get().state; if (!state?.resolved || !state.edit) return;
 const r = state.resolved; let premium = false;
 let resolution = 'original'; let fps = ''; let bitrate = ''; let range = 'full';
 const name = input('Popost-video', copy(store, 'filename'));
 const from = input('0', copy(store, 'start')); from.type = 'number'; from.min = '0';
 const to = input(String(r.frames), copy(store, 'end')); to.type = 'number'; to.min = '1';
 const audio = h('input', { attrs: { type: 'checkbox' } }); audio.checked = true;
 const info = h('div', { class: 'studio-paid-info', attrs: { role: 'status' } });
 const result = h('div', { class: 'studio-export-result', attrs: { role: 'status' } });
 const progress = h('progress', { attrs: { max: '1', value: '0' } });
 const close = (): void => { unsubscribe(); scrim.remove(); dialog.remove(); };
 const scrim = h('div', { class: 'studio-scrim', on: { click: close } });
 const dialog = h('aside', { id: 'studio-export', class: 'studio-export', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': copy(store, 'export') } });
 const choose = h('div', { class: 'studio-resolutions', attrs: { role: 'group', 'aria-label': copy(store, 'resolution') } });
 const paid = (): void => {
   info.replaceChildren(note(copy(store, 'paidInfo')), h('a', { text: copy(store, 'unlock'), attrs: { href: 'https://popost.ai/' + (store.get().lang === 'zh' ? 'zh' : 'en') + '/pricing', target: '_blank', rel: 'noopener noreferrer' } }), button(copy(store, 'refreshPlan'), () => void refresh()));
 };
 const drawResolutions = (): void => {
   choose.replaceChildren(...(['original', '480', '720', '1080', '1440', '2160'] as const).map(value => {
     const edge = value === 'original' ? Math.min(r.canvas.width, r.canvas.height) : Number(value);
     const locked = edge > 1080 && !premium;
     const label = value === 'original' ? copy(store, 'original') : value === '1440' ? '2K' : value === '2160' ? '4K' : value + 'p';
     const el = button(label, () => { if (locked) paid(); else { resolution = value; info.replaceChildren(); drawResolutions(); } }, resolution === value ? 'selected' : '');
     el.setAttribute('aria-pressed', String(resolution === value));
     if (locked) {
       const gem = h('span', { class: 'export-gem', text: '◇', attrs: { 'aria-label': copy(store, 'paid'), tabindex: '0', role: 'button' }, on: { mouseenter: paid, focus: paid } }); el.append(gem);
     }
     return el;
   }));
 };
 const refresh = async (): Promise<void> => {
   try { const a = await request<{ premium: boolean }>('/api/export-options'); premium = a.premium; drawResolutions(); }
   catch { premium = false; drawResolutions(); }
 };
 const rangeFields = h('div', { class: 'studio-field-grid', attrs: { hidden: '' } }, [field(copy(store, 'start'), from), field(copy(store, 'end'), to)]);
 const options = h('fieldset', { class: 'studio-export-fields' }, [
  field(copy(store, 'filename'), name),
  field(copy(store, 'dynamicRange'), h('div', { class: 'studio-segments' }, [button('SDR', () => undefined, 'selected'), h('button', { text: 'HDR', attrs: { type: 'button', disabled: '', title: copy(store, 'hdrUnavailable') } })])),
  note(copy(store, 'hdrUnavailable')),
  field(copy(store, 'resolution'), choose), info,
  field(copy(store, 'fps'), select([['', copy(store, 'match') + ' (' + r.canvas.fps + ' fps)'], ...[24, 25, 30, 50, 60].map(n => [String(n), n + ' fps'] as [string, string])], '', copy(store, 'fps'), value => { fps = value; })),
  field(copy(store, 'bitrate'), select([['', copy(store, 'recommended')], ...[2, 5, 8, 12, 20, 40].map(n => [String(n), n + ' Mbps'] as [string, string])], '', copy(store, 'bitrate'), value => { bitrate = value; })),
  field(copy(store, 'range'), select([['full', copy(store, 'full')], ['range', copy(store, 'range')]], 'full', copy(store, 'range'), value => { range = value; rangeFields.hidden = value === 'full'; })), rangeFields,
  h('label', { class: 'studio-check' }, [audio, copy(store, 'includeAudio')]),
 ]);
 const render = button(copy(store, 'currentExport'), () => {
   void request<{ render: RenderInfo }>('/api/render', {
     name: name.value, resolution, dynamicRange: 'sdr', fps: fps ? Number(fps) : null, bitrate: bitrate ? Number(bitrate) : null, audio: audio.checked,
     ...(range === 'range' ? { from: Number(from.value), to: Number(to.value) } : {}),
   }).then(answer => edit.setRender(answer.render)).catch(e => notify(store, String(e)));
 }, 'primary');
 const draw = (): void => {
   const job = store.get().edit.render;
   const busy = job?.state === 'running'; options.disabled = busy; render.disabled = busy;
   progress.hidden = !busy;
   if (job?.state === 'running') { progress.value = job.total ? job.frame / job.total : 0; render.textContent = copy(store, 'rendering') + ' ' + Math.round(progress.value * 100) + '%'; result.replaceChildren(); }
   else {
     render.textContent = copy(store, 'currentExport');
     if (job?.state === 'failed') result.replaceChildren(note(job.message, 'bad'));
     if (job?.state === 'done') result.replaceChildren(title(copy(store, 'renderDone')), note([job.width && job.height ? job.width + ' × ' + job.height : '', job.fps ? job.fps + ' fps' : ''].filter(Boolean).join(' · ')), button(copy(store, 'play'), () => { edit.togglePlayRender(); store.set({ compare: true }); close(); }), h('a', { class: 'studio-btn primary', text: copy(store, 'downloadVideo'), attrs: { href: job.url, download: (name.value || 'Popost-video') + '.mp4' } }));
   }
 };
 dialog.append(h('div', { class: 'studio-export-header' }, [title(copy(store, 'export')), button('×', close)]), options, progress, render, note(copy(store, 'exportSnapshot')), result);
 document.body.append(scrim, dialog); drawResolutions(); void refresh(); draw();
 const unsubscribe = store.subscribe((v, prev) => { if (dialog.isConnected && v.edit.render !== prev.edit.render) draw(); });
 dialog.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }); name.focus();
};
