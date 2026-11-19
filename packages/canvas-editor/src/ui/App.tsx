import { isFromHost } from '../host/messaging';
import { hostProject } from '../host/project-tools';
import { readLocalBoot } from '../host/params';
import { addPage } from './pageops';
import type { CropRequest } from './PageDesign';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { EditorHandle } from '../app';
import { createActions } from './actions';
import { hasDismissable } from './dismiss';
import { FormatToolbar } from './FormatToolbar';
import { Filmstrip } from './Filmstrip';
import { errorText, I18nProvider, noticeText, useT } from './i18n';
import type { Lang } from './i18n';
import { Gestures, IDLE_VIEW } from './interaction/gestures';
import type { GestureView } from './interaction/gestures';
import { isTypingTarget, resolveKey } from './logic/keymap';
import type { KeyInfo } from './logic/keymap';
import { isImgBlock, useImageDrop } from './ImageTools';
import { ConflictModal } from './Modals';
import { PanelHost, Rail } from './SidePanel';
import type { PanelId } from './SidePanel';
import { useReferenceImages } from './ReferenceComparison';
import { Stage } from './Stage';
import { StatusBar } from './StatusBar';
import { ToastProvider, useToast } from './toasts';
import { Topbar } from './Topbar';
import { useSnapshot } from './use-snapshot';
import { useZoom } from './use-zoom';

export interface AppProps {
  controller: EditorHandle;
  lang: Lang;
  /** Local mode: `<base href>` for thumbnail previews (relative resources). */
  baseHref?: string;
}

export function App({ controller, lang, baseHref }: AppProps) {
  return (
    <I18nProvider lang={lang}>
      <ToastProvider>
        <Shell controller={controller} baseHref={baseHref} />
      </ToastProvider>
    </I18nProvider>
  );
}

/** Wide enough for the Layers panel to open by default. */
const WIDE_VIEWPORT = 900;
const DEFAULT_PANEL_DELAY_MS = 120;

/** Buttons never take focus from the frame (a blur would commit an inline text edit). */
function keepFocus(e: ReactMouseEvent<HTMLElement>): void {
  const target = e.target as HTMLElement;
  if (target.closest('button, [data-keepfocus]')) e.preventDefault();
}

function Shell({ controller, baseHref }: { controller: EditorHandle; baseHref: string | undefined }) {
  const t = useT();
  const toast = useToast();
  const snap = useSnapshot(controller);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [resize, setResize] = useState<CropRequest | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const crop = useMemo(() => ({ id: cropId, setId: setCropId }), [cropId]);
  const exitCrop = useCallback(() => setCropId(null), []);
  useImageDrop(controller);
  // Double-click on an image enters crop & align mode.
  useEffect(
    () =>
      controller.onFrameEvent((m) => {
        if (m.type === 'pointer' && m.action === 'dblclick' && m.id !== null && isImgBlock(controller, m.id)) setCropId(m.id);
      }),
    [controller],
  );

  const page = controller.pageSize();
  const local = readLocalBoot();
  const localComparison = local?.comparison === true;
  const [comparing, setComparing] = useState(() => localComparison || new URLSearchParams(window.location.search).get('compare') === '1');
  const references = useReferenceImages(Boolean(local));
  const showReference = comparing;
  const zoom = useZoom(page, showReference);
  const toggleComparison = () => { setComparing((value) => !value); zoom.fit(); };

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Gestures publish their view (guides, tooltip, marquee) to whoever subscribed (the stage).
  const viewListeners = useRef(new Set<(v: GestureView) => void>());
  const lastView = useRef<GestureView>(IDLE_VIEW);
  const subscribeView = useCallback((l: (v: GestureView) => void) => {
    viewListeners.current.add(l);
    l(lastView.current);
    return () => {
      viewListeners.current.delete(l);
    };
  }, []);
  const gestures = useMemo(
    () =>
      new Gestures({
        controller,
        getZoom: () => zoomRef.current.get() / 100,
        onView: (v) => {
          lastView.current = v;
          viewListeners.current.forEach((l) => l(v));
        },
      }),
    [controller],
  );
  useEffect(() => gestures.attach(), [gestures]);

  const actions = useMemo(
    () =>
      createActions({
        controller,
        gestures,
        toast,
        t,
        zoom: { step: (d) => zoomRef.current.step(d), fit: () => zoomRef.current.fit() },
      }),
    [controller, gestures, toast, t],
  );

  useEffect(() => {
    let queued: string | null = null;
    const applyDraft = () => {
      if (queued === null || controller.getSnapshot().docState !== 'ready') return;
      const html = queued;
      queued = null;
      controller.endTextEdit(true);
      const error = controller.replaceSource(html);
      toast(t(error === null ? 'history.draftRestored' : 'history.draftFailed'), error === null ? 'info' : 'error');
    };
    const onDraft = (event: MessageEvent) => {
      if (!isFromHost(event, 'popost-workspace') || event.data.id !== hostProject() || event.data.type !== 'restore-draft' || typeof event.data.html !== 'string') return;
      queued = event.data.html;
      applyDraft();
    };
    window.addEventListener('message', onDraft);
    const off = controller.subscribe(applyDraft);
    return () => { off(); window.removeEventListener('message', onDraft); };
  }, [controller, t, toast]);

  // Toasts for controller outcomes.
  useEffect(() => controller.onNotice((n) => {
    if (n.key !== 'textOverflow') toast(noticeText(t, n), n.kind === 'error' ? 'error' : 'info');
  }), [controller, toast, t]);

  // One keymap for window keys and keys forwarded from the frame.
  useEffect(() => {
    const handle = (k: KeyInfo, typing: boolean): boolean => {
      const s = controller.getSnapshot();
      if (s.docState !== 'ready' || s.conflict) return false;
      const action = resolveKey(k, { selectionCount: s.selection.length, editing: s.editingTextId !== null });
      if (!action) return false;
      if (typing && action.type !== 'save' && !(action.type === 'escape' && hasDismissable())) return false;
      return actions.run(action);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      const plain = !e.ctrlKey && !e.metaKey;
      if (plain && target?.closest('.rail, #panel') && target.tagName === 'BUTTON' && e.key !== 'Escape') return;
      const info: KeyInfo = { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey };
      if (handle(info, isTypingTarget(e.target))) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const off = controller.onFrameEvent((m) => {
      if (m.type === 'key') handle({ key: m.key, ctrl: m.ctrl, meta: m.meta, shift: m.shift, alt: m.alt }, false);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [controller, actions]);

  // Layers open by default on wide viewports.
  useEffect(() => {
    if (window.innerWidth < WIDE_VIEWPORT) return undefined;
    const timer = setTimeout(() => setPanel((p) => p ?? 'layers'), DEFAULT_PANEL_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const loading = snap.docState === 'loading';
  const failed = snap.docState === 'error';

  return (
    <div className="app" onMouseDownCapture={keepFocus}>
      <Topbar local={Boolean(local)} canCompare={Boolean(local) || Boolean(hostProject())} controller={controller} snap={snap} onSize={setResize} comparing={comparing} onCompare={toggleComparison} />
      <div id="format-toolbar" className="format-slot" role="toolbar" aria-label={t('toolbar.label')}>
        <FormatToolbar controller={controller} actions={actions} onOpenBlock={() => setPanel('block')} crop={crop} />
      </div>
      <div className="workspace">
        <Rail open={panel} onAddPage={() => addPage(controller)} onToggle={(id) => setPanel((p) => (p === id ? null : id))} />
        <PanelHost open={panel} controller={controller} onClose={() => setPanel(null)} />
        <div className="main">
          <Stage comparing={showReference} references={references} controller={controller} snap={snap} zoom={zoom} gestures={gestures} subscribeView={subscribeView} actions={actions} cropId={cropId} onExitCrop={exitCrop} resize={resize?.pageId === snap.currentPageId ? resize : null} onEndResize={() => setResize(null)} />
          <StatusBar snap={snap} zoom={zoom} actions={actions} />
          <Filmstrip controller={controller} snap={snap} baseHref={baseHref} toast={toast} />
        </div>
        {loading && (
          <div className="state-overlay" role="status">
            <span className="spinner" />
            {t('status.loading')}
          </div>
        )}
        {failed && (
          <div className="state-overlay state-error" role="alert">
            <strong>{t('status.errorTitle')}</strong>
            <p>{errorText(t, snap.error)}</p>
            <button type="button" className="btn" onClick={() => void controller.reload()}>
              {t('status.retry')}
            </button>
          </div>
        )}
      </div>
      {snap.conflict && <ConflictModal controller={controller} />}
    </div>
  );
}
