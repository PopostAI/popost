import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hitTest, isEditorKey } from './events';
import { el, fire, key, resetDoc, startSession } from './test-dom';
import type { Harness } from './test-dom';

let h: Harness;
beforeEach(() => {
  resetDoc();
  h = startSession();
  h.events.length = 0;
});
afterEach(() => h.session.dispose());

const pointers = () => h.of('pointer');

describe('hitTest', () => {
  it('resolves id (selectable) and deepId (any id), never the root', () => {
    const root = el('n4');
    expect(hitTest(root, el('n6'))).toEqual({ id: 'n5', deepId: 'n6' });
    expect(hitTest(root, el('n14'))).toEqual({ id: null, deepId: 'n14' });
    expect(hitTest(root, el('n10'))).toEqual({ id: 'n8', deepId: 'n10' });
    expect(hitTest(root, root)).toEqual({ id: null, deepId: null });
    expect(hitTest(root, document.body)).toEqual({ id: null, deepId: null });
    expect(hitTest(root, el('n12'))).toEqual({ id: null, deepId: null }); // other page
    expect(hitTest(root, el('n5').firstChild)).toEqual({ id: 'n5', deepId: 'n5' }); // text node
  });
});

describe('pointer events', () => {
  it('emits down/move/up with ids and modifiers, move only while pressed', () => {
    fire(el('n7'), 'pointermove', { clientX: 1, clientY: 1, pointerId: 1 });
    expect(pointers()).toHaveLength(0);
    fire(el('n6'), 'pointerdown', { clientX: 10, clientY: 20, pointerId: 1, shiftKey: true, altKey: true, metaKey: true });
    fire(el('n6'), 'pointermove', { clientX: 15, clientY: 25, pointerId: 1 });
    fire(el('n6'), 'pointerup', { clientX: 16, clientY: 26, pointerId: 1 });
    fire(el('n6'), 'pointermove', { clientX: 17, clientY: 27, pointerId: 1 });
    expect(pointers()).toEqual([
      { type: 'pointer', action: 'down', id: 'n5', deepId: 'n6', shift: true, alt: true, meta: true, x: 10, y: 20 },
      expect.objectContaining({ action: 'move', x: 15, y: 25, id: 'n5' }),
      expect.objectContaining({ action: 'up', x: 16, y: 26 }),
    ]);
  });

  it('uses null ids outside the page root and ignores secondary buttons', () => {
    fire(document.body, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
    fire(document.body, 'pointerup', { pointerId: 1 });
    fire(el('n7'), 'pointerdown', { button: 2, pointerId: 2 });
    expect(pointers().map((p) => [p.action, p.id])).toEqual([['down', null], ['up', null]]);
  });

  it('captures the pointer on down', () => {
    const spy = vi.fn();
    el('n7').setPointerCapture = spy;
    fire(el('n7'), 'pointerdown', { pointerId: 3 });
    expect(spy).toHaveBeenCalledWith(3);
  });

  it('emits dblclick and prevents + emits contextmenu', () => {
    fire(el('n7'), 'dblclick', { clientX: 5, clientY: 6 });
    const ev = fire(el('n7'), 'contextmenu', { clientX: 7, clientY: 8 });
    expect(ev.defaultPrevented).toBe(true);
    expect(pointers().map((p) => [p.action, p.id, p.x, p.y])).toEqual([
      ['dblclick', 'n7', 5, 6],
      ['contextmenu', 'n7', 7, 8],
    ]);
  });

  it('subtracts the page root origin', () => {
    el('n4').getBoundingClientRect = () => ({ left: 100, top: 50, right: 0, bottom: 0, width: 0, height: 0, x: 100, y: 50, toJSON() {} });
    fire(el('n7'), 'pointerdown', { clientX: 110, clientY: 70, pointerId: 1 });
    expect(pointers()[0]).toMatchObject({ x: 10, y: 20 });
  });
});

describe('hover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('is rAF-throttled, emitted on change only, null on leave', async () => {
    fire(el('n7'), 'pointermove', { pointerId: 1 });
    fire(el('n7'), 'pointermove', { pointerId: 1 });
    expect(h.of('hover')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.of('hover')).toEqual([{ type: 'hover', id: 'n7' }]);
    fire(el('n7'), 'pointermove', { pointerId: 1 });
    await vi.advanceTimersByTimeAsync(40);
    expect(h.of('hover')).toHaveLength(1);
    fire(document.documentElement, 'pointerleave', { bubbles: false });
    expect(h.of('hover')).toEqual([{ type: 'hover', id: 'n7' }, { type: 'hover', id: null }]);
  });
});

describe('keyboard', () => {
  it('forwards keys and prevents default for editor keys', () => {
    expect(key(document.body, 'ArrowLeft').defaultPrevented).toBe(true);
    expect(key(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(key(document.body, 'a').defaultPrevented).toBe(false);
    expect(h.of('key').map((k) => k.key)).toEqual(['ArrowLeft', 'z', 'a']);
    expect(h.of('key')[1]).toMatchObject({ ctrl: true, meta: false });
  });

  it('ignores keys while composing (IME)', () => {
    key(document.body, 'Enter', { isComposing: true });
    key(document.body, 'Process', { keyCode: 229 });
    expect(h.of('key')).toHaveLength(0);
  });

  it('does not forward keys typed in the contenteditable, except Ctrl/Cmd+S', () => {
    h.session.send({ type: 'beginTextEdit', id: 'n7', caret: 'end' });
    expect(key(el('n7'), 'a').defaultPrevented).toBe(false);
    key(el('n7'), 'ArrowLeft');
    expect(h.of('key')).toHaveLength(0);
    const save = key(el('n7'), 's', { metaKey: true });
    expect(save.defaultPrevented).toBe(true);
    expect(h.of('key').map((k) => k.key)).toEqual(['s']);
  });

  it('classifies editor keys', () => {
    const k = (key: string, extra = {}) => isEditorKey({ key, ctrlKey: false, metaKey: false, ...extra });
    for (const x of ['ArrowUp', 'Delete', 'Backspace', ' ', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Tab']) expect(k(x)).toBe(true);
    expect(k('x')).toBe(false);
    expect(k('x', { metaKey: true })).toBe(true);
  });
});

describe('wheel', () => {
  it('is always prevented and forwarded', () => {
    const e = new window.WheelEvent('wheel', { deltaX: 3, deltaY: -4, ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'ctrlKey', { value: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.of('wheel')).toEqual([{ type: 'wheel', deltaX: 3, deltaY: -4, ctrl: true }]);
  });
});

describe('drop', () => {
  const dropEvent = (target: Element, files: File[]) => {
    const e = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.assign(e, { dataTransfer: { files, types: ['Files'] }, clientX: 1, clientY: 1 });
    target.dispatchEvent(e);
    return e;
  };

  it('reads image files as data URLs with the block under the drop', async () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' });
    const e = dropEvent(el('n7'), [png, txt]);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(h.of('drop')).toHaveLength(1));
    const drop = h.of('drop')[0];
    expect(drop.id).toBe('n7');
    expect(drop.files).toHaveLength(1);
    expect(drop.files[0]).toMatchObject({ name: 'a.png', type: 'image/png' });
    expect(drop.files[0].dataURL.startsWith('data:image/png')).toBe(true);
  });

  it('prevents dragover of files and ignores drops without images', () => {
    const over = new window.Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(over, { dataTransfer: { types: ['Files'], files: [] } });
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const e = dropEvent(el('n7'), [new File(['x'], 'a.txt', { type: 'text/plain' })]);
    expect(e.defaultPrevented).toBe(true);
    expect(h.of('drop')).toHaveLength(0);
  });
});

describe('dispose', () => {
  it('detaches all listeners', () => {
    h.session.dispose();
    fire(el('n7'), 'pointerdown', { pointerId: 1 });
    key(document.body, 'a');
    expect(h.events).toHaveLength(0);
  });
});
