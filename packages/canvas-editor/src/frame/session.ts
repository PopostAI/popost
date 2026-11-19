/** Everything that works on a mounted frame `Document` (no iframe needed, so it runs under happy-dom). */
import type { FrameToShell, NodeId, ShellToFrame } from '../contracts';
import { alignPage, resetScroll } from './align';
import { attachEvents } from './events';
import { applyLiveUpdates } from './live';
import { applyMarks, currentRoot, discoverPages, SELECT_ATTR } from './marks';
import type { FrameState } from './marks';
import { computedStyles, measure } from './measure';
import type { Measured } from './measure';
import { TextEditor } from './text-edit';

export interface Session {
  /** Emits `ready`, then `fontsReady` + `rects` once fonts have loaded. */
  start(): void;
  send(msg: ShellToFrame): void;
  measure(ids: NodeId[] | 'page'): Measured;
  styles(id: NodeId, props: string[]): Record<string, string>;
  dispose(): void;
}

export function createSession(
  doc: Document,
  pageIds: NodeId[],
  currentId: NodeId | null,
  emit: (msg: FrameToShell) => void,
): Session {
  const win = doc.defaultView;
  const state: FrameState = { doc, pageIds: [...pageIds], currentId: currentId ?? pageIds[0] ?? null, highlightIds: [] };
  let alive = true;
  let raf = 0;
  const out = (msg: FrameToShell): void => {
    if (alive) emit(msg);
  };

  const editor = new TextEditor({
    state,
    emit: out,
    resetScroll: () => resetScroll(doc),
    origin: () => {
      const r = currentRoot(state)?.getBoundingClientRect();
      return { x: r?.left ?? 0, y: r?.top ?? 0 };
    },
  });

  /** Re-align the page and report every block's rect. */
  const emitRects = (): void => {
    if (!alive) return;
    const root = currentRoot(state);
    if (root) alignPage(doc, root);
    out({ type: 'rects', ...measure(state, 'page') });
  };
  const scheduleRects = (): void => {
    if (raf || !alive) return;
    const run = (): void => {
      raf = 0;
      emitRects();
    };
    raf = win ? win.requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  };

  /* ---- observers: layout changes the editor was not told about ---- */
  const RO = (win as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
  const ro = RO ? new RO(() => scheduleRects()) : null;
  const observe = (): void => {
    if (!ro) return;
    ro.disconnect();
    ro.observe(doc.documentElement);
    const root = currentRoot(state);
    if (!root) return;
    ro.observe(root);
    for (const el of Array.from(root.querySelectorAll(`[${SELECT_ATTR}]`))) ro.observe(el);
  };
  const onLoad = (): void => scheduleRects();
  doc.addEventListener('load', onLoad, true);
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  fonts?.addEventListener?.('loadingdone', onLoad);
  const onScroll = (): void => resetScroll(doc);
  doc.addEventListener('scroll', onScroll, true);
  const detachEvents = attachEvents({ state, editor, emit: out });

  applyMarks(state);
  const initialRoot = currentRoot(state);
  if (initialRoot) alignPage(doc, initialRoot);
  observe();

  return {
    start() {
      out({ type: 'ready', pages: [...state.pageIds] });
      const ready = fonts?.ready ?? Promise.resolve();
      void ready.then(() => {
        if (!alive) return;
        out({ type: 'fontsReady' });
        emitRects();
      });
    },

    send(msg) {
      if (!alive) return;
      switch (msg.type) {
        case 'live':
          applyLiveUpdates(doc, msg.updates);
          editor.checkConnected();
          state.pageIds = discoverPages(doc);
          applyMarks(state);
          if (state.currentId !== null) {
            const root = currentRoot(state);
            if (root) alignPage(doc, root);
          }
          observe();
          scheduleRects();
          break;
        case 'currentPage':
          state.currentId = msg.id;
          applyMarks(state);
          observe();
          emitRects();
          break;
        case 'beginTextEdit':
          editor.begin(msg.id, msg.caret, msg.x, msg.y);
          break;
        case 'endTextEdit':
          editor.end(msg.commit);
          break;
        case 'format':
          editor.format(msg.format);
          break;
        case 'highlight':
          state.highlightIds = [...msg.ids];
          applyMarks(state);
          break;
      }
    },

    measure: (ids) => measure(state, ids),
    styles: (id, props) => computedStyles(state, id, props),

    dispose() {
      if (!alive) return;
      editor.discard();
      alive = false;
      detachEvents();
      ro?.disconnect();
      doc.removeEventListener('load', onLoad, true);
      doc.removeEventListener('scroll', onScroll, true);
      fonts?.removeEventListener?.('loadingdone', onLoad);
      if (raf && win) win.cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
