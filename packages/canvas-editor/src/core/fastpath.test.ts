import { describe, expect, it } from 'vitest';
import type { DocIndex, EditOp, EditResult, ElementInfo, Splice } from '../contracts';
import { EditError, applyOp, applySplicesToIndex } from './edits';
import { fastPathStats, patchAttributes, resetFastPathStats, tokenizeStartTag } from './fastpath';
import { assignIds } from './ids';
import { findByTag, parseIndex, parseRawIndex } from './source';
import { applySplices, composeSplices } from './splices';
import { DECK, DECK_CRLF, ODD_DOCUMENTS, makeCtx } from './test-fixtures';
import type { EditContext } from './edits';

/** Awkward documents aimed at the attribute-local fast path. */
const NASTY: Record<string, string> = {
  svgCase:
    '<div class="slide"><svg viewBox="0 0 10 10" preserveAspectRatio="none" width=10 data-layer-id="s"><linearGradient gradientUnits="userSpaceOnUse" id=g></linearGradient><circle cx=1 cy="2" r=2 style="fill:red"/><use xlink:href="#a" xml:lang=en /><foreignObject width=5><p style="color:red">x</p></foreignObject></svg></div>',
  mathml: '<math definitionURL="x" display=block><mi mathvariant=bold>x</mi><annotation-xml encoding="text/html"><div>y</div></annotation-xml></math>',
  htmlBody: '<!doctype html><html lang=en class=a><head></head><body class=b style="margin:0"><div>x</div></body></html>',
  strayBody: '<html a=1><body b=2 style="x:y"><p>x</p><body c=3 b=9><html d=4></body></html>',
  impliedAll: '<p style="a:b">a<p>b<ul><li>1<li>2</ul>',
  duplicates: '<div a=1 a=2 class="slide" A=3 b>x</div><p b="1" b="2" id=p>y</p>',
  unquoted: '<div class=slide data-x=1 hidden title=a/b>t</div><a href=x/>l</a><img src=a.png/><br/>',
  uppercase: '<DIV CLASS="Slide" ID=Y DATA-X="1" STYLE="COLOR:RED">t</DIV><SPAN Title=T>s</SPAN>',
  specials: '<div title="a>b" data-q=\'say "hi"\' data-e="&quot;q&quot; &amp; &#x41; &lt;b&gt;" style="background:url(a>b.png)">t</div><p title=\'it&#39;s\'>x</p>',
  crlf: '<div\r\n class="slide"\r\n data-a="line1\r\nline2"\r\n style="a:b;\r\n c:d">\r\n  <p\r\n id=x\r\n>x</p>\r\n</div>\r\n',
  selfClosing: '<div/><p style="a:b"/>after</p><svg><g/><rect width=1 /></svg><br style="a:b"/><hr>',
  rawText: '<style media=screen>a>b{}</style><script type=x>if (a<b) {}</script><textarea rows=2><b></textarea><title lang=x>t<b</title><p>z</p>',
  tableDoc: '<table class=t><tr><td colspan=2 style="a:b">a<td>b</table><select><option value=1>a<option>b</select>',
  hiddenInput: '<table><input type=hidden name=a><tr><td><input type="text"></td></tr></table><font color=red>f</font>',
  comments: '<!-- <div a=b> --><div id=a><!-- <p id=c> -->x</div><!-- end -->',
  templates: '<template id=t><div class="slide" style="a:b"><span>x</span></div></template><div id=r>real</div>',
  unclosed: '<div id=a><span style="a:b">never closed',
  nonAscii: '<p title="é" data-x="日本語 😀">日本語 😀 𝒳 <b style="a:b">x</b></p>',
  bom: '﻿<!doctype html><div id=a style="a:b">bom</div>',
  fontDeck: `<!doctype html><html><head><style>.slide{}</style><style data-popost-font="x">@font-face{src:url(data:font/woff2;base64,${'A'.repeat(500)})}</style></head><body><section class="slide" style="width:1px"><h1 data-layer-id="t">Hi</h1></section></body></html>`,
};

const DOCS: Record<string, string> = { ...ODD_DOCUMENTS, ...NASTY, deck: DECK, crlfDeck: DECK_CRLF };

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)];

const STYLE_PROPS = ['left', 'top', 'width', 'translate', 'color', 'background', 'font-size', 'opacity', 'background-image', 'Z-INDEX'];
const STYLE_VALUES: Array<string | null> = ['10px', 'red', null, 'url(a.png)', '1px 2px', 'calc(1px + 2px)', '', 'linear-gradient(red, blue)', '0'];
const ATTR_NAMES = ['class', 'id', 'title', 'data-x', 'viewBox', 'VIEWBOX', 'xlink:href', 'href', 'style', 'hidden', 'data-layer-id', 'CLASS', 'preserveAspectRatio', 'x', 'width', 'a', 'b'];
const ATTR_VALUES: Array<string | null> = [
  '', 'a', 'a>b', 'say "hi"', "it's", '&amp; <b>', 'line\nbreak', 'cr\r\nlf', '日本語 😀', ' sp ', null, 'a/b', 'x:y;z:w', '=', '/',
];

function randomOp(rand: () => number, index: DocIndex): EditOp | null {
  const candidates = index.order.filter((id) => {
    const el = index.elements.get(id)!;
    return el.startTagEnd !== el.start;
  });
  if (candidates.length === 0) return null;
  const id = pick(rand, candidates);
  if (rand() < 0.5) {
    const props: Record<string, string | null> = {};
    for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) props[pick(rand, STYLE_PROPS)] = pick(rand, STYLE_VALUES);
    return { kind: 'setStyle', id, props };
  }
  return { kind: 'setAttr', id, name: pick(rand, ATTR_NAMES), value: pick(rand, ATTR_VALUES) };
}

function snapshot(index: DocIndex): string {
  return JSON.stringify({ source: index.source, order: index.order, elements: [...index.elements.entries()], roles: [index.html, index.head, index.body] });
}

/** What the full path produces for the same splices (fresh ids are marked so a mismatch shows). */
function fullIndex(prev: DocIndex, splices: Splice[]): DocIndex {
  let n = 0;
  return assignIds(parseRawIndex(applySplices(prev.source, splices)), { index: prev, splices }, { newId: () => `ref${n++}` });
}

function expectSameIndex(actual: DocIndex, expected: DocIndex, label: string): void {
  expect(actual.source === expected.source, `${label}: source`).toBe(true);
  expect(actual.order, `${label}: order`).toEqual(expected.order);
  expect([actual.html, actual.head, actual.body], `${label}: roles`).toEqual([expected.html, expected.head, expected.body]);
  expect([...actual.elements.keys()], `${label}: ids`).toEqual([...expected.elements.keys()]);
  for (const [id, el] of expected.elements) expect(actual.elements.get(id), `${label}: ${id} <${el.tag}>`).toEqual(el);
}

interface Step {
  before: DocIndex;
  result: EditResult;
  fast: boolean;
}

/** Apply one op, remembering whether the fast path produced the index. */
function step(index: DocIndex, op: EditOp, ctx: EditContext): Step | null {
  const taken = fastPathStats.taken;
  try {
    const result = applyOp(index, op, ctx);
    return { before: index, result, fast: fastPathStats.taken > taken };
  } catch (e) {
    if (e instanceof EditError) return null;
    throw e;
  }
}

describe('fast path equivalence (seeded random ops)', () => {
  for (const [name, source] of Object.entries(DOCS)) {
    it(`${name}: ops, undo and redo match a full re-parse`, () => {
      const rand = mulberry32([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
      const ctx = makeCtx();
      let index = parseIndex(source, ctx);
      if (index.order.length === 0) return;
      const steps: Step[] = [];
      let fastCount = 0;

      for (let i = 0; i < 60; i++) {
        const op = randomOp(rand, index);
        if (!op) break;
        const frozen = snapshot(index);
        const s = step(index, op, ctx);
        expect(snapshot(index), `${name}#${i}: previous index mutated`).toBe(frozen);
        if (!s || s.result.splices.length === 0) continue;
        expectSameIndex(s.result.index, fullIndex(index, s.result.splices), `${name}#${i} ${JSON.stringify(op)}`);
        if (s.fast) fastCount++;
        steps.push(s);
        index = s.result.index;
      }

      // Undo everything (newest first), then redo everything.
      let cur = index;
      for (let i = steps.length - 1; i >= 0; i--) {
        const { before, result } = steps[i];
        const frozen = snapshot(cur);
        const undone = applySplicesToIndex(cur, result.inverse, ctx);
        expect(snapshot(cur)).toBe(frozen);
        expectSameIndex(undone.index, fullIndex(cur, result.inverse), `${name} undo ${i}`);
        expectSameIndex(undone.index, before, `${name} undo ${i} restores the previous index`);
        expect(undone.live).toEqual([{ kind: 'reload' }]);
        expect(undone.inverse).toEqual(result.splices);
        cur = undone.index;
      }
      for (let i = 0; i < steps.length; i++) {
        const { result } = steps[i];
        const redone = applySplicesToIndex(cur, result.splices, ctx);
        expectSameIndex(redone.index, fullIndex(cur, result.splices), `${name} redo ${i}`);
        expectSameIndex(redone.index, result.index, `${name} redo ${i} reproduces the edited index`);
        cur = redone.index;
      }
      if (/<(div|p|section|svg)\b/i.test(source) && !['hiddenInput', 'tableDoc', 'rawText'].includes(name)) {
        expect(fastCount, `${name}: fast path used`).toBeGreaterThan(0);
      }
    });
  }

  it('composed (coalesced) splices over one element and over several elements', () => {
    const rand = mulberry32(99);
    for (const source of [DECK, DECK_CRLF, NASTY.svgCase, NASTY.specials]) {
      const ctx = makeCtx();
      const base = parseIndex(source, ctx);
      for (let round = 0; round < 25; round++) {
        let index = base;
        let splices: Splice[] | null = null;
        let inverse: Splice[] = [];
        for (let i = 0; i < 4; i++) {
          const op = randomOp(rand, index);
          const s = op && step(index, op, ctx);
          if (!s || s.result.splices.length === 0) continue;
          splices = splices ? composeSplices(splices, s.result.splices) : s.result.splices;
          inverse = composeSplices(s.result.inverse, inverse);
          index = s.result.index;
        }
        if (!splices || splices.length === 0) continue;
        const redo = applySplicesToIndex(base, splices, ctx);
        expectSameIndex(redo.index, fullIndex(base, splices), 'composed redo');
        expectSameIndex(redo.index, index, 'composed redo vs sequential');
        const undo = applySplicesToIndex(index, inverse, ctx);
        expectSameIndex(undo.index, fullIndex(index, inverse), 'composed undo');
        expectSameIndex(undo.index, base, 'composed undo vs base');
      }
    }
  });
});

describe('fast path eligibility', () => {
  const setup = (source: string) => {
    const ctx = makeCtx();
    const index = parseIndex(source, ctx);
    const run = (op: EditOp): boolean => {
      resetFastPathStats();
      applyOp(index, op, ctx);
      return fastPathStats.taken === 1;
    };
    const tag = (name: string, nth = 0): ElementInfo => findByTag(index, name)[nth];
    return { index, run, tag };
  };

  it('takes ordinary setStyle / setAttr edits, including on <html> and <body>', () => {
    const s = setup(DECK);
    expect(s.run({ kind: 'setStyle', id: s.tag('h1').id, props: { left: '5px' } })).toBe(true);
    expect(s.run({ kind: 'setStyle', id: s.tag('body').id, props: { margin: '1px' } })).toBe(true);
    expect(s.run({ kind: 'setAttr', id: s.tag('html').id, name: 'lang', value: 'en' })).toBe(true);
    expect(s.run({ kind: 'setAttr', id: s.tag('img').id, name: 'alt', value: null })).toBe(true);
    expect(s.run({ kind: 'setStyle', id: s.tag('section').id, props: { color: 'red' } })).toBe(true);
  });

  it('keeps foreign-content attribute names (viewBox) and declines to re-case touched ones', () => {
    const s = setup(NASTY.svgCase);
    const svg = s.tag('svg');
    expect(svg.attrs.map((a) => a.name)).toContain('viewBox');
    expect(s.run({ kind: 'setStyle', id: svg.id, props: { left: '1px' } })).toBe(true);
    const next = applyOp(s.index, { kind: 'setStyle', id: svg.id, props: { left: '1px' } }, makeCtx(1000)).index;
    expect(next.elements.get(svg.id)!.attrs.map((a) => a.name)).toEqual(['viewBox', 'preserveAspectRatio', 'width', 'data-layer-id', 'style']);
    expect(s.run({ kind: 'setAttr', id: svg.id, name: 'viewBox', value: '0 0 1 1' })).toBe(false);
    expect(s.run({ kind: 'setAttr', id: svg.id, name: 'preserveAspectRatio', value: 'none' })).toBe(false);
    expect(s.run({ kind: 'setAttr', id: s.tag('use').id, name: 'xlink:href', value: '#b' })).toBe(false);
    expect(s.run({ kind: 'setAttr', id: s.tag('circle').id, name: 'fill', value: 'red' })).toBe(true);
    expect(s.run({ kind: 'setStyle', id: s.tag('circle').id, props: { fill: 'blue' } })).toBe(true);
  });

  it('declines for tags whose attributes can change the tree', () => {
    const s = setup(NASTY.hiddenInput);
    const hidden = s.tag('input');
    expect(s.run({ kind: 'setAttr', id: hidden.id, name: 'type', value: 'Hidden' })).toBe(false);
    // The full path still guards the structure: `type=text` would move the input out of the table's foster parenting.
    expect(() => s.run({ kind: 'setAttr', id: hidden.id, name: 'type', value: 'text' })).toThrow(EditError);
    expect(s.run({ kind: 'setAttr', id: s.tag('font').id, name: 'size', value: '3' })).toBe(false);
    expect(s.run({ kind: 'setAttr', id: s.tag('table').id, name: 'class', value: 'x' })).toBe(true);
  });

  it('declines for implied elements and no-op edits', () => {
    const s = setup('<p>a<p>b');
    expect(() => s.run({ kind: 'setAttr', id: s.index.body!, name: 'class', value: 'x' })).toThrow(EditError);
    expect(s.run({ kind: 'setAttr', id: s.tag('p').id, name: 'class', value: 'x' })).toBe(true);
    resetFastPathStats();
    applyOp(s.index, { kind: 'setStyle', id: s.tag('p').id, props: { left: null } }, makeCtx());
    expect(fastPathStats.taken + fastPathStats.declined).toBe(0);
  });

  it('keeps the first of duplicate attributes and handles unquoted / uppercase attributes', () => {
    const s = setup(NASTY.duplicates);
    const div = s.tag('div');
    expect(div.attrs.map((a) => `${a.name}=${a.value}`)).toEqual(['a=1', 'class=slide', 'b=']);
    expect(s.run({ kind: 'setAttr', id: div.id, name: 'a', value: '9' })).toBe(true);
    expect(s.run({ kind: 'setAttr', id: div.id, name: 'b', value: 'x' })).toBe(true);
    const u = setup(NASTY.uppercase);
    expect(u.run({ kind: 'setStyle', id: u.tag('div').id, props: { left: '1px' } })).toBe(true);
    expect(u.run({ kind: 'setAttr', id: u.tag('span').id, name: 'title', value: 'x' })).toBe(true);
  });

  it('handles `>` and quotes inside values and CRLF sources', () => {
    const s = setup(NASTY.specials);
    expect(s.run({ kind: 'setAttr', id: s.tag('div').id, name: 'title', value: 'x>y"z' })).toBe(true);
    expect(s.run({ kind: 'setStyle', id: s.tag('div').id, props: { color: 'red' } })).toBe(true);
    const c = setup(NASTY.crlf);
    expect(c.run({ kind: 'setAttr', id: c.tag('div').id, name: 'data-a', value: 'new\nvalue' })).toBe(true);
    expect(c.run({ kind: 'setStyle', id: c.tag('p').id, props: { left: '2px' } })).toBe(true);
  });

  it('refuses splices that are not strictly inside one start tag, or that change how the tag tokenises', () => {
    const ctx = makeCtx();
    const source = '<div id=a class="x">t</div><p title="y">z</p>';
    const index = parseIndex(source, ctx);
    const div = index.elements.get(index.order.find((id) => index.elements.get(id)!.tag === 'div')!)!;
    const apply = (splices: Splice[]): DocIndex | null => patchAttributes(index, splices, applySplices(source, splices));
    const at = (needle: string): number => source.indexOf(needle);

    expect(apply([{ start: at('x"'), end: at('x"') + 1, text: 'abc' }])).not.toBeNull();
    // Touching the tag name, the closing `>`, the content or two different regions.
    expect(apply([{ start: 1, end: 4, text: 'span' }])).toBeNull();
    expect(apply([{ start: div.startTagEnd - 1, end: div.startTagEnd, text: ' z>' }])).toBeNull();
    expect(apply([{ start: div.startTagEnd, end: div.startTagEnd, text: 'new' }])).toBeNull();
    // Ends the tag early, opens an unterminated quote, or starts a second tag.
    expect(apply([{ start: at(' class'), end: at(' class'), text: '><b' }])).toBeNull();
    expect(apply([{ start: at('x"'), end: at('x"') + 2, text: 'x' }])).toBeNull();
    expect(apply([{ start: at('"x"') + 1, end: at('"x"') + 1, text: '"><p a="' }])).toBeNull();
    // Turns the tag into a self-closing one.
    expect(apply([{ start: div.startTagEnd - 1, end: div.startTagEnd - 1, text: '/' }])).toBeNull();
    // Nothing to do.
    expect(patchAttributes(index, [], source)).toBeNull();
  });
});

describe('tokenizeStartTag', () => {
  it('accepts exactly one complete start tag', () => {
    const tag = tokenizeStartTag('<DIV A=1 b="2" c>')!;
    expect(tag.name).toBe('div');
    expect(tag.attrs.map((a) => [a.name, a.value, a.start, a.end])).toEqual([['a', '1', 5, 8], ['b', '2', 9, 14], ['c', '', 15, 16]]);
    expect(tokenizeStartTag('<br/>')!.selfClosing).toBe(true);
    for (const bad of ['', 'x', '<div', '<div a="b>', '<div>x', '<div></div>', '<div><p>', '</div>', '<!-- c -->', ' <div>', '<div> ']) {
      expect(tokenizeStartTag(bad), bad).toBeNull();
    }
  });
});
