import { ReferencePane, type ReferenceImagesState } from './ReferenceComparison';
import { useT } from './i18n';
import { PageResize } from './PageResize';
import type { CropRequest } from './PageDesign';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { EditorController, EditorSnapshot } from '../contracts';
import type { Actions } from './actions';
import { dismissTop, hasDismissable } from './dismiss';
import { CropLayer } from './ImageTools';
import { Overlay } from './Overlay';
import { IDLE_VIEW } from './interaction/gestures';
import type { Gestures, GestureView } from './interaction/gestures';
import { STAGE_PADDING } from './logic/zoom';
import type { ZoomState } from './use-zoom';

interface Props {
  comparing: boolean;
  references: ReferenceImagesState;
  resize: CropRequest | null;
  onEndResize(): void;
  controller: EditorController;
  snap: EditorSnapshot;
  zoom: ZoomState;
  gestures: Gestures;
  /** Subscribe to the gesture view (guides, tooltip, marquee). */
  subscribeView(listener: (view: GestureView) => void): () => void;
  actions: Actions;
  /** Image block in crop & align mode, if any. */
  cropId?: string | null;
  onExitCrop?(): void;
}

/** Scrollable stage with the scaled edit frame (`#frame`) and the interaction overlay. */
export function Stage({ comparing, references, controller, snap, zoom, gestures, subscribeView, actions, cropId = null, onExitCrop, resize, onEndResize }: Props) {
  const t = useT();
  const pageIndex = snap.pages.findIndex((item) => item.id === snap.currentPageId);
  const { stageRef, wheel } = zoom;
  const stageEl = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<GestureView>(IDLE_VIEW);
  const page = controller.pageSize();
  const scale = zoom.percent / 100;
  const width = Math.round(page.width * scale);
  const height = Math.round(page.height * scale);

  const frameEl = useRef<HTMLIFrameElement | null>(null);
  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      frameEl.current = el;
      controller.attachFrame(el);
    },
    [controller],
  );

  useEffect(() => subscribeView(setView), [subscribeView]);

  // While a popover is open, Esc closes it before the frame's own handler can leave text editing.
  useEffect(() => {
    const iframe = frameEl.current;
    if (!iframe) return undefined;
    let detach: (() => void) | null = null;
    const attach = (): void => {
      detach?.();
      detach = null;
      const win = iframe.contentWindow;
      if (!win) return;
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || !hasDismissable()) return;
        e.preventDefault();
        e.stopPropagation();
        dismissTop();
      };
      win.addEventListener('keydown', onKey, true);
      detach = () => win.removeEventListener('keydown', onKey, true);
    };
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      detach?.();
    };
  }, []);

  // Ctrl/Cmd + wheel zooms (needs a non-passive listener); wheel events of the frame arrive as frame events.
  useEffect(() => {
    const el = stageEl.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      wheel(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const off = controller.onFrameEvent((m) => {
      if (m.type !== 'wheel') return;
      if (m.ctrl) wheel(m.deltaY);
      else el.scrollBy(m.deltaX, m.deltaY);
    });
    return () => {
      el.removeEventListener('wheel', onWheel);
      off();
    };
  }, [controller, wheel]);

  const setRefs = useCallback((el: HTMLDivElement | null) => {
    stageEl.current = el;
    stageRef(el);
  }, [stageRef]);

  const deselect = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t === e.currentTarget || t.classList.contains('stage-pad')) {
      controller.select([]);
      e.currentTarget.focus({ preventScroll: true });
    }
  };

  return (
    <div className="stage" ref={setRefs} tabIndex={-1} onMouseDown={deselect}>
      <div className={`stage-pad${comparing ? ' comparing' : ''}`} style={{ padding: STAGE_PADDING }}>
        {comparing && <ReferencePane state={references} pageIndex={pageIndex} pageKey={snap.pages[pageIndex]?.pageKey ?? null} scale={scale} />}
        <div className="canvas" style={{ width, height }}>
          {comparing && <div className="comparison-caption result-caption"><span>{t('compare.result')}</span><span>{t('compare.page', { n: pageIndex + 1 })} · {t('compare.editable')}</span></div>}
          <iframe
            id="frame"
            ref={frameRef}
            title="canvas"
            style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
          />
          <Overlay controller={controller} snap={snap} scale={scale} width={width} gestures={gestures} view={view} actions={actions} />
          {resize && <PageResize key={resize.pageId} request={resize} controller={controller} scale={scale} onClose={onEndResize} />}
          {!resize && cropId !== null && onExitCrop && <CropLayer controller={controller} snap={snap} id={cropId} scale={scale} onExit={onExitCrop} />}
        </div>
      </div>
    </div>
  );
}
