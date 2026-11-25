import type { Store, Actions } from '../app';
import type { EditActions } from '../edit/controller';
import { h } from '../dom';
import type { SceneSlot, StudioVersion, StudioComment } from '../../studio-data';
import type { RenderInfo } from '../../protocol';
import { segmentAt } from '../model';
import { copy } from './copy';
import { button, field, fileUrl, input, mutate, note, notify, object, request, rows, thumbnail, timecode, title } from './ui';

export interface StudioMeta { hash: string; slots: SceneSlot[]; versions: StudioVersion[]; comments: StudioComment[]; lastExport?: RenderInfo }
export type Panel = 'shots' | 'media' | 'script' | 'elements' | 'code' | 'checks' | 'versions';
export interface Sidebar { store: Store; actions: Actions; edit: EditActions; meta: StudioMeta; refresh(): void }
const current = (ctx: Sidebar) => {
 const v = ctx.store.get(); const r = v.state?.resolved;
 return r ? r.segments.find(s => v.pinned?.kind === 'segment' && s.id === v.pinned.id) ?? segmentAt(r, v.frame) : undefined;
};
const selectShot = (ctx: Sidebar, id: string): void => {
 const s = ctx.store.get().state?.resolved?.segments.find(x => x.id === id);
 if (s) { ctx.actions.pause(); ctx.actions.seek(Math.min(s.end - 1, s.start + Math.floor((s.end - s.start) * 0.3))); ctx.edit.select({ kind: 'segment', id }); }
};
export const shotPanel = (ctx: Sidebar): HTMLElement => {
 const { store, edit } = ctx; const state = store.get().state; const r = state?.resolved;
 const list = h('div', { class: 'studio-shot-list' });
 if (r) for (const s of r.segments) {
  const b = s.base; const label = b.kind === 'scene' ? copy(store, 'scene') : b.kind === 'video' ? copy(store, 'video') : b.kind === 'image' ? copy(store, 'image') : copy(store, 'color');
  const card = button('', () => selectShot(ctx, s.id), 'studio-shot ' + (current(ctx)?.id === s.id ? 'selected' : ''));
  card.append(thumbnail(s.start + Math.floor((s.end - s.start) / 2), state?.generation ?? 0), h('span', { class: 'studio-shot-copy' }, [h('strong', { text: String(s.index + 1).padStart(2, '0') + '  ' + s.id }), h('small', { text: label + ' · ' + ((s.end - s.start) / r.canvas.fps).toFixed(2) + 's' })]));
  card.draggable = Boolean(state?.edit);
  card.addEventListener('dragstart', e => e.dataTransfer?.setData('application/x-popost-segment', String(s.index)));
  card.addEventListener('dragover', e => e.preventDefault());
  card.addEventListener('drop', e => { e.preventDefault(); const i = Number(e.dataTransfer?.getData('application/x-popost-segment')); if (Number.isInteger(i) && i !== s.index) void edit.send({ op: 'move', path: ['segments', i], to: s.index }); });
  list.append(card);
 }
 const search = input('', copy(store, 'search')); search.placeholder = copy(store, 'search');
 search.addEventListener('input', () => list.querySelectorAll<HTMLButtonElement>('.studio-shot').forEach(x => { x.hidden = !x.textContent?.toLowerCase().includes(search.value.toLowerCase()); }));
 return h('div', { class: 'studio-side-body' }, [title(copy(store, 'shots'), String(r?.segments.length ?? 0)), search, list, note(copy(store, 'keepRhythm'))]);
};
const useMaterial = async (ctx: Sidebar, material: Record<string, unknown>, overlay: boolean): Promise<void> => {
 const { store, edit } = ctx; const state = store.get().state; const seg = current(ctx); if (!state || !seg) return;
 const kind = material.kind; const id = String(material.id);
 if (!overlay && ['image', 'video'].includes(String(kind))) { await edit.send({ op: 'set', path: ['segments', seg.index, 'base'], value: { material: id, fit: 'cover' } }); return; }
 const tracks = rows(object(state.source).tracks);
 const type = ['audio', 'voice', 'speech'].includes(String(kind)) ? 'audio' : kind;
 if (!['image', 'video', 'audio'].includes(String(type))) return;
 const track = { id: 'overlay-' + Date.now(), type, material: id, ...(type === 'audio' ? { gain: 0 } : { box: [0.1, 0.1, 0.8, 0.6], fit: 'contain' }), during: { segment: seg.id, from: 0, to: seg.end - seg.start } };
 await edit.send({ op: 'insert', path: ['tracks', tracks.length], value: track });
};
export const mediaPanel = (ctx: Sidebar): HTMLElement => {
 const { store } = ctx; const state = store.get().state;
 const file = h('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/*', hidden: '' } });
 file.addEventListener('change', () => {
  const chosen = file.files?.[0]; if (!chosen) return;
  if (chosen.size > 12 * 1024 * 1024) { notify(store, copy(store, 'importHint')); return; }
  const reader = new FileReader(); reader.onload = () => void mutate(store, '/api/studio/import', { name: chosen.name, data: String(reader.result).split(',')[1] }); reader.readAsDataURL(chosen);
 });
 const list = h('div', { class: 'studio-media-list' });
 for (const m of rows(object(state?.source).materials)) {
  const name = String(m.note ?? m.file ?? m.id); const src = fileUrl(String(m.file ?? ''));
  const visual = m.kind === 'image' ? h('img', { attrs: { src, alt: name, loading: 'lazy' } }) : m.kind === 'video' ? h('video', { attrs: { src, controls: '', preload: 'metadata' } }) : h('audio', { attrs: { src, controls: '', preload: 'none' } });
  const buttons = h('div', { class: 'studio-actions' }, [button(copy(store, 'addOverlay'), () => void useMaterial(ctx, m, true))]);
  if (['image', 'video'].includes(String(m.kind))) buttons.prepend(button(copy(store, 'applyShot'), () => void useMaterial(ctx, m, false)));
  list.append(h('article', { class: 'studio-media-card' }, [visual, h('strong', { text: name, title: name }), note(String(m.kind)), buttons]));
 }
 if (!list.children.length) list.append(note(copy(store, 'noMedia')));
 return h('div', { class: 'studio-side-body' }, [title(copy(store, 'media')), button(copy(store, 'upload'), () => file.click(), 'primary'), file, note(copy(store, 'importHint')), note(copy(store, 'chooseMaterial')), list]);
};
export const scriptPanel = (ctx: Sidebar): HTMLElement => {
 const { store, edit, actions } = ctx; const state = store.get().state;
 const list = h('div', { class: 'studio-script-list' }); const lines: string[] = [];
 rows(object(state?.source).tracks).forEach((track, index) => {
  if (track.type !== 'caption') return;
  rows(track.cues).forEach((cue, i) => {
   lines.push(String(cue.text)); const item = state?.resolved?.items.find(x => x.cue?.track === track.id && x.cue?.index === i);
   const area = h('textarea', { class: 'studio-input', attrs: { 'aria-label': copy(store, 'subtitles') + ' ' + (i + 1), rows: '2' } }); area.value = String(cue.text);
   area.addEventListener('change', () => { void edit.send({ op: 'set', path: ['tracks', index, 'cues', i, 'text'], value: area.value }); notify(store, copy(store, 'pendingVoice')); });
   const jump = button(timecode(item?.start ?? 0, state?.resolved?.canvas.fps ?? 30), () => { if (item) { actions.pause(); actions.seek(item.start); edit.select({ kind: 'item', id: item.id }); } });
   list.append(h('article', { class: 'studio-sentence' }, [jump, area]));
  });
 });
 return h('div', { class: 'studio-side-body' }, [title(copy(store, 'script')), note(copy(store, 'scriptHint'), 'notice'), list, note(copy(store, 'narrationUnavailable')), button(copy(store, 'copyScript'), () => { void navigator.clipboard.writeText(lines.join('\n')).then(() => notify(store, copy(store, 'sourceChanged'))); })]);
};
export const elementsPanel = (ctx: Sidebar): HTMLElement => {
 const { store, edit } = ctx; const state = store.get().state; const seg = current(ctx);
 const root = h('div', { class: 'studio-side-body' }, [title(copy(store, 'elements'), seg?.id)]);
 if (!state || !seg) return root;
 root.append(button(copy(store, 'addText'), () => void edit.addText()));
 for (const item of state.resolved?.items.filter(x => x.end > seg.start && x.start < seg.end) ?? []) root.append(button(item.id + ' · ' + item.type, () => edit.select({ kind: 'item', id: item.id }), 'studio-item'));
 const slots = ctx.meta.slots.filter(x => x.segment === seg.id);
 root.append(title(copy(store, 'sceneFields')));
 for (const slot of slots) {
  const el = slot.kind === 'image' ? input(slot.value, slot.name) : h('textarea', { class: 'studio-input', attrs: { rows: '2', 'aria-label': slot.name } }); el.value = slot.value;
  el.addEventListener('change', () => {
   const base = object(rows(object(store.get().state?.source).segments)[seg.index]?.base);
   void edit.send({ op: 'set', path: ['segments', seg.index, 'base', 'slots'], value: { ...object(base.slots), [slot.name]: el.value } });
  });
  root.append(field(slot.name, el));
  if (slot.kind === 'image') {
   const base = object(rows(object(state.source).segments)[seg.index]?.base);
   const url = new URL(slot.value, location.origin + '/project/' + String(base.scene));
   if (url.origin === location.origin && url.pathname.startsWith('/project/')) root.append(h('img', { class: 'studio-slot-image', attrs: { src: url.href, alt: slot.name } }));
  }
 }
 if (!slots.length && seg.base.kind === 'scene') root.append(note(copy(store, 'noSlots')));
 return root;
};
export const checksPanel = (ctx: Sidebar): HTMLElement => {
 const { store, actions } = ctx; const v = store.get(); const root = h('div', { class: 'studio-side-body' }, [title(copy(store, 'checks'))]);
 for (const p of v.state?.problems ?? []) {
  const card = h('article', { class: 'studio-review-card' }, [h('strong', { text: p.at }), note(p.message), note(p.fix ?? '')]);
  const match = /^segments\[(\d+)\]/.exec(p.at); const seg = match ? v.state?.resolved?.segments[Number(match[1])] : undefined;
  if (seg) card.append(button(copy(store, 'goShot'), () => selectShot(ctx, seg.id))); root.append(card);
 }
 if (!v.state?.problems.length) root.append(note(copy(store, 'noProblems')));
 root.append(note(v.state?.score ? JSON.stringify(Object.fromEntries(Object.entries(v.state.score.dimensions).map(([k, d]) => [k, d.score.toFixed(2)]))) : copy(store, 'unmeasured')));
 root.append(title(copy(store, 'notes')));
 for (const c of ctx.meta.comments) root.append(h('article', { class: 'studio-review-card' }, [button(timecode(c.frame, v.state?.resolved?.canvas.fps ?? 30), () => { actions.pause(); actions.seek(c.frame); }), note(c.text), button(copy(store, c.resolved ? 'reopen' : 'resolve'), () => { void mutate(store, '/api/studio/comment', { id: c.id, resolved: !c.resolved }).then(ctx.refresh); })]));
 const text = h('textarea', { class: 'studio-input', attrs: { rows: '3', placeholder: copy(store, 'noteHint') } });
 root.append(text, button(copy(store, 'comment'), () => { if (text.value.trim()) void mutate(store, '/api/studio/comment', { text: text.value, frame: store.get().frame }).then(ctx.refresh); }), button(copy(store, 'copyNote'), () => { void navigator.clipboard.writeText(timecode(store.get().frame, v.state?.resolved?.canvas.fps ?? 30) + ' · ' + (current(ctx)?.id ?? '') + '\n' + text.value); }), note(copy(store, 'reviewOnly')));
 return root;
};
export const versionsPanel = (ctx: Sidebar): HTMLElement => {
 const { store } = ctx; const root = h('div', { class: 'studio-side-body' }, [title(copy(store, 'versions'))]);
 const name = input('', copy(store, 'versionName')); name.placeholder = copy(store, 'versionName');
 root.append(name, button(copy(store, 'saveVersion'), () => { void mutate(store, '/api/studio/version', { name: name.value || copy(store, 'newVersion') }).then(ctx.refresh); }, 'primary'), note(copy(store, 'versionSnapshot')));
 for (const ver of ctx.meta.versions) root.append(h('article', { class: 'studio-review-card' }, [h('strong', { text: ver.name }), note(new Date(ver.created).toLocaleString()), ...(ver.hash === ctx.meta.hash ? [note(copy(store, 'current'))] : [button(copy(store, 'restore'), () => { void mutate(store, '/api/studio/restore', { id: ver.id, base: store.get().state?.source }).then(ctx.refresh); })])]));
 if (!ctx.meta.versions.length) root.append(note(copy(store, 'noVersions')));
 return root;
};
export const loadMetadata = (): Promise<StudioMeta> => request<StudioMeta>('/api/studio');
