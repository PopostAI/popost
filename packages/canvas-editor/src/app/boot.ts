import type { DocStore, HostParams, LocalBoot } from '../contracts';
import { createFrameController } from '../frame';
import { installStoreChanges } from '../host/changes';
import { installTheme } from '../host/theme';
import { rawQuery, parseParams, parseImageOrigins, readLocalBoot } from '../host/params';
import { createBrowserStore, projectIdFromFile } from '../storage/browser-store';
import { createHostStore } from '../storage/host-store';
import { createLocalStore } from '../storage/local-store';
import { createEditorController } from './controller';
import type { EditorHandle } from './controller';
import { bindTestHooks } from './hooks';

export const LANG_KEY = 'popost-canvas:lang';
/** Written by the previous editor; read once as a fallback when neither the URL nor our key has a language. */
const LEGACY_LANG_KEY = 'gs9_editor_lang';
/** Local mode: page files live under `/pages/`, so the preview resolves relative URLs from there. */
export const LOCAL_BASE_HREF = '/pages/';

/**
 * `<base href>` for previews and thumbnails: local mode resolves from `/pages/`; host mode previews are `blob:`
 * documents, so an absolute site root lets root-relative resources of the host (such as `/api/assets/...`) load.
 */
export function previewBaseHref(params: Pick<HostParams, 'store'>, local: LocalBoot | null, origin: string): string | undefined {
  if (local) return LOCAL_BASE_HREF;
  return params.store === 'host' ? `${origin}/` : undefined;
}

export interface EditorBoot {
  controller: EditorHandle;
  params: HostParams;
  local: LocalBoot | null;
  lang: 'zh' | 'en';
  baseHref: string | undefined;
  dispose(): void;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the language just is not remembered.
  }
}

/** `lang` from the query, else the remembered choice (ours, then the legacy key), else `zh`; remembers the result. */
export function resolveLang(query: string): 'zh' | 'en' {
  const fromQuery = new URLSearchParams(query).get('lang');
  const raw = fromQuery || storageGet(LANG_KEY) || storageGet(LEGACY_LANG_KEY);
  const lang = raw === 'en' ? 'en' : 'zh';
  storageSet(LANG_KEY, lang);
  return lang;
}

export function documentTitle(name: string, dirty: boolean): string {
  return `${dirty ? '• ' : ''}${name || 'Popost'}`;
}

/**
 * Wire params, store, edit frame and controller, plus the page-level hooks that do not belong to any component:
 * theme (param + M1), external changes (M8, host store), `body[data-doc-*]` test attributes, document title and the `beforeunload` prompt.
 * Starts loading the document; the UI attaches `#frame` with `controller.attachFrame`.
 */
export function bootEditor(): EditorBoot {
  const query = rawQuery();
  const lang = resolveLang(query);
  const params: HostParams = { ...parseParams(query), lang };
  const local = readLocalBoot();
  const store: DocStore = local ? createLocalStore(local) : params.store === 'host' ? createHostStore(params) : createBrowserStore(params);
  const baseHref = previewBaseHref(params, local, window.location.origin);
  const frame = createFrameController({ store, baseHref, imageOrigins: local ? [] : parseImageOrigins(query, params.store) });
  const controller = createEditorController({ store, frame, params });

  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  const offTheme = installTheme(params);
  const offChanges = params.store === 'host' && !local ? installStoreChanges(projectIdFromFile(params.file), () => void controller.externalChange()) : () => {};
  const offHooks = bindTestHooks(controller, document.body);
  const syncTitle = (): void => {
    const s = controller.getSnapshot();
    const title = documentTitle(s.name, s.saveState !== 'saved');
    if (document.title !== title) document.title = title;
  };
  syncTitle();
  const offTitle = controller.subscribe(syncTitle);
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (controller.getSnapshot().saveState === 'saved') return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  void controller.start();

  return {
    controller,
    params,
    local,
    lang,
    baseHref,
    dispose() {
      window.removeEventListener('beforeunload', onBeforeUnload);
      offTitle();
      offHooks();
      offTheme();
      offChanges();
      controller.dispose();
    },
  };
}
