import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertPlainText } from './text-edit';
import { el, fire, key, resetDoc, startSession } from './test-dom';
import type { Harness } from './test-dom';

let h: Harness;
beforeEach(() => {
  resetDoc();
  h = startSession();
  h.events.length = 0;
});
afterEach(() => h.session.dispose());

const begin = (id = 'n7', caret: 'end' | 'all' | 'point' = 'end') => h.session.send({ type: 'beginTextEdit', id, caret });
const type = (id: string, text: string) => {
  el(id).innerHTML = text;
};

describe('text edit lifecycle', () => {
  it('makes the block editable and reports state', () => {
    begin();
    expect(el('n7').getAttribute('contenteditable')).toBe('true');
    expect(h.of('textState').at(-1)).toMatchObject({ id: 'n7', range: false });
  });

  it('selects everything for caret "all"', () => {
    begin('n7', 'all');
    expect(h.of('textState').at(-1)).toMatchObject({ range: true });
    expect(document.getSelection()!.toString()).toBe('Para');
  });

  it('commits changed content, cleaned', () => {
    begin();
    type('n7', 'Para <b data-pp-id="n99" contenteditable="true">more</b>');
    h.session.send({ type: 'endTextEdit', commit: true });
    expect(h.of('textCommit')).toEqual([{ type: 'textCommit', id: 'n7', html: 'Para <b>more</b>' }]);
    expect(h.of('textCancel')).toHaveLength(0);
    expect(el('n7').hasAttribute('contenteditable')).toBe(false);
    expect(el('n7').hasAttribute('spellcheck')).toBe(false);
    expect(el('n7').innerHTML).toContain('more');
  });

  it('emits textCancel when unchanged', () => {
    begin();
    h.session.send({ type: 'endTextEdit', commit: true });
    expect(h.of('textCancel')).toEqual([{ type: 'textCancel', id: 'n7' }]);
    expect(h.of('textCommit')).toHaveLength(0);
  });

  it('treats attribute-only differences (data-pp-*) as unchanged', () => {
    el('n7').innerHTML = 'a<i data-pp-id="n9">b</i>';
    begin();
    el('n7').querySelector('i')!.setAttribute('data-pp-id', 'zzz');
    h.session.send({ type: 'endTextEdit', commit: true });
    expect(h.of('textCancel')).toHaveLength(1);
  });

  it('restores the original content on commit:false', () => {
    begin();
    type('n7', 'Changed');
    h.session.send({ type: 'endTextEdit', commit: false });
    expect(el('n7').innerHTML).toBe('Para');
    expect(h.of('textCancel')).toEqual([{ type: 'textCancel', id: 'n7' }]);
  });

  it('restores pre-existing contenteditable/spellcheck attributes', () => {
    el('n7').setAttribute('spellcheck', 'true');
    begin();
    h.session.send({ type: 'endTextEdit', commit: false });
    expect(el('n7').getAttribute('spellcheck')).toBe('true');
  });

  it('Escape and Tab commit; Enter inserts a line break instead of committing', () => {
    begin();
    key(el('n7'), 'Enter');
    expect(el('n7').querySelector('br')).not.toBeNull();
    expect(h.of('textCommit')).toHaveLength(0);
    key(el('n7'), 'Escape');
    expect(h.of('textCommit')).toHaveLength(1);
    expect(h.of('textCommit')[0].html).toContain('<br>');

    begin('n5');
    type('n5', 'T2');
    const tab = key(el('n5'), 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(h.of('textCommit').at(-1)).toMatchObject({ id: 'n5', html: 'T2' });
  });

  it('ignores Enter/Escape while composing', () => {
    begin();
    key(el('n7'), 'Enter', { isComposing: true });
    key(el('n7'), 'Escape', { isComposing: true });
    expect(el('n7').querySelector('br')).toBeNull();
    expect(h.of('textCancel')).toHaveLength(0);
  });

  it('commits on blur', () => {
    begin();
    type('n7', 'Blurred');
    el('n7').dispatchEvent(new window.FocusEvent('blur'));
    expect(h.of('textCommit')).toEqual([{ type: 'textCommit', id: 'n7', html: 'Blurred' }]);
  });

  it('switching blocks commits the first', () => {
    begin();
    type('n7', 'X');
    begin('n5');
    expect(h.of('textCommit')[0]).toMatchObject({ id: 'n7', html: 'X' });
    expect(el('n5').getAttribute('contenteditable')).toBe('true');
  });

  it('a pointerdown outside commits first, then is emitted; inside is left to the browser', () => {
    begin();
    type('n7', 'Y');
    fire(el('n7'), 'pointerdown', { pointerId: 1 });
    expect(h.of('pointer')).toHaveLength(0);
    fire(el('n7'), 'dblclick');
    expect(h.of('pointer')).toHaveLength(0);
    fire(el('n5'), 'pointerdown', { pointerId: 1 });
    expect(h.events.map((e) => e.type).filter((t) => t === 'textCommit' || t === 'pointer')).toEqual(['textCommit', 'pointer']);
  });

  it('prevents drops into the edited block without emitting', () => {
    begin();
    const e = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.assign(e, { dataTransfer: { files: [new File(['x'], 'a.png', { type: 'image/png' })], types: ['Files'] } });
    el('n7').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.of('drop')).toHaveLength(0);
  });

  it('pastes plain text', () => {
    begin();
    const e = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.assign(e, { clipboardData: { getData: (t: string) => (t === 'text/plain' ? 'one\ntwo' : '<b>no</b>') } });
    el('n7').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(el('n7').innerHTML).not.toContain('<b>');
    expect(el('n7').textContent).toContain('one');
    expect(el('n7').textContent).toContain('two');
    expect(el('n7').querySelector('br')).not.toBeNull();
  });

  it('drops the edit silently when the block is replaced by a live update', () => {
    begin();
    h.session.send({ type: 'live', updates: [{ kind: 'subtrees', items: [{ id: 'n7', previewHTML: '<p data-pp-id="n7" data-pp-sel="text">New</p>' }] }] });
    h.session.send({ type: 'endTextEdit', commit: true });
    expect(h.of('textCommit')).toHaveLength(0);
    expect(h.of('textCancel')).toHaveLength(0);
  });

  it('emits textState on selectionchange inside the block only', () => {
    begin();
    const before = h.of('textState').length;
    document.dispatchEvent(new window.Event('selectionchange'));
    expect(h.of('textState').length).toBeGreaterThan(before);
  });
});

describe('format', () => {
  it('does nothing without a non-empty range', () => {
    begin();
    const before = el('n7').innerHTML;
    h.session.send({ type: 'format', format: { command: 'fontSize', value: '30px' } });
    expect(el('n7').innerHTML).toBe(before);
  });

  it('wraps the range in a styled span for fontSize / fontFamily / uppercase', () => {
    begin('n7', 'all');
    h.session.send({ type: 'format', format: { command: 'fontSize', value: '30px' } });
    expect(el('n7').innerHTML).toBe('<span style="font-size: 30px;">Para</span>');
    h.session.send({ type: 'format', format: { command: 'fontFamily', value: 'Georgia, serif' } });
    expect(el('n7').querySelectorAll('span')).toHaveLength(2);
    expect(h.of('textState').at(-1)).toMatchObject({ range: true });
  });

  it('inner declarations of the same property are replaced', () => {
    el('n7').innerHTML = 'a<span style="font-size:10px">b</span>';
    begin('n7', 'all');
    h.session.send({ type: 'format', format: { command: 'fontSize', value: '30px' } });
    expect(el('n7').querySelector('span span')!.getAttribute('style') ?? '').not.toContain('font-size');
  });

  it('clear unwraps style spans inside the range', () => {
    el('n7').innerHTML = 'a<span style="color:red">b</span>c';
    begin('n7', 'all');
    h.session.send({ type: 'format', format: { command: 'clear' } });
    expect(el('n7').innerHTML).toBe('abc');
  });
});

describe('insertPlainText', () => {
  it('inserts at the caret with line breaks', () => {
    el('n7').innerHTML = '';
    begin();
    insertPlainText(document, 'a\r\nb');
    expect(el('n7').innerHTML.replace(/<br\s*\/?>/, '|')).toBe('a|b');
  });
});
