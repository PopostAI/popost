import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useDismissable } from './dismiss';

interface Props {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  id?: string;
  className?: string;
  children: ReactNode;
}

const MARGIN = 8;

/**
 * Popover under its anchor, positioned `fixed` so scrolling toolbars cannot clip it. Esc closes it first (Esc stack);
 * a click outside closes it. The scrim keeps focus where it is, so an inline text edit survives opening a popover.
 */
export function Popover({ open, anchor, onClose, id, className, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismissable(open, onClose);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 0;
    if (!a) return;
    setPos({ left: Math.max(MARGIN, Math.min(a.left, window.innerWidth - width - MARGIN)), top: a.bottom + 6 });
  }, [open, anchor]);

  if (!open) return null;
  return (
    <>
      <div className="menu-scrim" data-keepfocus="" onMouseDown={onClose} />
      <div ref={ref} id={id} className={`popover pop-fixed${className ? ` ${className}` : ''}`} style={pos ?? { left: -9999, top: 0 }} role="dialog">
        {children}
      </div>
    </>
  );
}
