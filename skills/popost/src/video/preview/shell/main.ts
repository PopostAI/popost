import { RELOAD_EVENT, RENDER_EVENT, type PreviewState, type RenderInfo } from '../protocol';
import { createActions, createStore, NO_EDIT } from './app';
import { h } from './dom';
import { createEditActions, keepSelection, storedSelection } from './edit/controller';
import { mountLanesEdit } from './edit/lanes-edit';
import { fetchSchemas } from './edit/schema';
import { mountStageEdit } from './edit/stage-edit';
import { editKeys, mountStatus, mountToolbar } from './edit/toolbar';
import { defaultLang } from './i18n';
import { mountLanes } from './lanes';
import { clampFrame, timelineFrames } from './model';
import { mountPanel } from './panel';
import { mountStage } from './stage';
import { mountTransport } from './transport';
import { mountWorkspace, mountTimelineTools, resizeHandle } from './studio/workspace';
import { mountProjectAudio } from './studio/audio';
import { bootReadonly } from './readonly';

const boot = (): void => {
 const preference = localStorage.getItem('popost-studio-language');
 const lang = preference === 'zh' || preference === 'en' ? preference : defaultLang(navigator.language);
 document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
 document.body.classList.add('studio');
 const savedLayout = localStorage.getItem('popost-studio-layout');
 if (savedLayout && /^[-a-z0-9:;. %px]+$/i.test(savedLayout)) document.documentElement.style.cssText = savedLayout;
 const store = createStore({ state: null, frame: 0, playing: false, speed: 1, lang, pinned: null, compare: false, muted: false,
  overlays: { boxes: false, events: false, safe: false }, connected: true, pageError: null, edit: NO_EDIT });
 const actions = createActions(store); const edit = createEditActions(store, actions);
 const app = document.getElementById('app') ?? document.body;
 const top = h('header', { class: 'studio-topbar' });
 const stage = h('div', { class: 'stage-area', id: 'stage' });
 const transport = h('div', { class: 'transport', id: 'transport' });
 const timeline = h('div', { class: 'timeline', id: 'timeline' });
 const panel = h('aside', { class: 'panel', id: 'panel' });
 const main = h('div', { class: 'main' }, [h('div', { class: 'left' }, [h('div', { id: 'studio-stage-heading', class: 'studio-stage-heading' }), stage, transport]), panel]);
 const timelineTools = h('div', { class: 'studio-timeline-toolbar' });
 const timelineWrap = h('div', { class: 'studio-timeline-wrap' }, [timelineTools, timeline]);
 const footer = h('footer', { class: 'studio-footer' }, ['Popost Video Studio', 'video.json']);
 app.append(top, main, timelineWrap, footer, h('div', { id: 'studio-message', attrs: { role: 'status' } }));
 mountWorkspace(main, store, actions, edit); mountTimelineTools(timelineTools, store);
 resizeHandle(main, 'left'); resizeHandle(main, 'right'); resizeHandle(timelineWrap, 'timeline');
 const stageParts = mountStage(stage, store, actions);
 mountTransport(transport, store, actions); mountLanes(timeline, store, actions); mountPanel(panel, store, actions, edit); mountProjectAudio(store);
 const events = new EventSource('/api/events'); let editing = false;
 const refresh = async (): Promise<void> => {
  try {
   const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error();
   const state = await response.json() as PreviewState; const previous = store.get();
   if (previous.connected && previous.state && state.generation < previous.state.generation) return;
   store.set({ state, frame: clampFrame(previous.frame, timelineFrames(state)), connected: true });
   if (state.edit && !editing) {
    editing = true; document.body.classList.add('editing');
    mountToolbar(document.getElementById('edit-slot')!, store, edit); mountStatus(panel, store, edit);
    const stageEdit = mountStageEdit(stageParts.frameBox, stageParts.iframe, store, edit);
    mountLanesEdit(timeline.querySelector<HTMLElement>('#lanes') ?? timeline, store, edit); editKeys(store, edit, stageEdit.nudge); keepSelection(store);
    const kept = storedSelection(state); if (kept) edit.select(kept);
    if (state.edit.render.state !== 'idle') edit.setRender(state.edit.render);
    void fetchSchemas().then(schema => store.set({ edit: { ...store.get().edit, schema } }));
   }
  } catch { store.set({ connected: false }); }
 };
 events.addEventListener(RELOAD_EVENT, () => void refresh());
 events.addEventListener(RENDER_EVENT, e => edit.setRender(JSON.parse((e as MessageEvent<string>).data) as RenderInfo));
 events.addEventListener('open', () => { if (!store.get().connected) void refresh(); });
 events.addEventListener('error', () => { if (store.get().connected) store.set({ connected: false }); });
 void refresh();
};
if (document.documentElement.dataset.mode === 'readonly') bootReadonly(); else boot();
