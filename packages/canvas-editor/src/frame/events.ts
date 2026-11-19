/** Translates DOM events of the frame document into `FrameToShell` events. */
import type { FrameToShell, NodeId } from '../contracts';
import { PP_ID_ATTR } from '../core/preview';
import { SELECT_ATTR, currentRoot } from './marks';
import type { FrameState } from './marks';
import type { TextEditor } from './text-edit';

export interface EventDeps {
  state: FrameState;
  editor: TextEditor;
  emit: (msg: FrameToShell) => void;
}

const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

/** Element for an event target (text nodes resolve to their parent). */
function elementOf(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** `id` = nearest selectable block, `deepId` = nearest element with an id; both inside `root`, never the root itself. */
export function hitTest(root: Element | null, target: EventTarget | null): { id: NodeId | null; deepId: NodeId | null } {
  const el = elementOf(target);
  if (!root || !el || !root.contains(el)) return { id: null, deepId: null };
  const inside = (found: Element | null): Element | null => (found && found !== root && root.contains(found) ? found : null);
  return {
    id: inside(el.closest(`[${SELECT_ATTR}]`))?.getAttribute(PP_ID_ATTR) ?? null,
    deepId: inside(el.closest(`[${PP_ID_ATTR}]`))?.getAttribute(PP_ID_ATTR) ?? null,
  };
}

/** Keys the editor handles itself; the browser default (scroll, focus move, history...) is suppressed for them. */
export function isEditorKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): boolean {
  if (e.ctrlKey || e.metaKey) return true;
  if (['+', '=', '-', '_'].includes(e.key)) return true;
  return (
    e.key.startsWith('Arrow') ||
    ['Delete', 'Backspace', ' ', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Tab'].includes(e.key)
  );
}

function readFile(file: File): Promise<{ name: string; type: string; dataURL: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataURL: String(reader.result) });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Attach all listeners to the frame document; returns the detach function. */
export function attachEvents(deps: EventDeps): () => void {
  const { state, editor, emit } = deps;
  const doc = state.doc;
  const win = doc.defaultView;
  let alive = true;
  let pressed: number | null = null;
  let hoverId: NodeId | null = null;
  let hoverTarget: EventTarget | null = null;
  let hoverRaf = 0;
  const cleanups: Array<() => void> = [];

  const on = <E extends Event>(
    target: EventTarget,
    type: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void => {
    target.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };

  const origin = (): { left: number; top: number } => currentRoot(state)?.getBoundingClientRect() ?? { left: 0, top: 0 };

  const emitPointer = (action: 'down' | 'move' | 'up' | 'dblclick' | 'contextmenu', e: MouseEvent): void => {
    const o = origin();
    const { id, deepId } = hitTest(currentRoot(state), e.target);
    emit({
      type: 'pointer',
      action,
      id,
      deepId,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey || e.ctrlKey,
      x: e.clientX - o.left,
      y: e.clientY - o.top,
    });
  };

  /* ---- pointer ---- */
  on<PointerEvent>(doc, 'pointerdown', (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    if (editor.editingId !== null) {
      if (editor.contains(e.target as Node)) return; // caret placement is the browser's job
      editor.end(true);
    }
    pressed = e.pointerId;
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* element gone or pointer inactive */
    }
    emitPointer('down', e);
  });
  on<PointerEvent>(doc, 'pointermove', (e) => {
    if (pressed !== null && e.pointerId === pressed) emitPointer('move', e);
    scheduleHover(e.target);
  });
  const release = (e: PointerEvent): void => {
    if (pressed === null || e.pointerId !== pressed) return;
    pressed = null;
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    emitPointer('up', e);
  };
  on<PointerEvent>(doc, 'pointerup', (e) => {
    if (e.button === 0) release(e);
  });
  on<PointerEvent>(doc, 'pointercancel', release);
  on<MouseEvent>(doc, 'dblclick', (e) => {
    if (editor.contains(e.target as Node)) return;
    emitPointer('dblclick', e);
  });
  on<MouseEvent>(doc, 'contextmenu', (e) => {
    if (editor.contains(e.target as Node)) return;
    e.preventDefault();
    emitPointer('contextmenu', e);
  });
  on<DragEvent>(doc, 'dragstart', (e) => e.preventDefault());

  /* ---- hover ---- */
  function scheduleHover(target: EventTarget | null): void {
    hoverTarget = target;
    if (hoverRaf || !win) return;
    hoverRaf = win.requestAnimationFrame(() => {
      hoverRaf = 0;
      setHover(hitTest(currentRoot(state), hoverTarget).id);
    });
  }
  function setHover(id: NodeId | null): void {
    if (!alive || id === hoverId) return;
    hoverId = id;
    emit({ type: 'hover', id });
  }
  const leave = (): void => {
    if (hoverRaf && win) win.cancelAnimationFrame(hoverRaf);
    hoverRaf = 0;
    hoverTarget = null;
    setHover(null);
  };
  on(doc.documentElement, 'pointerleave', leave);
  on(doc.documentElement, 'mouseleave', leave);
  cleanups.push(() => {
    if (hoverRaf && win) win.cancelAnimationFrame(hoverRaf);
  });

  /* ---- keyboard ---- */
  on<KeyboardEvent>(
    doc,
    'keydown',
    (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const target = elementOf(e.target);
      const typing = editor.contains(target) || !!target?.closest(EDITABLE);
      const save = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
      if (typing && !save) return;
      emit({ type: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
      if (save || isEditorKey(e)) e.preventDefault();
    },
    true,
  );

  /* ---- wheel ---- */
  on<WheelEvent>(
    doc,
    'wheel',
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (win?.innerHeight ?? 1) : 1;
      emit({ type: 'wheel', deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, ctrl: e.ctrlKey || e.metaKey });
    },
    { passive: false },
  );

  /* ---- file drops ---- */
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  on<DragEvent>(doc, 'dragover', (e) => {
    if (hasFiles(e) || editor.contains(e.target as Node)) e.preventDefault();
  });
  on<DragEvent>(doc, 'drop', (e) => {
    e.preventDefault(); // never let the browser navigate to a dropped file
    if (editor.contains(e.target as Node)) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const at = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(e.clientX, e.clientY) : null;
    const { id } = hitTest(currentRoot(state), at ?? e.target);
    void Promise.all(files.map(readFile)).then(
      (read) => {
        if (alive) emit({ type: 'drop', id, files: read });
      },
      () => undefined,
    );
  });

  return () => {
    alive = false;
    for (const fn of cleanups.splice(0)) fn();
  };
}
