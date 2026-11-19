import { describe, expect, it } from 'vitest';
import { cleanHTML, stripEditorAttrs } from './clean';

describe('cleanHTML', () => {
  it('removes contenteditable, spellcheck and data-pp-* everywhere', () => {
    const html = 'a <b data-pp-id="n1" contenteditable="true" class="x">b</b><span spellcheck="false" data-pp-sel="text" data-keep="1">c<i data-pp-hl>d</i></span>';
    expect(cleanHTML(document, html)).toBe('a <b class="x">b</b><span data-keep="1">c<i>d</i></span>');
  });

  it('leaves plain content untouched', () => {
    expect(cleanHTML(document, 'x &amp; y<br>z')).toBe('x &amp; y<br>z');
  });

  it('does not load resources while cleaning', () => {
    expect(cleanHTML(document, '<img src="http://invalid.invalid/x.png" data-pp-id="n1">')).toBe('<img src="http://invalid.invalid/x.png">');
  });

  it('strips one element', () => {
    const el = document.createElement('p');
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-pp-id', 'n1');
    el.setAttribute('id', 'keep');
    stripEditorAttrs(el);
    expect(el.outerHTML).toBe('<p id="keep"></p>');
  });
});
