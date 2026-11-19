/** One keymap for keys from the editor window and keys forwarded from the edit frame. */
export interface KeyInfo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyContext {
  selectionCount: number;
  /** Inline text editing is active (the frame handles typing itself). */
  editing: boolean;
}

export type KeyAction =
  | { type: 'save' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'zoom'; mode: 'in' | 'out' | 'fit' }
  | { type: 'scaleSelection'; direction: 1 | -1 }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'edit' }
  | { type: 'escape' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'reorder'; direction: 'up' | 'down' }
  | { type: 'page'; direction: 'prev' | 'next' }
  | { type: 'copyStyle' }
  | { type: 'pasteStyle' };

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Action for a key press, or null when the editor does not handle it. */
export function resolveKey(k: KeyInfo, ctx: KeyContext): KeyAction | null {
  const mod = k.ctrl || k.meta;
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;

  if (mod) {
    if (key === 's') return { type: 'save' };
    if (k.alt) {
      if (key === 'c') return { type: 'copyStyle' };
      if (key === 'v') return { type: 'pasteStyle' };
      return null;
    }
    if (ctx.editing) {
      // Text undo is the browser's job while typing; zoom and save stay available.
      return zoomKey(key);
    }
    if (key === 'z') return k.shift ? { type: 'redo' } : { type: 'undo' };
    if (key === 'y') return { type: 'redo' };
    if (key === 'd') return ctx.selectionCount > 0 ? { type: 'duplicate' } : null;
    return zoomKey(key);
  }

  if (key === 'Escape') return { type: 'escape' };
  if (ctx.editing) return null;

  if (ctx.selectionCount > 0) {
    if (ctx.selectionCount === 1 && !k.alt && (key === '+' || key === '=' || key === '-' || key === '_'))
      return { type: 'scaleSelection', direction: key === '+' || key === '=' ? 1 : -1 };
    if (key === 'Delete' || key === 'Backspace') return { type: 'delete' };
    if (key === 'Enter') return ctx.selectionCount === 1 ? { type: 'edit' } : null;
    const arrow = ARROWS[key];
    if (arrow) {
      if (k.alt) return arrow[0] === 0 ? { type: 'reorder', direction: arrow[1] < 0 ? 'up' : 'down' } : null;
      const step = k.shift ? 10 : 1;
      return { type: 'nudge', dx: arrow[0] * step, dy: arrow[1] * step };
    }
    return null;
  }
  if (!k.alt && (key === '+' || key === '=' || key === '-' || key === '_')) return zoomKey(key);
  if (key === 'ArrowLeft' || key === 'PageUp') return { type: 'page', direction: 'prev' };
  if (key === 'ArrowRight' || key === 'PageDown') return { type: 'page', direction: 'next' };
  return null;
}

function zoomKey(key: string): KeyAction | null {
  if (key === '=' || key === '+') return { type: 'zoom', mode: 'in' };
  if (key === '-' || key === '_') return { type: 'zoom', mode: 'out' };
  if (key === '0') return { type: 'zoom', mode: 'fit' };
  return null;
}

/** True when keyboard focus is somewhere the editor must not steal keys from. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.closest('.CodeMirror')) return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // The zoom slider is not text entry; arrow keys belong to it while focused, so treat it as typing too.
    return type !== 'button' && type !== 'checkbox';
  }
  return false;
}
