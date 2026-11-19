/** Shared helpers for the frame unit tests: a preview-like document in the happy-dom global document. */
import type { FrameToShell } from '../contracts';
import { createSession } from './session';
import type { Session } from './session';

export const PREVIEW_BODY = `
<section class="slide ed-cur" data-pp-id="n4">
  <h1 data-pp-id="n5" data-pp-sel="text">Title <b data-pp-id="n6">bold</b> end</h1>
  <p data-pp-id="n7" data-pp-sel="text">Para</p>
  <svg data-pp-id="n8" data-pp-sel="svg" viewBox="0 0 10 10"><g data-pp-id="n9"><circle data-pp-id="n10" r="2"></circle></g></svg>
  <div data-pp-id="n13"><span data-pp-id="n14">Deep</span></div>
</section>
<section class="slide" data-pp-id="n11"><p data-pp-id="n12" data-pp-sel="text">Two</p></section>`;

export function resetDoc(body: string = PREVIEW_BODY): void {
  document.head.innerHTML = '<style data-pp-frame></style>';
  document.body.setAttribute('data-pp-id', 'n3');
  document.body.innerHTML = body;
  document.documentElement.removeAttribute('style');
}

export const el = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-pp-id="${id}"]`)!;

export interface Harness {
  session: Session;
  events: FrameToShell[];
  of: <T extends FrameToShell['type']>(type: T) => Array<Extract<FrameToShell, { type: T }>>;
}

export function startSession(current: string | null = 'n4', pages = ['n4', 'n11']): Harness {
  const events: FrameToShell[] = [];
  const session = createSession(document, pages, current, (m) => events.push(m));
  return {
    session,
    events,
    of: (type) => events.filter((e) => e.type === type) as never,
  };
}

/** Dispatch a pointer-like event (happy-dom may lack PointerEvent). */
export function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? window.MouseEvent;
  const e = new Ctor(type, <MouseEventInit>{ bubbles: true, cancelable: true, button: 0, isPrimary: true, ...init });
  for (const [k, v] of Object.entries(init)) {
    if (!(k in e) || (e as unknown as Record<string, unknown>)[k] !== v) {
      Object.defineProperty(e, k, { value: v, configurable: true });
    }
  }
  target.dispatchEvent(e);
  return e;
}

export function key(target: EventTarget, k: string, init: Record<string, unknown> = {}): KeyboardEvent {
  const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  for (const [name, v] of Object.entries(init)) Object.defineProperty(e, name, { value: v, configurable: true });
  target.dispatchEvent(e);
  return e;
}
