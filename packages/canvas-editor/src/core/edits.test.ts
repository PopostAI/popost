import { describe, expect, it } from 'vitest';
import type { DocIndex, EditOp, EditResult, ElementInfo } from '../contracts';
import { EditError, applyOp, applySplices, applySplicesToIndex, checkLocality, invertSplices } from './edits';
import { createIdSource } from './ids';
import { findByAttr, findByTag, getAttr, parseIndex, parseRawIndex } from './source';
import { DECK, DECK_CRLF, ODD_DOCUMENTS, makeCtx, session } from './test-fixtures';
import type { Session } from './test-fixtures';

const LIST = '<ul>\n  <li id="a">A</li>\n  <li id="b">B</li>\n  <li id="c">C</li>\n</ul>\n';
const byId = (s: Session, id: string): ElementInfo => s.byAttr('id', id);

/** Apply an op and assert the splices/inverse contract; returns the result. */
function run(s: Session, op: EditOp): EditResult {
  const before = s.source();
  const result = s.apply(op);
  expect(applySplices(before, result.splices)).toBe(s.source());
  expect(applySplices(s.source(), result.inverse)).toBe(before);
  expect(result.inverse).toEqual(invertSplices(before, result.splices));
  return result;
}

function expectEditError(fn: () => unknown, code: EditError['code']): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EditError);
    expect((e as EditError).code).toBe(code);
    return;
  }
  throw new Error(`expected EditError(${code})`);
}

describe('setStyle', () => {
  it('adds a style attribute when missing', () => {
    const s = session('<div class="a">x</div>');
    const r = run(s, { kind: 'setStyle', id: s.byTag('div').id, props: { left: '10px' } });
    expect(s.source()).toBe('<div class="a" style="left: 10px">x</div>');
    expect(r.live).toEqual([{ kind: 'style', id: s.byTag('div').id, props: { left: '10px' } }]);
  });

  it('adds before "/>" of self-closing elements and after the tag name when no attributes', () => {
    const s = session('<svg><circle r="1"/><rect/></svg>');
    run(s, { kind: 'setStyle', id: s.byTag('circle').id, props: { fill: 'red' } });
    run(s, { kind: 'setStyle', id: s.byTag('rect').id, props: { fill: 'blue' } });
    expect(s.source()).toBe('<svg><circle r="1" style="fill: red"/><rect style="fill: blue"/></svg>');
  });

  it('merges into an existing style and leaves other declarations byte-identical', () => {
    const s = session(`<p style="  COLOR :red ;/*c*/ background:url('a;b.png')  ; top:1px">x</p>`);
    run(s, { kind: 'setStyle', id: s.byTag('p').id, props: { top: '2px', left: '3px' } });
    expect(s.source()).toBe(`<p style="  COLOR :red ;/*c*/ background:url('a;b.png')  ; top:2px; left: 3px">x</p>`);
  });

  it('removes properties; removing everything removes the attribute', () => {
    const s = session('<p class="k" style="a:1; b:2">x</p>');
    const id = s.byTag('p').id;
    run(s, { kind: 'setStyle', id, props: { a: null } });
    expect(s.source()).toBe('<p class="k" style="b:2">x</p>');
    run(s, { kind: 'setStyle', id, props: { b: null } });
    expect(s.source()).toBe('<p class="k">x</p>');
  });

  it('keeps single quotes, and rewrites unquoted attributes as quoted', () => {
    const a = session(`<p style='a:1'>x</p>`);
    run(a, { kind: 'setStyle', id: a.byTag('p').id, props: { font: `12px "Brand"` } });
    expect(a.source()).toBe(`<p style='a:1; font: 12px "Brand"'>x</p>`);
    const b = session('<p style=a:1>x</p>');
    run(b, { kind: 'setStyle', id: b.byTag('p').id, props: { b: '2' } });
    expect(b.source()).toBe('<p style="a:1; b: 2">x</p>');
    const c = session('<p style>x</p>');
    run(c, { kind: 'setStyle', id: c.byTag('p').id, props: { b: '2' } });
    expect(c.source()).toBe('<p style="b: 2">x</p>');
  });

  it('escapes values for the attribute and decodes existing entities', () => {
    const s = session('<p style="font-family:&quot;A&quot;">x</p>');
    run(s, { kind: 'setStyle', id: s.byTag('p').id, props: { 'font-family': '"B", serif' } });
    expect(s.source()).toBe('<p style="font-family:&quot;B&quot;, serif">x</p>');
    expect(getAttr(s.byTag('p'), 'style')).toBe('font-family:"B", serif');
  });

  it('keeps CRLF line endings and entity-encoded declarations in untouched parts of a multi-line style', () => {
    const s = session('<p style="\r\n  font-family: &quot;A&quot;;\r\n  color: red;\r\n">x</p>');
    run(s, { kind: 'setStyle', id: s.byTag('p').id, props: { color: 'blue', left: '1px' } });
    expect(s.source()).toBe('<p style="\r\n  font-family: &quot;A&quot;;\r\n  color: blue; left: 1px;\r\n">x</p>');
  });

  it('touches only the changed characters of the style value', () => {
    const s = session('<p style="left:100px; top:5px">x</p>');
    const r = run(s, { kind: 'setStyle', id: s.byTag('p').id, props: { left: '101px' } });
    expect(r.splices).toEqual([{ start: 17, end: 18, text: '1' }]);
  });

  it('lower-cases new property names, not custom properties', () => {
    const s = session('<p>x</p>');
    const r = run(s, { kind: 'setStyle', id: s.byTag('p').id, props: { 'Font-Size': '12px', '--Gap': '2px' } });
    expect(s.source()).toBe('<p style="font-size: 12px; --Gap: 2px">x</p>');
    expect(r.live[0]).toMatchObject({ props: { 'font-size': '12px', '--Gap': '2px' } });
  });

  it('is a no-op (same index, no splices) when nothing changes', () => {
    const s = session('<p style="a:1">x</p>');
    const before = s.index;
    const r = s.apply({ kind: 'setStyle', id: s.byTag('p').id, props: { a: '1', b: null } });
    expect(r.splices).toEqual([]);
    expect(r.inverse).toEqual([]);
    expect(r.index).toBe(before);
  });

  it('rejects invalid names and values that would break out of the declaration', () => {
    const s = session('<p>x</p>');
    const id = s.byTag('p').id;
    expectEditError(() => s.apply({ kind: 'setStyle', id, props: { 'a b': '1' } }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'setStyle', id, props: { color: 'red; top: 0' } }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'setStyle', id, props: { color: 'url(' } }), 'invalid-op');
    expect(s.source()).toBe('<p>x</p>');
  });

  it('refuses elements without a start tag and unknown ids', () => {
    const s = session('<p>x</p>');
    expectEditError(() => s.apply({ kind: 'setStyle', id: s.index.body!, props: { a: '1' } }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'setStyle', id: 'nope', props: { a: '1' } }), 'unknown-element');
  });

  it('works on explicit body and html tags', () => {
    const s = session('<html><body class="b"><p>x</p></body></html>');
    run(s, { kind: 'setStyle', id: s.index.body!, props: { margin: '0' } });
    expect(s.source()).toBe('<html><body class="b" style="margin: 0"><p>x</p></body></html>');
  });
});

describe('setAttr', () => {
  it('replaces only the value range', () => {
    const s = session(`<a  href = "x"   class='k'>t</a>`);
    const r = run(s, { kind: 'setAttr', id: s.byTag('a').id, name: 'href', value: 'y&z' });
    expect(s.source()).toBe(`<a  href = "y&amp;z"   class='k'>t</a>`);
    expect(r.live).toEqual([{ kind: 'attr', id: s.byTag('a').id, name: 'href', value: 'y&z' }]);
    expect(r.splices).toHaveLength(1);
    expect(r.splices[0].end - r.splices[0].start).toBe(1);
  });

  it('appends new attributes before ">" and "/>"', () => {
    const s = session('<div>x</div><br/><img src="a"/>');
    run(s, { kind: 'setAttr', id: s.byTag('div').id, name: 'data-x', value: '1' });
    run(s, { kind: 'setAttr', id: s.byTag('br').id, name: 'data-x', value: '2' });
    run(s, { kind: 'setAttr', id: s.byTag('img').id, name: 'alt', value: 'say "hi"' });
    expect(s.source()).toBe('<div data-x="1">x</div><br data-x="2"/><img src="a" alt="say &quot;hi&quot;"/>');
  });

  it('removes attributes together with the whitespace before them', () => {
    const s = session('<div class="a"  id="b" data-z>x</div>');
    const id = s.byTag('div').id;
    run(s, { kind: 'setAttr', id, name: 'id', value: null });
    expect(s.source()).toBe('<div class="a" data-z>x</div>');
    run(s, { kind: 'setAttr', id, name: 'data-z', value: null });
    expect(s.source()).toBe('<div class="a">x</div>');
    const r = s.apply({ kind: 'setAttr', id, name: 'missing', value: null });
    expect(r.splices).toEqual([]);
  });

  it('rewrites unquoted and valueless attributes', () => {
    const a = session('<div class=a>x</div>');
    run(a, { kind: 'setAttr', id: a.byTag('div').id, name: 'class', value: 'a b' });
    expect(a.source()).toBe('<div class="a b">x</div>');
    const b = session('<div hidden>x</div>');
    run(b, { kind: 'setAttr', id: b.byTag('div').id, name: 'hidden', value: 'until-found' });
    expect(b.source()).toBe('<div hidden="until-found">x</div>');
    const c = session('<div title="">x</div>');
    run(c, { kind: 'setAttr', id: c.byTag('div').id, name: 'title', value: 'T' });
    expect(c.source()).toBe('<div title="T">x</div>');
  });

  it('keeps single quotes and finds SVG attributes case-insensitively', () => {
    const s = session(`<svg viewBox='0 0 1 1'><path d="M0"/></svg>`);
    run(s, { kind: 'setAttr', id: s.byTag('svg').id, name: 'viewbox', value: `0 0 2 2` });
    expect(s.source()).toBe(`<svg viewBox='0 0 2 2'><path d="M0"/></svg>`);
  });

  it('is a no-op when the value is unchanged', () => {
    const s = session('<div class="a">x</div>');
    expect(s.apply({ kind: 'setAttr', id: s.byTag('div').id, name: 'class', value: 'a' }).splices).toEqual([]);
  });

  it('rejects event handlers, editor attributes and malformed names', () => {
    const s = session('<div>x</div>');
    const id = s.byTag('div').id;
    for (const name of ['onclick', 'OnLoad', 'data-pp-id', 'a b', '', '"x']) {
      expectEditError(() => s.apply({ kind: 'setAttr', id, name, value: '1' }), 'invalid-op');
    }
  });

  it('never sends dangerous attribute values to the live frame', () => {
    const s = session('<a href="x">t</a>');
    const r = run(s, { kind: 'setAttr', id: s.byTag('a').id, name: 'href', value: ' JaVa\nScript:alert(1)' });
    expect(r.live).toEqual([{ kind: 'attr', id: s.byTag('a').id, name: 'href', value: null }]);
  });

  it('keeps the element id', () => {
    const s = session('<div class="a">x</div>');
    const id = s.byTag('div').id;
    run(s, { kind: 'setAttr', id, name: 'class', value: 'much longer value' });
    expect(s.byTag('div').id).toBe(id);
  });
});

describe('setInnerHTML', () => {
  it('replaces the content between the tags', () => {
    const s = session('<h1 class="t">old <b>bold</b></h1><p>keep</p>');
    const h1 = s.byTag('h1');
    const r = run(s, { kind: 'setInnerHTML', id: h1.id, html: 'new <i>it</i>' });
    expect(s.source()).toBe('<h1 class="t">new <i>it</i></h1><p>keep</p>');
    expect(s.byTag('h1').id).toBe(h1.id);
    expect(r.live).toEqual([
      {
        kind: 'subtrees',
        items: [{ id: h1.id, previewHTML: `<h1 data-pp-id="${h1.id}" class="t">new <i data-pp-id="${s.byTag('i').id}">it</i></h1>` }],
      },
    ]);
  });

  it('gives new ids to the new children but keeps siblings', () => {
    const s = session('<div><b>x</b></div><p>y</p>');
    const b = s.byTag('b');
    const p = s.byTag('p');
    run(s, { kind: 'setInnerHTML', id: s.byTag('div').id, html: '<b>y</b>' });
    expect(s.byTag('b').id).not.toBe(b.id);
    expect(s.byTag('p').id).toBe(p.id);
  });

  it('is a no-op for identical content and handles empty content', () => {
    const s = session('<div>a</div>');
    expect(s.apply({ kind: 'setInnerHTML', id: s.byTag('div').id, html: 'a' }).splices).toEqual([]);
    run(s, { kind: 'setInnerHTML', id: s.byTag('div').id, html: '' });
    expect(s.source()).toBe('<div></div>');
    run(s, { kind: 'setInnerHTML', id: s.byTag('div').id, html: 'back' });
    expect(s.source()).toBe('<div>back</div>');
  });

  it('works for raw-text elements', () => {
    const s = session('<style>a{}</style><p>x</p>');
    run(s, { kind: 'setInnerHTML', id: s.byTag('style').id, html: 'b>c{color:red}' });
    expect(s.source()).toBe('<style>b>c{color:red}</style><p>x</p>');
  });

  it('works for an implicitly closed element', () => {
    const s = session('<p>one<p>two');
    run(s, { kind: 'setInnerHTML', id: s.byTag('p', 1).id, html: 'TWO' });
    expect(s.source()).toBe('<p>one<p>TWO');
  });

  it('rejects markup that would close the element early or swallow siblings', () => {
    const s = session('<div id="a"><p>x</p></div><div id="b">y</div>');
    const a = byId(s, 'a').id;
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: a, html: 'x</div><p>' }), 'locality');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: a, html: '</div></div>' }), 'locality');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: a, html: '<div>' }), 'locality');
    expect(s.source()).toBe('<div id="a"><p>x</p></div><div id="b">y</div>');
  });

  it('rejects content that breaks out of raw-text elements', () => {
    const s = session('<style>a{}</style><p>x</p>');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: s.byTag('style').id, html: '</style><div>' }), 'locality');
  });

  it('rejects nested paragraphs that would implicitly close the target', () => {
    const s = session('<p id="a">x</p><p>y</p>');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: byId(s, 'a').id, html: '<p>z</p>' }), 'locality');
  });

  it('cannot set content on void or self-closed elements', () => {
    const s = session('<div><br><svg><path/></svg></div>');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: s.byTag('br').id, html: 'x' }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: s.byTag('path').id, html: 'x' }), 'unsupported');
  });

  it('reloads the frame when the body is edited', () => {
    const s = session('<html><body><p>x</p></body></html>');
    const r = run(s, { kind: 'setInnerHTML', id: s.index.body!, html: '<p>y</p>' });
    expect(r.live).toEqual([{ kind: 'reload' }]);
  });

  it('emits no live update for elements the preview strips', () => {
    const s = session('<script>a()</script><p>x</p>');
    expect(run(s, { kind: 'setInnerHTML', id: s.byTag('script').id, html: 'b()' }).live).toEqual([]);
  });

  it('preserves Unicode and CRLF in content', () => {
    const s = session('<p>\r\n 日本 😀\r\n</p>');
    run(s, { kind: 'setInnerHTML', id: s.byTag('p').id, html: '😀 é' });
    expect(s.source()).toBe('<p>😀 é</p>');
  });
});

describe('remove', () => {
  it('removes whole lines for block elements', () => {
    const s = session(LIST);
    const r = run(s, { kind: 'remove', id: byId(s, 'b').id });
    expect(s.source()).toBe('<ul>\n  <li id="a">A</li>\n  <li id="c">C</li>\n</ul>\n');
    expect(r.live).toEqual([{ kind: 'remove', id: expect.any(String) }]);
  });

  it('removes first and last items cleanly, and everything', () => {
    const s = session(LIST);
    run(s, { kind: 'remove', id: byId(s, 'a').id });
    run(s, { kind: 'remove', id: byId(s, 'c').id });
    expect(s.source()).toBe('<ul>\n  <li id="b">B</li>\n</ul>\n');
    run(s, { kind: 'remove', id: byId(s, 'b').id });
    expect(s.source()).toBe('<ul>\n</ul>\n');
  });

  it('uses CRLF documents without leaving stray carriage returns', () => {
    const s = session(LIST.replace(/\n/g, '\r\n'));
    run(s, { kind: 'remove', id: byId(s, 'b').id });
    expect(s.source()).toBe('<ul>\r\n  <li id="a">A</li>\r\n  <li id="c">C</li>\r\n</ul>\r\n');
  });

  it('handles inline elements and elements sharing a line', () => {
    const a = session('<p>foo <b>x</b> bar</p>');
    run(a, { kind: 'remove', id: a.byTag('b').id });
    expect(a.source()).toBe('<p>foo  bar</p>');
    const b = session('<div>\n  <i>1</i> <i>2</i>\n</div>');
    run(b, { kind: 'remove', id: b.byTag('i', 0).id });
    expect(b.source()).toBe('<div>\n  <i>2</i>\n</div>');
    const c = session('<div>\n  <i>1</i> <i>2</i>\n</div>');
    run(c, { kind: 'remove', id: c.byTag('i', 1).id });
    expect(c.source()).toBe('<div>\n  <i>1</i>\n</div>');
  });

  it('removes a last element without a trailing newline', () => {
    const s = session('<div>\n  <p>x</p></div>');
    run(s, { kind: 'remove', id: s.byTag('p').id });
    expect(s.source()).toBe('<div>\n  </div>');
  });

  it('keeps the ids of everything else', () => {
    const s = session(LIST);
    const a = byId(s, 'a').id;
    const c = byId(s, 'c').id;
    run(s, { kind: 'remove', id: byId(s, 'b').id });
    expect(byId(s, 'a').id).toBe(a);
    expect(byId(s, 'c').id).toBe(c);
  });

  it('refuses html/head/body and unknown ids', () => {
    const s = session('<html><head></head><body><p>x</p></body></html>');
    for (const id of [s.index.html!, s.index.head!, s.index.body!]) expectEditError(() => s.apply({ kind: 'remove', id }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'remove', id: 'zzz' }), 'unknown-element');
  });

  it('removes an implicitly closed element without eating its sibling', () => {
    const s = session('<p>a<p>b');
    run(s, { kind: 'remove', id: s.byTag('p', 0).id });
    expect(s.source()).toBe('<p>b');
  });

  it('removes a page of the deck and leaves everything else byte-identical', () => {
    const s = session(DECK);
    const page = s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb');
    const before = s.source();
    run(s, { kind: 'remove', id: page.id });
    const after = s.source();
    expect(after.startsWith(before.slice(0, before.indexOf('  <section class="slide" data-popost-page="p-bbbb')))).toBe(true);
    expect(after).not.toContain('p-bbbbbbbbbbbb');
    expect(after.endsWith('</section>\n</body>\n</html>\n')).toBe(true);
  });
});

describe('duplicate', () => {
  it('inserts a copy after the element with the same indentation', () => {
    const s = session(LIST);
    const b = byId(s, 'b');
    const r = run(s, { kind: 'duplicate', id: b.id });
    expect(s.source()).toBe('<ul>\n  <li id="a">A</li>\n  <li id="b">B</li>\n  <li id="b">B</li>\n  <li id="c">C</li>\n</ul>\n');
    const copy = s.index.elements.get(r.createdId!)!;
    expect(s.index.source.slice(copy.start, copy.end)).toBe('<li id="b">B</li>');
    expect(copy.id).not.toBe(b.id);
    expect(s.index.elements.get(b.id)!.start).toBeLessThan(copy.start);
    expect(r.live).toEqual([
      {
        kind: 'insert',
        parentId: s.byTag('ul').id,
        beforeId: byId(s, 'c').id,
        previewHTML: `<li data-pp-id="${copy.id}" id="b">B</li>`,
      },
    ]);
  });

  it('appends after the last child and uses CRLF line breaks', () => {
    const s = session(LIST.replace(/\n/g, '\r\n'));
    const r = run(s, { kind: 'duplicate', id: byId(s, 'c').id });
    expect(s.source()).toContain('<li id="c">C</li>\r\n  <li id="c">C</li>\r\n</ul>');
    expect((r.live[0] as { beforeId: string | null }).beforeId).toBeNull();
  });

  it('duplicates inline elements in place', () => {
    const s = session('<p>a<b>x</b>b</p>');
    run(s, { kind: 'duplicate', id: s.byTag('b').id });
    expect(s.source()).toBe('<p>a<b>x</b><b>x</b>b</p>');
  });

  it('gives a duplicated page root a fresh p-<12 hex> page key', () => {
    const s = session(DECK);
    const page = s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa');
    const r = run(s, { kind: 'duplicate', id: page.id });
    const copy = s.index.elements.get(r.createdId!)!;
    const key = getAttr(copy, 'data-popost-page')!;
    expect(key).toMatch(/^p-[0-9a-f]{12}$/);
    expect(key).not.toBe('p-aaaaaaaaaaaa');
    expect(getAttr(s.index.elements.get(page.id)!, 'data-popost-page')).toBe('p-aaaaaaaaaaaa');
    expect(findByAttr(s.index, 'data-popost-page').map((e) => getAttr(e, 'data-popost-page'))).toEqual([
      'p-aaaaaaaaaaaa',
      key,
      'p-bbbbbbbbbbbb',
    ]);
    // everything else in the copy is verbatim, including agent attributes
    const orig = s.index.source.slice(page.start, s.index.elements.get(page.id)!.end);
    const dup = s.index.source.slice(copy.start, copy.end);
    expect(dup.replace(key, 'p-aaaaaaaaaaaa')).toBe(orig);
    expect(findByAttr(s.index, 'data-layer-id', 'title')).toHaveLength(2);
  });

  it('generates real random keys by default and never collides with existing ones', () => {
    const s = session(DECK);
    s.ctx.randomHex = undefined;
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = s.apply({ kind: 'duplicate', id: s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa').id });
      keys.add(getAttr(s.index.elements.get(r.createdId!)!, 'data-popost-page')!);
    }
    expect(keys.size).toBe(5);
    for (const k of keys) expect(k).toMatch(/^p-[0-9a-f]{12}$/);
  });

  it('retries when the random key is already used', () => {
    const s = session(DECK);
    const seq = ['aaaaaaaaaaaa', 'cccccccccccc'];
    s.ctx.randomHex = () => seq.shift()!;
    const r = s.apply({ kind: 'duplicate', id: s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa').id });
    expect(getAttr(s.index.elements.get(r.createdId!)!, 'data-popost-page')).toBe('p-cccccccccccc');
  });

  it('leaves page keys alone for non-page elements and for pages without a key', () => {
    const s = session('<div class="slide"><p class="x">a</p></div>');
    const r = run(s, { kind: 'duplicate', id: s.byTag('p').id });
    expect(s.source()).toBe('<div class="slide"><p class="x">a</p><p class="x">a</p></div>');
    expect(r.createdId).toBeDefined();
    const t = session('<div class="slide">a</div>');
    run(t, { kind: 'duplicate', id: t.byTag('div').id });
    expect(t.source()).toBe('<div class="slide">a</div>\n<div class="slide">a</div>');
  });

  it('renews keys of all page roots inside a duplicated wrapper', () => {
    const s = session('<main>\n  <div class="slide" data-popost-page="p-1"></div>\n  <div class="slide" data-popost-page="p-2"></div>\n</main>');
    run(s, { kind: 'duplicate', id: s.byTag('main').id });
    const keys = findByAttr(s.index, 'data-popost-page').map((e) => getAttr(e, 'data-popost-page'));
    expect(new Set(keys).size).toBe(4);
  });

  it('does not touch a slide nested inside a page when duplicating the page', () => {
    const s = session('<div class="slide" data-popost-page="p-1"><div class="slide" data-popost-page="inner"></div></div>');
    const r = run(s, { kind: 'duplicate', id: s.byTag('div').id });
    const copy = s.index.elements.get(r.createdId!)!;
    expect(s.index.source.slice(copy.start, copy.end)).toContain('data-popost-page="inner"');
  });

  it('keeps ids of the original and following elements; copies get fresh ids', () => {
    const s = session(LIST);
    const ids = ['a', 'b', 'c'].map((i) => byId(s, i).id);
    const r = run(s, { kind: 'duplicate', id: byId(s, 'a').id });
    expect(byId(s, 'a').id).toBe(ids[0]);
    expect(byId(s, 'c').id).toBe(ids[2]);
    expect(ids).not.toContain(r.createdId);
  });

  it('falls back to reload for table rows and refuses structural elements', () => {
    const s = session('<table><tr><td>a</td></tr></table>');
    expect(run(s, { kind: 'duplicate', id: s.byTag('tr').id }).live).toEqual([{ kind: 'reload' }]);
    expectEditError(() => s.apply({ kind: 'duplicate', id: s.index.body! }), 'unsupported');
  });

  it('creates no live update for elements the preview strips', () => {
    const s = session('<script>x()</script>');
    const r = run(s, { kind: 'duplicate', id: s.byTag('script').id });
    expect(r.live).toEqual([]);
    expect(r.createdId).toBeDefined();
  });
});

describe('move', () => {
  it('moves an element before a sibling, carrying its indentation', () => {
    const s = session(LIST);
    const c = byId(s, 'c').id;
    const r = run(s, { kind: 'move', id: c, parentId: s.byTag('ul').id, beforeId: byId(s, 'a').id });
    expect(s.source()).toBe('<ul>\n  <li id="c">C</li>\n  <li id="a">A</li>\n  <li id="b">B</li>\n</ul>\n');
    expect(r.live).toEqual([{ kind: 'move', id: c, parentId: s.byTag('ul').id, beforeId: byId(s, 'a').id }]);
    expect(byId(s, 'c').id).toBe(c);
  });

  it('appends to the end (beforeId null)', () => {
    const s = session(LIST);
    run(s, { kind: 'move', id: byId(s, 'a').id, parentId: s.byTag('ul').id, beforeId: null });
    expect(s.source()).toBe('<ul>\n  <li id="b">B</li>\n  <li id="c">C</li>\n  <li id="a">A</li>\n</ul>\n');
  });

  it('moves between parents and into an empty parent', () => {
    const s = session('<div id="p">\n  <p id="x">X</p>\n</div>\n<div id="q"></div>\n');
    run(s, { kind: 'move', id: s.byAttr('id', 'x').id, parentId: s.byAttr('id', 'q').id, beforeId: null });
    expect(s.source()).toBe('<div id="p">\n</div>\n<div id="q"><p id="x">X</p></div>\n');
  });

  it('keeps ids of the moved subtree and everything else', () => {
    const s = session('<div id="a"><b>x</b></div><div id="b"><i>y</i></div>');
    const ids = [s.byTag('div', 0).id, s.byTag('b').id, s.byTag('div', 1).id, s.byTag('i').id];
    run(s, { kind: 'move', id: ids[0], parentId: s.index.body!, beforeId: null });
    expect(s.source()).toBe('<div id="b"><i>y</i></div><div id="a"><b>x</b></div>');
    expect(byId(s, 'a').id).toBe(ids[0]);
    expect(s.byTag('b').id).toBe(ids[1]);
    expect(byId(s, 'b').id).toBe(ids[2]);
    expect(s.byTag('i').id).toBe(ids[3]);
  });

  it('is a no-op when the element would stay where it is', () => {
    const s = session(LIST);
    const ul = s.byTag('ul').id;
    const b = byId(s, 'b').id;
    const c = byId(s, 'c').id;
    expect(s.apply({ kind: 'move', id: b, parentId: ul, beforeId: b }).splices).toEqual([]);
    expect(s.apply({ kind: 'move', id: b, parentId: ul, beforeId: c }).splices).toEqual([]);
    expect(s.apply({ kind: 'move', id: c, parentId: ul, beforeId: null }).splices).toEqual([]);
  });

  it('moves inline elements without indentation changes', () => {
    const s = session('<p><a>1</a><b>2</b><i>3</i></p>');
    run(s, { kind: 'move', id: s.byTag('i').id, parentId: s.byTag('p').id, beforeId: s.byTag('a').id });
    expect(s.source()).toBe('<p><i>3</i><a>1</a><b>2</b></p>');
  });

  it('works with CRLF and when the target is later in the document', () => {
    const s = session(LIST.replace(/\n/g, '\r\n'));
    run(s, { kind: 'move', id: byId(s, 'a').id, parentId: s.byTag('ul').id, beforeId: byId(s, 'c').id });
    expect(s.source()).toBe('<ul>\r\n  <li id="b">B</li>\r\n  <li id="a">A</li>\r\n  <li id="c">C</li>\r\n</ul>\r\n');
  });

  it('keeps data-popost-page when a page is moved', () => {
    const s = session(DECK);
    const [p1, p2] = [s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa'), s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb')];
    run(s, { kind: 'move', id: p2.id, parentId: s.index.body!, beforeId: p1.id });
    expect(findByAttr(s.index, 'data-popost-page').map((e) => getAttr(e, 'data-popost-page'))).toEqual(['p-bbbbbbbbbbbb', 'p-aaaaaaaaaaaa']);
    expect(s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb').id).toBe(p2.id);
  });

  it('rejects impossible moves', () => {
    const s = session('<div id="a"><p id="b"><i id="c"></i></p></div><hr><span>t</span>');
    const a = s.byAttr('id', 'a').id;
    const b = s.byAttr('id', 'b').id;
    const c = s.byAttr('id', 'c').id;
    expectEditError(() => s.apply({ kind: 'move', id: a, parentId: c, beforeId: null }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'move', id: a, parentId: a, beforeId: null }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'move', id: c, parentId: a, beforeId: c === b ? null : s.byTag('span').id }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'move', id: c, parentId: s.byTag('hr').id, beforeId: null }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'move', id: s.index.body!, parentId: a, beforeId: null }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'move', id: 'zz', parentId: a, beforeId: null }), 'unknown-element');
  });

  it('falls back to reload for table parts', () => {
    const s = session('<table><tr id="a"><td>1</td></tr><tr id="b"><td>2</td></tr></table>');
    const r = run(s, { kind: 'move', id: s.byAttr('id', 'b').id, parentId: s.byTag('table').id, beforeId: s.byAttr('id', 'a').id });
    expect(r.live).toEqual([{ kind: 'reload' }]);
  });
});

describe('insertHTML', () => {
  it('inserts before a sibling with matching indentation', () => {
    const s = session(LIST);
    const r = run(s, { kind: 'insertHTML', parentId: s.byTag('ul').id, beforeId: byId(s, 'b').id, html: '  <li id="n">N</li>\n' });
    expect(s.source()).toBe('<ul>\n  <li id="a">A</li>\n  <li id="n">N</li>\n  <li id="b">B</li>\n  <li id="c">C</li>\n</ul>\n');
    expect(s.index.elements.get(r.createdId!)!.tag).toBe('li');
    expect(r.live).toEqual([
      { kind: 'insert', parentId: s.byTag('ul').id, beforeId: byId(s, 'b').id, previewHTML: `<li data-pp-id="${r.createdId}" id="n">N</li>` },
    ]);
  });

  it('appends after the last child and into empty parents', () => {
    const s = session(LIST);
    run(s, { kind: 'insertHTML', parentId: s.byTag('ul').id, beforeId: null, html: '<li id="z">Z</li>' });
    expect(s.source()).toBe('<ul>\n  <li id="a">A</li>\n  <li id="b">B</li>\n  <li id="c">C</li>\n  <li id="z">Z</li>\n</ul>\n');
    const t = session('<div></div>');
    run(t, { kind: 'insertHTML', parentId: t.byTag('div').id, beforeId: null, html: '<p>x</p>' });
    expect(t.source()).toBe('<div><p>x</p></div>');
  });

  it('inserts several elements and reports them in reverse order so each beforeId exists', () => {
    const s = session('<div><i>x</i></div>');
    const r = run(s, { kind: 'insertHTML', parentId: s.byTag('div').id, beforeId: s.byTag('i').id, html: '<a>1</a><b>2</b>' });
    expect(s.source()).toBe('<div><a>1</a><b>2</b><i>x</i></div>');
    expect(r.live.map((u) => (u.kind === 'insert' ? u.previewHTML.slice(0, 2) : u.kind))).toEqual(['<b', '<a']);
    expect((r.live[0] as { beforeId: string }).beforeId).toBe(s.byTag('i').id);
    expect((r.live[1] as { beforeId: string }).beforeId).toBe(s.byTag('b').id);
    expect(r.createdId).toBe(s.byTag('a').id);
  });

  it('inserts into the implied body of a fragment-only document', () => {
    const s = session('<p>a</p>');
    run(s, { kind: 'insertHTML', parentId: s.index.body!, beforeId: null, html: '<p>b</p>' });
    expect(s.source()).toBe('<p>a</p>\n<p>b</p>');
  });

  it('trims the payload, and plain text triggers a reload', () => {
    const s = session('<div>a</div>');
    const r = run(s, { kind: 'insertHTML', parentId: s.byTag('div').id, beforeId: null, html: '  text  ' });
    expect(s.source()).toBe('<div>atext</div>');
    expect(r.live).toEqual([{ kind: 'reload' }]);
    expect(r.createdId).toBeUndefined();
  });

  it('reloads when top-level comments or text come along', () => {
    const s = session('<div></div>');
    const r = run(s, { kind: 'insertHTML', parentId: s.byTag('div').id, beforeId: null, html: '<b>x</b> and text' });
    expect(r.live).toEqual([{ kind: 'reload' }]);
    expect(r.createdId).toBe(s.byTag('b').id);
  });

  it('rejects empty, unbalanced and impossible inserts', () => {
    const s = session('<div id="a"><p>x</p></div><div id="b"></div><br><script></script>');
    const a = s.byAttr('id', 'a').id;
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: a, beforeId: null, html: '  ' }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: a, beforeId: null, html: '</div><p>' }), 'locality');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: a, beforeId: null, html: '<div>' }), 'locality');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: s.byTag('br').id, beforeId: null, html: '<i></i>' }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: s.byTag('script').id, beforeId: null, html: '<i></i>' }), 'unsupported');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: a, beforeId: s.byAttr('id', 'b').id, html: '<i></i>' }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: 'zz', beforeId: null, html: '<i></i>' }), 'unknown-element');
  });

  it('rejects markup the parser would drop (a row inside a div)', () => {
    const s = session('<div></div>');
    expectEditError(() => s.apply({ kind: 'insertHTML', parentId: s.byTag('div').id, beforeId: null, html: '<tr><td>x</td></tr>' }), 'locality');
  });
});

describe('upsertFontStyle', () => {
  const FONT = { kind: 'upsertFontStyle', key: 'brand' } as const;

  it('appends a new style at the end of <head>, matching indentation', () => {
    const s = session('<html>\n<head>\n  <meta charset="utf-8">\n  <title>t</title>\n</head>\n<body><p>x</p></body>\n</html>');
    const r = run(s, { ...FONT, css: '@font-face{font-family:B}' });
    expect(s.source()).toBe(
      '<html>\n<head>\n  <meta charset="utf-8">\n  <title>t</title>\n  <style data-popost-font="brand">@font-face{font-family:B}</style>\n</head>\n<body><p>x</p></body>\n</html>',
    );
    expect(r.live).toEqual([{ kind: 'headStyle', key: 'brand', css: '@font-face{font-family:B}' }]);
    const style = s.byTag('style');
    expect(s.index.elements.get(style.parent!)!.tag).toBe('head');
  });

  it('replaces the content of the existing element in place and never duplicates', () => {
    const s = session(DECK);
    run(s, { ...FONT, css: '/* v2 */' });
    run(s, { ...FONT, css: '/* v3 */' });
    const fonts = findByAttr(s.index, 'data-popost-font', 'brand');
    expect(fonts).toHaveLength(1);
    expect(s.index.source.slice(fonts[0].startTagEnd, fonts[0].endTagStart!)).toBe('/* v3 */');
    expect(s.apply({ ...FONT, css: '/* v3 */' }).splices).toEqual([]);
  });

  it('adds other keys beside it, one element per key', () => {
    const s = session(DECK);
    run(s, { kind: 'upsertFontStyle', key: 'serif', css: 'a{}' });
    run(s, { kind: 'upsertFontStyle', key: 'serif', css: 'b{}' });
    expect(findByTag(s.index, 'style').filter((e) => getAttr(e, 'data-popost-font') !== null)).toHaveLength(2);
  });

  it('removes accidental duplicates of the same key', () => {
    const s = session('<head><style data-popost-font="k">1</style>\n<style data-popost-font="k">2</style></head><p>x</p>');
    run(s, { kind: 'upsertFontStyle', key: 'k', css: 'new' });
    expect(findByAttr(s.index, 'data-popost-font', 'k')).toHaveLength(1);
    expect(s.source()).toContain('>new</style>');
    expect(s.source()).not.toContain('>2</style>');
  });

  it('creates the style in an implied head and in a document without any head content', () => {
    const a = session('<p>x</p>');
    run(a, { ...FONT, css: 'a{}' });
    expect(a.source()).toBe('<style data-popost-font="brand">a{}</style><p>x</p>');
    expect(a.index.elements.get(a.byTag('style').parent!)!.tag).toBe('head');
    const b = session('<!doctype html>\n<style>x{}</style>\n<div class="slide"></div>\n');
    run(b, { ...FONT, css: 'a{}' });
    expect(b.source()).toBe('<!doctype html>\n<style>x{}</style>\n<style data-popost-font="brand">a{}</style>\n<div class="slide"></div>\n');
  });

  it('handles an explicit head without an end tag', () => {
    const s = session('<head><title>t</title><body><p>x</p>');
    run(s, { ...FONT, css: 'a{}' });
    expect(s.source()).toBe('<head><title>t</title><style data-popost-font="brand">a{}</style><body><p>x</p>');
  });

  it('escapes the key and rejects css that would end the element', () => {
    const s = session('<head></head><p>x</p>');
    run(s, { kind: 'upsertFontStyle', key: 'a"b', css: '' });
    expect(s.source()).toContain('data-popost-font="a&quot;b"');
    expectEditError(() => s.apply({ ...FONT, css: 'a{}</style><script>' }), 'invalid-op');
    expectEditError(() => s.apply({ kind: 'upsertFontStyle', key: '', css: 'a' }), 'invalid-op');
  });

  it('touches nothing but the head', () => {
    const s = session(DECK);
    const before = s.source();
    run(s, { ...FONT, css: 'x{}' });
    const headEnd = before.indexOf('</head>');
    expect(s.source().slice(s.source().indexOf('</head>'))).toBe(before.slice(headEnd));
  });
});

describe('replaceDocument', () => {
  it('replaces the whole source with a minimal splice and reloads', () => {
    const s = session('<div>a</div><p>b</p>');
    const p = s.byTag('p').id;
    const r = run(s, { kind: 'replaceDocument', source: '<div>a</div><p>c</p>' });
    expect(r.splices).toEqual([{ start: 15, end: 16, text: 'c' }]);
    expect(r.live).toEqual([{ kind: 'reload' }]);
    expect(s.byTag('p').id).toBe(p);
  });
  it('accepts arbitrary documents (no locality check) and empty ones', () => {
    const s = session(DECK);
    run(s, { kind: 'replaceDocument', source: '<main>new</main>' });
    expect(s.source()).toBe('<main>new</main>');
    run(s, { kind: 'replaceDocument', source: '' });
    expect(s.source()).toBe('');
    run(s, { kind: 'replaceDocument', source: DECK });
    expect(s.source()).toBe(DECK);
  });
  it('is a no-op for identical source', () => {
    const s = session('<p>a</p>');
    expect(s.apply({ kind: 'replaceDocument', source: '<p>a</p>' }).splices).toEqual([]);
  });
});

describe('locality check', () => {
  it('accepts every well-formed edit of the deck and rejects structural damage', () => {
    const idx = parseIndex(DECK, createIdSource());
    const title = findByAttr(idx, 'data-layer-id', 'title')[0];
    const splices = [{ start: title.startTagEnd, end: title.endTagStart!, text: 'ok' }];
    const raw = parseRawIndex(applySplices(DECK, splices));
    expect(() => checkLocality(idx, raw, splices)).not.toThrow();

    const bad = [{ start: title.startTagEnd, end: title.endTagStart!, text: '</section>' }];
    const rawBad = parseRawIndex(applySplices(DECK, bad));
    expect(() => checkLocality(idx, rawBad, bad)).toThrow(EditError);
  });

  it('does not modify state when an op is rejected', () => {
    const s = session(DECK);
    const before = s.index;
    const title = s.byAttr('data-layer-id', 'title');
    expectEditError(() => s.apply({ kind: 'setInnerHTML', id: title.id, html: 'x</h1></section><section>' }), 'locality');
    expect(s.index).toBe(before);
    expect(s.source()).toBe(DECK);
  });

  it('reports a typed error with a message', () => {
    const s = session('<div id="a"></div>');
    try {
      s.apply({ kind: 'setInnerHTML', id: s.byTag('div').id, html: '</div>' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EditError);
      expect((e as EditError).name).toBe('EditError');
      expect((e as EditError).message).toMatch(/structure/);
    }
  });
});

describe('agent attributes and untouched bytes', () => {
  const AGENT = /\sdata-(layer-id|slot|canvas-[a-z-]+)="[^"]*"/g;
  const agentAttrs = (src: string): string[] => (src.match(AGENT) ?? []).sort();

  const ops = (s: Session): EditOp[] => {
    const title = s.byAttr('data-layer-id', 'title').id;
    const sub = s.byAttr('data-layer-id', 'sub').id;
    const logo = s.byAttr('data-layer-id', 'logo').id;
    const page = s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa').id;
    return [
      { kind: 'setStyle', id: title, props: { left: '100px', top: null, 'font-size': '70px' } },
      { kind: 'setAttr', id: logo, name: 'alt', value: 'new' },
      { kind: 'setAttr', id: sub, name: 'class', value: 'k' },
      { kind: 'setInnerHTML', id: title, html: 'Hello' },
      { kind: 'move', id: sub, parentId: s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb').id, beforeId: null },
      { kind: 'upsertFontStyle', key: 'brand', css: 'x{}' },
      { kind: 'setAttr', id: page, name: 'data-popost-name', value: 'Renamed' },
    ];
  };

  it('ops that do not target agent attributes never alter them', () => {
    for (const src of [DECK, DECK_CRLF]) {
      const s = session(src);
      const expected = agentAttrs(src);
      for (const op of ops(s)) {
        run(s, op);
        expect(agentAttrs(s.source())).toEqual(expected);
      }
    }
  });

  it('remove drops only the removed attributes, duplicate only adds copies', () => {
    const s = session(DECK);
    const before = agentAttrs(DECK);
    run(s, { kind: 'duplicate', id: s.byAttr('data-layer-id', 'card').id });
    const afterDup = agentAttrs(s.source());
    expect(afterDup.length).toBe(before.length + 2); // layer-id and the nested data-slot
    expect(before.every((a) => afterDup.includes(a))).toBe(true);
    run(s, { kind: 'remove', id: s.byAttr('data-layer-id', 'logo').id });
    expect(agentAttrs(s.source())).toEqual(afterDup.filter((a) => !a.includes('"logo"')));
  });

  it('can still set agent attributes when explicitly targeted', () => {
    const s = session(DECK);
    run(s, { kind: 'setAttr', id: s.byAttr('data-layer-id', 'title').id, name: 'data-layer-id', value: 'headline' });
    expect(s.source()).toContain('data-layer-id="headline"');
  });

  it('setStyle on a deck element changes only that style value', () => {
    const s = session(DECK);
    const title = s.byAttr('data-layer-id', 'title');
    run(s, { kind: 'setStyle', id: title.id, props: { left: '90px' } });
    expect(s.source()).toBe(DECK.replace('left:80px; top:120px; font-size:64px', 'left:90px; top:120px; font-size:64px'));
  });
});

describe('inverse splices restore the original exactly (every op, LF and CRLF)', () => {
  for (const [name, src] of [['LF', DECK], ['CRLF', DECK_CRLF]] as const) {
    it(`deck ${name}`, () => {
      const s = session(src);
      const id = (v: string): string => s.byAttr('data-layer-id', v).id;
      const ops: EditOp[] = [
        { kind: 'setStyle', id: id('title'), props: { color: 'red', top: null } },
        { kind: 'setAttr', id: id('logo'), name: 'alt', value: 'x' },
        { kind: 'setInnerHTML', id: id('title'), html: '<em>x</em>' },
        { kind: 'duplicate', id: s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa').id },
        { kind: 'move', id: id('sub'), parentId: s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb').id, beforeId: id('card') },
        { kind: 'insertHTML', parentId: id('card'), beforeId: null, html: '<span>new</span>' },
        { kind: 'upsertFontStyle', key: 'brand', css: 'a{}' },
        { kind: 'upsertFontStyle', key: 'other', css: 'b{}' },
        { kind: 'remove', id: id('logo') },
        { kind: 'replaceDocument', source: '<p>x</p>' },
      ];
      for (const op of ops) {
        const before = s.source();
        const r = run(s, op);
        expect(applySplices(r.index.source, r.inverse)).toBe(before);
      }
    });
  }

  it('undo/redo replay via applySplicesToIndex keeps surviving ids', () => {
    const s = session(DECK);
    const ctx = makeCtx(5000);
    const title = s.byAttr('data-layer-id', 'title');
    const logo = s.byAttr('data-layer-id', 'logo');
    const original = s.index;
    const r = s.apply({ kind: 'remove', id: logo.id });
    const undone = applySplicesToIndex(r.index, r.inverse, ctx);
    expect(undone.index.source).toBe(DECK);
    expect(undone.live).toEqual([{ kind: 'reload' }]);
    expect(undone.index.elements.get(title.id)!.tag).toBe('h1');
    expect(undone.index.order).toHaveLength(original.order.length);
    const redone = applySplicesToIndex(undone.index, r.splices, ctx);
    expect(redone.index.source).toBe(r.index.source);
    expect(redone.inverse).toEqual(r.inverse);
    expect(applySplicesToIndex(r.index, [], ctx).live).toEqual([]);
  });
});

describe('stable ids across unrelated edits', () => {
  it('layer ids survive style edits, duplicates, moves and removals elsewhere', () => {
    const s = session(DECK);
    const layers = ['bg', 'title', 'sub', 'logo', 'mark', 'card'];
    const ids = Object.fromEntries(layers.map((l) => [l, s.byAttr('data-layer-id', l).id]));
    const expectStable = (except: string[] = []): void => {
      for (const l of layers) {
        if (except.includes(l)) continue;
        const el = s.index.elements.get(ids[l]);
        expect(el, l).toBeDefined();
        expect(getAttr(el!, 'data-layer-id'), l).toBe(l);
      }
    };
    run(s, { kind: 'setStyle', id: ids.title, props: { left: '1px' } });
    expectStable();
    run(s, { kind: 'duplicate', id: s.byAttr('data-popost-page', 'p-bbbbbbbbbbbb').id });
    expectStable();
    run(s, { kind: 'move', id: ids.sub, parentId: s.byAttr('data-popost-page', 'p-aaaaaaaaaaaa').id, beforeId: ids.bg });
    expectStable();
    run(s, { kind: 'upsertFontStyle', key: 'x', css: 'a{}' });
    expectStable();
    run(s, { kind: 'setInnerHTML', id: ids.sub, html: 'edited <b>text</b>' });
    expectStable();
    run(s, { kind: 'remove', id: ids.logo });
    expectStable(['logo']);
  });
});

describe('byte-exact round trip', () => {
  it('opening and saving without ops is the identity, for every fixture shape', () => {
    for (const src of [DECK, DECK_CRLF, '', '<p>a<p>b', '﻿<!doctype html>x', '<table><tr><td>a</table>']) {
      const idx = parseIndex(src, createIdSource());
      expect(idx.source).toBe(src);
      const noop = applySplicesToIndex(idx, [], makeCtx());
      expect(noop.index.source).toBe(src);
    }
  });

  it('applyOp on a pristine index never mutates it', () => {
    const idx: DocIndex = parseIndex(DECK, createIdSource());
    const snapshot = JSON.stringify([...idx.elements.entries()]);
    const title = findByAttr(idx, 'data-layer-id', 'title')[0];
    applyOp(idx, { kind: 'setStyle', id: title.id, props: { left: '5px' } }, makeCtx());
    expect(JSON.stringify([...idx.elements.entries()])).toBe(snapshot);
  });
});

describe('ops on awkward documents', () => {
  it('either succeed with an exact inverse and a consistent index, or fail with a typed EditError', () => {
    const shape = (idx: DocIndex): Array<[string, number, number]> =>
      idx.order.map((id) => {
        const el = idx.elements.get(id)!;
        return [el.tag, el.start, el.end];
      });
    let succeeded = 0;
    for (const [name, src] of Object.entries(ODD_DOCUMENTS)) {
      const idx = parseIndex(src, createIdSource());
      for (const id of idx.order) {
        const ops: EditOp[] = [
          { kind: 'setAttr', id, name: 'data-t', value: '1' },
          { kind: 'setStyle', id, props: { left: '1px' } },
          { kind: 'duplicate', id },
          { kind: 'setInnerHTML', id, html: 'x' },
          { kind: 'remove', id },
        ];
        for (const op of ops) {
          try {
            const r = applyOp(idx, op, makeCtx(1000));
            expect(applySplices(r.index.source, r.inverse), `${name} ${op.kind}`).toBe(src);
            expect(shape(r.index), `${name} ${op.kind}`).toEqual(shape(parseIndex(r.index.source, createIdSource())));
            succeeded++;
          } catch (e) {
            expect(e, `${name} ${op.kind}: ${(e as Error).message}`).toBeInstanceOf(EditError);
          }
        }
      }
    }
    expect(succeeded).toBeGreaterThan(300);
  });
});

describe('selectable marks in live updates', () => {
  const page = (body: string) => `<div class="slide">${body}</div>`;

  it('keeps plain attr/style updates when marks do not change', () => {
    const s = session(page('<p id="a">x</p>'));
    const p = byId(s, 'a');
    expect(run(s, { kind: 'setStyle', id: p.id, props: { left: '1px' } }).live[0].kind).toBe('style');
    expect(run(s, { kind: 'setAttr', id: p.id, name: 'title', value: 't' }).live[0].kind).toBe('attr');
  });

  it('re-renders the element when data-layer-id makes it selectable (and back)', () => {
    const s = session(page('<div id="a"></div>'));
    const div = byId(s, 'a');
    const added = run(s, { kind: 'setAttr', id: div.id, name: 'data-layer-id', value: 'x' });
    expect(added.live).toEqual([{ kind: 'subtrees', items: [{ id: div.id, previewHTML: `<div data-pp-id="${div.id}" data-pp-sel="box" id="a" data-layer-id="x"></div>` }] }]);
    expect(run(s, { kind: 'setAttr', id: div.id, name: 'data-layer-id', value: null }).live[0].kind).toBe('subtrees');
  });

  it('re-renders when a background image appears or disappears', () => {
    const s = session(page('<div id="a"></div>'));
    const div = byId(s, 'a');
    const r = run(s, { kind: 'setStyle', id: div.id, props: { background: 'url(a.png)' } });
    expect(r.live).toHaveLength(1);
    expect(r.live[0].kind).toBe('subtrees');
    expect(run(s, { kind: 'setStyle', id: div.id, props: { left: '2px' } }).live[0].kind).toBe('style');
    expect(run(s, { kind: 'setStyle', id: div.id, props: { background: null } }).live[0].kind).toBe('subtrees');
  });

  it('re-renders when a class change affects descendants (.notes), and reloads for page roots', () => {
    const s = session(page('<div id="a"><p>x</p></div>'));
    const div = byId(s, 'a');
    expect(run(s, { kind: 'setAttr', id: div.id, name: 'class', value: 'notes' }).live[0].kind).toBe('subtrees');
    expect(run(s, { kind: 'setAttr', id: div.id, name: 'class', value: 'plain' }).live[0].kind).toBe('subtrees');
    expect(run(s, { kind: 'setAttr', id: div.id, name: 'class', value: 'plain2' }).live[0].kind).toBe('attr');
    const root = s.byAttr('class', 'slide');
    expect(run(s, { kind: 'setAttr', id: root.id, name: 'class', value: 'other' }).live).toEqual([{ kind: 'reload' }]);
  });
});
