/**
 * Esc stack of open popovers and menus (innermost closes first). Panels (D2b) register their popovers here
 * with `useDismissable` so that Esc closes them before it leaves text editing or clears the selection.
 */
import { useEffect, useRef } from 'react';

const stack: Array<() => void> = [];

export function pushDismissable(close: () => void): () => void {
  stack.push(close);
  return () => {
    const at = stack.lastIndexOf(close);
    if (at >= 0) stack.splice(at, 1);
  };
}

/** Close the innermost popover; false when none is open. */
export function dismissTop(): boolean {
  const close = stack.pop();
  if (!close) return false;
  close();
  return true;
}

export const hasDismissable = (): boolean => stack.length > 0;

/** Register `close` with the Esc stack while `open` is true. */
export function useDismissable(open: boolean, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return undefined;
    return pushDismissable(() => ref.current());
  }, [open]);
}
