/**
 * Entry of the preview shell (bundled by ../html.ts). Builds the layout, loads /api/state, and reloads it on every
 * "reload" event of /api/events, keeping the current frame. The read-only preview never sends anything back; when the
 * state says the server is in edit mode, the edit parts (edit/) are mounted on top of the same layout.
 */
import { RELOAD_EVENT, RENDER_EVENT, type PreviewState, type RenderInfo } from '../protocol';
import { createActions, createStore, NO_EDIT, type Actions, type Overlays, type Store, type View } from './app';
import { h } from './dom';
import { createEditActions, keepSelection, storedSelection, type EditActions } from './edit/controller';
import { mountLanesEdit } from './edit/lanes-edit';
import { fetchSchemas } from './edit/schema';
import { mountStageEdit } from './edit/stage-edit';
import { editKeys, mountStatus, mountToolbar } from './edit/toolbar';
import { defaultLang, t } from './i18n';
import { mountLanes } from './lanes';
import { clampFrame, timelineFrames } from './model';
import { mountPanel } from './panel';
import { mountStage, type StageParts } from './stage';
import { mountTransport } from './transport';

const fetchState = async (): Promise<PreviewState> => {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error('GET /api/state answered ' + res.status);
  return (await res.json()) as PreviewState;
};

const OVERLAYS: readonly (keyof Overlays)[] = ['boxes', 'events', 'safe'];

const header = (store: Store, actions: Actions): HTMLElement => {
  const title = h('h1');
  const project = h('span', { class: 'project', id: 'project' });
  const status = h('span', { class: 'status', id: 'status' });
  const toggles = OVERLAYS.map((name) => {
    const input = h('input', { id: 'toggle-' + name, attrs: { type: 'checkbox' } });
    input.addEventListener('change', () => {
      actions.toggleOverlay(name);
      // Give the keys back to the transport (Space, arrows).
      input.blur();
    });
    const text = h('span');
    return { name, input, text, el: h('label', { class: 'toggle' }, [input, text]) };
  });
  const lang = h('button', { id: 'lang-toggle', class: 'tbtn', attrs: { type: 'button' } });
  lang.addEventListener('click', () => {
    actions.setLang(store.get().lang === 'en' ? 'zh' : 'en');
    lang.blur();
  });
  const draw = (v: View): void => {
    const s = v.state;
    title.textContent = t(v.lang, 'title');
    project.textContent = s ? s.project.name + (s.resolved ? '  ' + s.resolved.frames + 'f, ' + (s.resolved.frames / s.resolved.canvas.fps).toFixed(2) + ' s' : '') : '';
    project.title = s?.project.dir ?? '';
    status.textContent = t(v.lang, s?.edit ? 'editing' : 'readOnly') + ', ' + t(v.lang, v.connected ? 'live' : 'offline');
    status.classList.toggle('offline', !v.connected);
    toggles.forEach((tg) => {
      tg.text.textContent = t(v.lang, tg.name);
      tg.input.checked = v.overlays[tg.name];
    });
    lang.textContent = t(v.lang, 'language');
    lang.title = t(v.lang, 'languageTitle');
  };
  draw(store.get());
  store.subscribe((v, prev) => {
    if (v.state !== prev.state || v.lang !== prev.lang || v.connected !== prev.connected || v.overlays !== prev.overlays) draw(v);
  });
  return h('header', {}, [title, project, ...toggles.map((tg) => tg.el), h('span', { id: 'edit-slot', class: 'edit-slot' }), status, lang]);
};

interface EditParts { store: Store; edit: EditActions; stage: StageParts; lanes: HTMLElement; panel: HTMLElement; events: EventSource }

/** Mounts edit mode once the first state says the server offers it: buttons, status line, stage and lane editing, keys. */
const mountEdit = (p: EditParts, state: PreviewState): void => {
  document.body.classList.add('editing');
  const slot = document.getElementById('edit-slot');
  if (slot) mountToolbar(slot, p.store, p.edit);
  mountStatus(p.panel, p.store, p.edit);
  const stage = mountStageEdit(p.stage.frameBox, p.stage.iframe, p.store, p.edit);
  mountLanesEdit(p.lanes, p.store, p.edit);
  editKeys(p.store, p.edit, stage.nudge);
  keepSelection(p.store);
  const kept = storedSelection(state);
  if (kept) p.edit.select(kept);
  if (state.edit && state.edit.render.state !== 'idle') p.edit.setRender(state.edit.render);
  p.events.addEventListener(RENDER_EVENT, (e) => p.edit.setRender(JSON.parse((e as MessageEvent<string>).data) as RenderInfo));
  void fetchSchemas().then((schema) => p.store.set({ edit: { ...p.store.get().edit, schema } }));
};

const boot = (): void => {
  const lang = defaultLang(navigator.language);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  const store = createStore({
    state: null, frame: 0, playing: false, speed: 1, lang, pinned: null,
    overlays: { boxes: false, events: true, safe: false }, connected: true, pageError: null, edit: NO_EDIT,
  });
  const actions = createActions(store);
  const edit = createEditActions(store, actions);
  const app = document.getElementById('app') ?? document.body;
  const stage = h('div', { class: 'stage-area', id: 'stage' });
  const transport = h('div', { class: 'transport', id: 'transport' });
  const timeline = h('div', { class: 'timeline', id: 'timeline' });
  const panel = h('aside', { class: 'panel', id: 'panel' });
  app.append(header(store, actions), h('div', { class: 'main' }, [h('div', { class: 'left' }, [stage, transport, timeline]), panel]));
  const stageParts = mountStage(stage, store, actions);
  mountTransport(transport, store, actions);
  mountLanes(timeline, store, actions);
  mountPanel(panel, store, actions, edit);
  const events = new EventSource('/api/events');
  let editing = false;

  const refresh = async (): Promise<void> => {
    try {
      const state = await fetchState();
      const shown = store.get();
      // An answer that was overtaken (by an edit's answer, or a later reload) is older than what is shown; after a
      // lost connection the server may have restarted and counts from 0 again, so then any state is taken.
      if (shown.connected && shown.state && state.generation < shown.state.generation) return;
      store.set({ state, frame: clampFrame(store.get().frame, timelineFrames(state)), connected: true });
      if (state.edit && !editing) {
        editing = true;
        mountEdit({ store, edit, stage: stageParts, lanes: timeline.querySelector<HTMLElement>('#lanes') ?? timeline, panel, events }, state);
      }
    } catch {
      store.set({ connected: false });
    }
  };
  events.addEventListener(RELOAD_EVENT, () => void refresh());
  events.addEventListener('open', () => {
    // After the server came back, its state may have changed while no event could arrive.
    if (!store.get().connected) void refresh();
  });
  events.addEventListener('error', () => { if (store.get().connected) store.set({ connected: false }); });
  void refresh();
};

boot();
