import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EditorController, EditorSnapshot, NodeId, PageInfo } from '../contracts';
import { pageRoots } from '../core/pages';
import { buildPreview } from '../core/preview';
import { FRAME_CSS } from '../frame/frame-css';
import { readImageOrigins } from '../host/params';
import { useDismissable } from './dismiss';
import { useT } from './i18n';
import { deletePage, duplicatePage, movePage, slotToIndex } from './pageops';
import type { ShowToast } from './toasts';

/** Thumbnail box (CSS px). */
const THUMB_W = 112;
const THUMB_H = 84;
const RERENDER_MS = 450;

/** Frame CSS plus: show only the page marked current, never react to the pointer. */
export const THUMB_CSS = `${FRAME_CSS}
body .slide:not(.ed-cur) { display: none !important; }
* { pointer-events: none !important; }`;

interface CacheEntry {
  shared: string;
  slice: string;
  html: string;
}

/**
 * Script-free preview documents per page, rebuilt ~450 ms after the source changed. A page is only rebuilt when
 * its own markup or the shared part of the document (head, text around the pages) changed.
 */
function useThumbDocs(controller: EditorController, snap: EditorSnapshot, baseHref: string | undefined): Record<NodeId, string> {
  const [docs, setDocs] = useState<Record<NodeId, string>>({});
  const cache = useRef(new Map<NodeId, CacheEntry>());
  const imageOrigins = useMemo(readImageOrigins, []);
  const built = useRef(false);

  useEffect(() => {
    if (snap.docState !== 'ready') return undefined;
    const run = (): void => {
      const index = controller.index();
      const roots = pageRoots(index);
      const first = roots[0];
      const last = roots[roots.length - 1];
      if (!first || !last) return;
      const shared = index.source.slice(0, first.start) + index.source.slice(last.end);
      const next: Record<NodeId, string> = {};
      const seen = new Set<NodeId>();
      for (const root of roots) {
        seen.add(root.id);
        const slice = index.source.slice(root.start, root.end);
        let entry = cache.current.get(root.id);
        if (!entry || entry.shared !== shared || entry.slice !== slice) {
          entry = { shared, slice, html: buildPreview(index, { frameCSS: THUMB_CSS, baseHref, imageOrigins, currentPageId: root.id }) };
          cache.current.set(root.id, entry);
        }
        next[root.id] = entry.html;
      }
      for (const id of [...cache.current.keys()]) if (!seen.has(id)) cache.current.delete(id);
      built.current = true;
      setDocs(next);
    };
    const timer = setTimeout(run, built.current ? RERENDER_MS : 0);
    return () => clearTimeout(timer);
  }, [controller, snap.docState, snap.sourceVersion, baseHref, imageOrigins]);

  return docs;
}

/** Shift the page to the iframe's top-left like the edit frame does (pages inside centring layouts). */
export function alignThumb(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  const root = doc?.querySelector<HTMLElement>('.ed-cur');
  if (!doc || !root) return;
  const r = root.getBoundingClientRect();
  if (r.left !== 0 || r.top !== 0) doc.documentElement.style.setProperty('translate', `${-r.left}px ${-r.top}px`);
}

interface ThumbProps {
  page: PageInfo;
  position: number;
  html: string | undefined;
  active: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onOpen(): void;
  onMenu(x: number, y: number): void;
  onKey(e: ReactKeyboardEvent): void;
  dragProps: {
    onDragStart(e: ReactDragEvent): void;
    onDragOver(e: ReactDragEvent): void;
    onDrop(e: ReactDragEvent): void;
    onDragEnd(): void;
  };
}

function Thumb({ page, position, html, active, dropBefore, dropAfter, onOpen, onMenu, onKey, dragProps }: ThumbProps) {
  const t = useT();
  const scale = Math.min(THUMB_W / page.width, THUMB_H / page.height);
  const label = t('pages.page', { n: position + 1 });
  return (
    <div
      className={`thumb${active ? ' active' : ''}${dropBefore ? ' drop-before' : ''}${dropAfter ? ' drop-after' : ''}`}
      role="button"
      tabIndex={0}
      draggable
      title={page.name ? `${position + 1}. ${page.name}` : label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      data-page-id={page.id}
      onClick={onOpen}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      {...dragProps}
    >
      <div className="thumb-view" style={{ width: Math.round(page.width * scale), height: Math.round(page.height * scale) }}>
        {html !== undefined && (
          <iframe
            className="thumb-frame"
            sandbox="allow-same-origin"
            srcDoc={html}
            tabIndex={-1}
            aria-hidden="true"
            title={label}
            style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
            onLoad={(e) => alignThumb(e.currentTarget)}
          />
        )}
      </div>
      <span className="thumb-num">{position + 1}</span>
    </div>
  );
}

interface Props {
  controller: EditorController;
  snap: EditorSnapshot;
  baseHref: string | undefined;
  toast: ShowToast;
}

export function Filmstrip({ controller, snap, baseHref, toast }: Props) {
  const t = useT();
  const docs = useThumbDocs(controller, snap, baseHref);
  const [menu, setMenu] = useState<{ x: number; y: number; id: NodeId } | null>(null);
  const [drag, setDrag] = useState<{ from: NodeId; slot: number | null } | null>(null);
  useDismissable(menu !== null, () => setMenu(null));
  const { pages } = snap;
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Keep the active thumb in view.
  useEffect(() => {
    stripRef.current?.querySelector('.thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [snap.currentPageId]);

  const remove = (id: NodeId): void => {
    if (deletePage(controller, id)) toast(t('toast.pageDeleted'));
  };
  const position = (id: NodeId): number => pages.findIndex((p) => p.id === id);

  const onKey = (page: PageInfo) => (e: ReactKeyboardEvent): void => {
    const at = position(page.id);
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === 'Delete' || e.key === 'Backspace') remove(page.id);
    else if (mod && e.key.toLowerCase() === 'd') duplicatePage(controller, page.id);
    else if (e.altKey && e.key === 'ArrowLeft') movePage(controller, page.id, at - 1);
    else if (e.altKey && e.key === 'ArrowRight') movePage(controller, page.id, at + 1);
    else if (e.key === 'Enter' || e.key === ' ') controller.setCurrentPage(page.id);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const dragProps = (page: PageInfo) => ({
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', page.id);
      setDrag({ from: page.id, slot: null });
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const slot = position(page.id) + (e.clientX > rect.left + rect.width / 2 ? 1 : 0);
      if (slot !== drag.slot) setDrag({ from: drag.from, slot });
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      if (drag && drag.slot !== null) movePage(controller, drag.from, slotToIndex(position(drag.from), drag.slot));
      setDrag(null);
    },
    onDragEnd: () => setDrag(null),
  });

  const menuPos = useMemo(() => (menu ? position(menu.id) : -1), [menu, pages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="filmstrip-wrap">
      <div id="filmstrip" className="filmstrip" ref={stripRef} role="list" aria-label={t('pages.label')}>
        {pages.map((page, i) => (
          <Thumb
            key={page.id}
            page={page}
            position={i}
            html={docs[page.id]}
            active={page.id === snap.currentPageId}
            dropBefore={drag?.slot === i && drag.from !== page.id}
            dropAfter={drag?.slot === pages.length && i === pages.length - 1}
            onOpen={() => controller.setCurrentPage(page.id)}
            onMenu={(x, y) => setMenu({ x, y, id: page.id })}
            onKey={onKey(page)}
            dragProps={dragProps(page)}
          />
        ))}
      </div>

      {menu && (
        <>
          <div className="menu-scrim" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="popover ctx-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.max(8, menu.y - 4 - 140) }}>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); duplicatePage(controller, menu.id); }}>
              {t('pages.duplicate')}
            </button>
            <button type="button" role="menuitem" className="menu-item" disabled={menuPos <= 0} onClick={() => { setMenu(null); movePage(controller, menu.id, menuPos - 1); }}>
              {t('pages.moveLeft')}
            </button>
            <button type="button" role="menuitem" className="menu-item" disabled={menuPos < 0 || menuPos >= pages.length - 1} onClick={() => { setMenu(null); movePage(controller, menu.id, menuPos + 1); }}>
              {t('pages.moveRight')}
            </button>
            <button type="button" role="menuitem" className="menu-item danger" disabled={pages.length <= 1} onClick={() => { setMenu(null); remove(menu.id); }}>
              {t('pages.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
