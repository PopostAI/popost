import type { Store, Actions } from '../app';
import type { EditActions } from '../edit/controller';
import { h, icon, type IconName } from '../dom';
import { copy, type CopyKey } from './copy';
import { button, note, title } from './ui';
import { checksPanel, elementsPanel, loadMetadata, mediaPanel, scriptPanel, shotPanel, versionsPanel, type Panel, type Sidebar } from './sidebar';
import { createCodeEditor } from './code';
import { mountCloud } from './cloud';
import { openExport } from './export';

const NAV: readonly [Panel, CopyKey, IconName][] = [['media','media','media'],['elements','elements','layers'],['script','subtitles','text'],['code','code','code']];
export const mountWorkspace = (root: HTMLElement, store: Store, actions: Actions, edit: EditActions) => {
 let active: Panel = 'media';
 const rail = h('nav', { class: 'studio-rail', attrs: { 'aria-label': 'Studio' } });
 const content = h('aside', { id: 'studio-content', class: 'studio-content' });
 const codeEditor = createCodeEditor(store, edit); const code = codeEditor.root;
 const ctx: Sidebar = { store, actions, edit, meta: { hash: '', slots: [], versions: [], comments: [] }, refresh: () => undefined };
 const draw = (): void => {
  rail.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.classList.toggle('active', b.dataset.panel === active); b.setAttribute('aria-pressed', String(b.dataset.panel === active)); });
  document.body.classList.toggle('panel-code', active === 'code');
  if (active === 'code') { if (!content.contains(code)) content.replaceChildren(code); return; }
  const panels = { shots: shotPanel, media: mediaPanel, script: scriptPanel, elements: elementsPanel, checks: checksPanel, versions: versionsPanel };
  content.replaceChildren(panels[active](ctx));
 };
 const choose = (panel: Panel): void => { active = panel; draw(); };
 for (const [panel, key, image] of NAV) {
  const b = h('button', { data: { panel }, attrs: { type: 'button', title: copy(store, key) }, on: { click: () => choose(panel) } }, [icon(image), h('span', { text: copy(store, key) })]); rail.append(b);
 }
 const refresh = async (): Promise<void> => {
  const generation = store.get().state?.generation;
  try { const meta = await loadMetadata(); if (generation !== store.get().state?.generation) return; ctx.meta = meta;
    if (meta.lastExport && store.get().edit.render?.state !== 'running' && (!store.get().edit.render || store.get().edit.render?.state === 'idle')) edit.setRender(meta.lastExport);
    draw();
  } catch { /* Read-only previews have no editing metadata. */ }
 };
 ctx.refresh = () => { void refresh(); };
 root.prepend(rail, content);
 const top = document.querySelector<HTMLElement>('.studio-topbar')!;
 const brand = h('strong', { class: 'studio-brand', text: 'popost' });
 const project = h('span', { class: 'studio-project' }); const saved = h('span', { class: 'studio-save' });
 const toolbar = h('span', { class: 'studio-global-actions' });
 const compare = button(copy(store, 'compare'), () => { if (store.get().edit.playRender) edit.togglePlayRender(); store.set({ compare: !store.get().compare }); });
 const layout = button(copy(store, 'layout'), () => document.body.classList.toggle('focus-preview'));
 const theme = button('◐', () => { const dark = document.documentElement.classList.toggle('dark'); localStorage.setItem('popost-studio-theme', dark ? 'dark' : 'light'); });
 const lang = button(store.get().lang === 'zh' ? 'EN' : '中文', () => { const next = store.get().lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('popost-studio-language', next); actions.setLang(next); location.reload(); }); lang.id = 'lang-toggle';
 const version = button(copy(store, 'versions'), () => choose('versions'));
 const exportButton = button(copy(store, 'export'), () => openExport(store, edit), 'primary'); exportButton.id = 'studio-export-open';
 toolbar.append(compare, layout, version, theme, lang); mountCloud(toolbar,store, async () => { if (!await edit.flush()) return false; return await codeEditor.flush() && await edit.flush(); }); toolbar.append(exportButton); top.append(brand, project, saved, toolbar);
 document.documentElement.classList.toggle('dark', localStorage.getItem('popost-studio-theme') === 'dark');
 document.addEventListener('studio:export', () => openExport(store, edit));
 const stageBar = document.getElementById('studio-stage-heading')!;
 const playAudio = h('input', { attrs: { type: 'checkbox', 'aria-label': copy(store, 'audio') } }); playAudio.checked = true;
 playAudio.addEventListener('change', () => store.set({ muted: !playAudio.checked }));
 stageBar.append(h('span', { text: copy(store, 'preview') }), h('label', { class: 'studio-check', title: copy(store, 'onlyPreview') }, [playAudio, copy(store, 'audio')]));
 const props = document.querySelector<HTMLElement>('.panel')!;
 props.prepend(title(copy(store, 'properties')));
 const update = (): void => {
  const v = store.get(); project.textContent = v.state?.project.name ?? 'Popost Video Studio';
  saved.textContent = v.connected ? v.state?.edit ? copy(store, 'saved') : copy(store, 'readOnly') : copy(store, 'offline');
  if (v.edit.status?.kind === 'refused') saved.textContent = v.edit.status.problem.message;
  compare.classList.toggle('selected', Boolean(v.compare)); exportButton.disabled = !v.state?.edit || !v.state.resolved;
  props.hidden = !v.pinned;
  document.body.classList.toggle('inspecting', Boolean(v.pinned));
 };
 store.subscribe((v, prev) => {
  if (v.state !== prev.state || v.pinned !== prev.pinned || v.compare !== prev.compare || v.connected !== prev.connected || v.edit.status !== prev.edit.status) update();
  if (v.state !== prev.state) { draw(); void refresh(); }
  else if (v.frame !== prev.frame && active === 'elements' && v.state?.resolved?.segments.find(s => v.frame >= s.start && v.frame < s.end)?.id !== prev.state?.resolved?.segments.find(s => prev.frame >= s.start && prev.frame < s.end)?.id) draw();
  if (v.pinned !== prev.pinned) content.querySelectorAll<HTMLElement>('[data-selection]').forEach(el => { const selected = el.dataset.selection === JSON.stringify(v.pinned); el.classList.toggle('selected', selected); if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(selected)); });
 });
 document.addEventListener('studio:page-ready',()=>{if(active==='elements')draw();});
 update(); draw();
 return { refresh, choose, content, panel: () => active };
};
export const mountTimelineTools = (root: HTMLElement, store: Store, edit: EditActions): void => {
 root.parentElement?.style.setProperty('--timeline-zoom','2');
 const zoom = h('input', { attrs: { type: 'range', min: '100', max: '500', value: '200', 'aria-label': copy(store, 'zoom') } });
 zoom.addEventListener('input', () => root.parentElement?.style.setProperty('--timeline-zoom', String(Number(zoom.value) / 100)));
 const tools = h('span', { id: 'edit-slot' });
 const split = button(store.get().lang === 'zh' ? '分割' : 'Split', () => void edit.split()); split.id = 'edit-split';
 root.append(tools, split, h('span', { class: 'spacer' }), button(copy(store, 'viewAll'), () => { zoom.value = '100'; root.parentElement?.style.setProperty('--timeline-zoom','1'); }), note(copy(store, 'zoom')), zoom);
 const update = (): void => { split.disabled = !edit.canSplit(); }; store.subscribe(update); update();
};
export const resizeHandle = (target: HTMLElement, axis: 'left' | 'right' | 'timeline'): HTMLElement => {
 const horizontal = axis === 'timeline'; const el = h('div', { class: 'studio-handle ' + (horizontal ? 'horizontal' : 'vertical') + (axis === 'right' ? ' inspector-resize' : ''), attrs: { role: 'separator', tabindex: '0', 'aria-orientation': horizontal ? 'horizontal' : 'vertical' } });
 if (!horizontal) el.style.left = axis === 'left' ? 'calc(64px + var(--left-width) - 2px)' : 'calc(100% - var(--right-width) - 2px)';
 el.addEventListener('pointerdown', e => {
  el.setPointerCapture(e.pointerId); const start = horizontal ? e.clientY : e.clientX;
  const variable = horizontal ? '--timeline-height' : axis === 'left' ? '--left-width' : '--right-width';
  const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable));
  const move = (m: PointerEvent): void => { const delta = (horizontal ? m.clientY : m.clientX) - start; const next = Math.min(horizontal ? innerHeight * .65 : innerWidth * .4, Math.max(horizontal ? 150 : 210, size + (axis === 'left' ? delta : -delta))); document.documentElement.style.setProperty(variable, next + 'px'); };
  const done = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', done); localStorage.setItem('popost-studio-layout', document.documentElement.style.cssText); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', done);
 }); target.append(el); return el;
};
