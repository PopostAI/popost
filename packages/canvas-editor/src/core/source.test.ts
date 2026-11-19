import { describe, expect, it } from 'vitest';
import type { DocIndex, ElementInfo } from '../contracts';
import { createIdSource } from './ids';
import {
  attrInsertPos,
  attrValueRange,
  detectEol,
  escapeAttrValue,
  findAttr,
  findByAttr,
  findByClass,
  findByTag,
  getAttr,
  innerSource,
  isAncestor,
  iterElements,
  leadingIndent,
  outerSource,
  parseIndex,
  textContent,
} from './source';
import { DECK, DECK_CRLF, ODD_DOCUMENTS } from './test-fixtures';

const parse = (source: string): DocIndex => parseIndex(source, createIdSource());
const tags = (index: DocIndex): string[] => [...iterElements(index)].map((e) => e.tag);
const one = (index: DocIndex, tag: string, nth = 0): ElementInfo => findByTag(index, tag)[nth];

describe('parseIndex: structure', () => {
  it('indexes every element with ranges, attrs, parents and children', () => {
    const src = '<!doctype html><html><head><title>t</title></head><body><div id="a" class="x y">hi<br></div></body></html>';
    const idx = parse(src);
    expect(tags(idx)).toEqual(['html', 'head', 'title', 'body', 'div', 'br']);
    const div = one(idx, 'div');
    expect(src.slice(div.start, div.end)).toBe('<div id="a" class="x y">hi<br></div>');
    expect(src.slice(div.startTagEnd - 1, div.startTagEnd)).toBe('>');
    expect(src.slice(div.endTagStart!, div.end)).toBe('</div>');
    expect(div.attrs.map((a) => [a.name, a.value, src.slice(a.start, a.end)])).toEqual([
      ['id', 'a', 'id="a"'],
      ['class', 'x y', 'class="x y"'],
    ]);
    expect(idx.elements.get(div.parent!)!.tag).toBe('body');
    expect(div.children.map((c) => idx.elements.get(c)!.tag)).toEqual(['br']);
    expect(idx.elements.get(idx.html!)!.tag).toBe('html');
    expect(idx.elements.get(idx.head!)!.tag).toBe('head');
    expect(idx.elements.get(idx.body!)!.tag).toBe('body');
  });

  it('handles void elements', () => {
    const idx = parse('<p>a<br>b<img src=x></p>');
    const br = one(idx, 'br');
    expect(br.endTagStart).toBeNull();
    expect(br.end).toBe(br.startTagEnd);
    expect(outerSource(idx, one(idx, 'img'))).toBe('<img src=x>');
  });

  it('handles self-closing SVG children and the xlink prefix', () => {
    const idx = parse(ODD_DOCUMENTS.svgSelfClosing);
    const rect = one(idx, 'rect');
    expect(outerSource(idx, rect)).toBe('<rect width="1" height="1"/>');
    expect(rect.endTagStart).toBeNull();
    const use = one(idx, 'use');
    expect(use.attrs[0].name).toBe('xlink:href');
    expect(idx.source.slice(use.attrs[0].start, use.attrs[0].end)).toBe('xlink:href="#a"');
    expect(one(idx, 'circle').parent).toBe(one(idx, 'g').id);
  });

  it('keeps raw-text content opaque', () => {
    const idx = parse(ODD_DOCUMENTS.rawText);
    expect(tags(idx).filter((t) => !['html', 'head', 'body'].includes(t))).toEqual(['script', 'style', 'textarea', 'title']);
    expect(innerSource(idx, one(idx, 'script'))).toContain('document.write("</div>")');
    expect(innerSource(idx, one(idx, 'textarea'))).toBe('<b>');
  });

  it('indexes template content under the template element', () => {
    const idx = parse(ODD_DOCUMENTS.template);
    const tpl = one(idx, 'template');
    const inner = idx.elements.get(tpl.children[0])!;
    expect(inner.tag).toBe('div');
    expect(inner.parent).toBe(tpl.id);
    expect(outerSource(idx, inner)).toBe('<div class="slide"><span>x</span></div>');
  });

  it('parses noscript content as elements (scripting disabled, like DOMParser)', () => {
    const idx = parse(ODD_DOCUMENTS.noscript);
    expect(tags(idx)).toContain('p');
  });

  it('skips elements the parser invents without source (tbody, adoption-agency clones)', () => {
    const idx = parse(ODD_DOCUMENTS.table);
    expect(tags(idx).filter((t) => t !== 'html' && t !== 'head' && t !== 'body')).toEqual(['table', 'tr', 'td', 'td']);
    expect(idx.elements.get(one(idx, 'tr').parent!)!.tag).toBe('table');
    const mis = parse(ODD_DOCUMENTS.misnested);
    expect(findByTag(mis, 'b')).toHaveLength(1);
  });

  it('handles implicitly closed elements', () => {
    const idx = parse('<p>a<p>b');
    const [p1, p2] = findByTag(idx, 'p');
    expect(p1.endTagStart).toBeNull();
    expect(p1.end).toBe(p2.start);
    expect(p2.end).toBe(8);
  });

  it('records attribute oddities: unquoted, single quotes, duplicates, entities', () => {
    const un = parse(ODD_DOCUMENTS.unquoted);
    const d = one(un, 'div');
    expect(d.attrs.map((a) => a.name)).toEqual(['class', 'data-x', 'hidden']);
    expect(getAttr(d, 'hidden')).toBe('');
    const dup = parse(ODD_DOCUMENTS.duplicateAttrs);
    expect(one(dup, 'div').attrs.map((a) => [a.name, a.value])).toEqual([['a', '1'], ['class', 'slide']]);
    const ent = parse(ODD_DOCUMENTS.entitiesInAttrs);
    expect(getAttr(one(ent, 'div'), 'title')).toBe('"q" & A');
  });

  it('uses JS string offsets for non-ASCII text and CRLF', () => {
    const src = ODD_DOCUMENTS.nonAscii;
    const idx = parse(src);
    const b = one(idx, 'b');
    expect(outerSource(idx, b)).toBe('<b>x</b>');
    const crlf = parse(ODD_DOCUMENTS.crlfAttrs);
    const div = one(crlf, 'div');
    expect(div.attrs.map((a) => crlf.source.slice(a.start, a.end))).toEqual(['class="slide"', 'data-a="1"']);
    expect(outerSource(crlf, one(crlf, 'p'))).toBe('<p>x</p>');
    expect(DECK_CRLF.length).toBeGreaterThan(DECK.length);
  });
});

describe('parseIndex: implied html/head/body', () => {
  it('gives implied elements zero-length start tags at insertion points', () => {
    const src = '<!doctype html>\n<style>a{}</style>\n<div>x</div>\n';
    const idx = parse(src);
    const html = idx.elements.get(idx.html!)!;
    const head = idx.elements.get(idx.head!)!;
    const body = idx.elements.get(idx.body!)!;
    expect(html.start).toBe(src.indexOf('\n'));
    expect(html.startTagEnd).toBe(html.start);
    expect(html.end).toBe(src.length);
    expect(head.start).toBe(html.start);
    expect(head.end).toBe(src.indexOf('</style>') + '</style>'.length);
    expect(body.start).toBe(head.end);
    expect(body.startTagEnd).toBe(body.start);
    expect(body.end).toBe(src.length);
    expect(body.endTagStart).toBeNull();
    expect(head.children).toHaveLength(1);
    expect(body.children).toHaveLength(1);
  });

  it('handles explicit html with implied head and body', () => {
    const src = '<html lang=en><div>x</div></html>';
    const idx = parse(src);
    const html = idx.elements.get(idx.html!)!;
    const head = idx.elements.get(idx.head!)!;
    const body = idx.elements.get(idx.body!)!;
    expect(head.start).toBe(html.startTagEnd);
    expect(head.end).toBe(head.start);
    expect(body.start).toBe(html.startTagEnd);
    expect(body.end).toBe(html.endTagStart);
  });

  it('handles an empty document', () => {
    const idx = parse('');
    expect(idx.order).toHaveLength(3);
    for (const id of [idx.html!, idx.head!, idx.body!]) {
      const el = idx.elements.get(id)!;
      expect([el.start, el.end]).toEqual([0, 0]);
    }
  });

  it('uses the explicit ranges when the tags exist', () => {
    const src = '<html><head><title>t</title></head><body class="a"><p>x</p></body></html>';
    const idx = parse(src);
    const body = idx.elements.get(idx.body!)!;
    expect(src.slice(body.start, body.startTagEnd)).toBe('<body class="a">');
    expect(src.slice(body.endTagStart!, body.end)).toBe('</body>');
  });
});

describe('parseIndex: invariants on varied documents', () => {
  for (const [name, source] of Object.entries(ODD_DOCUMENTS)) {
    it(`round-trips and has consistent ranges: ${name}`, () => {
      const idx = parse(source);
      expect(idx.source).toBe(source);
      expect(new Set(idx.order).size).toBe(idx.order.length);
      for (const el of iterElements(idx)) {
        expect(el.start).toBeGreaterThanOrEqual(0);
        expect(el.end).toBeLessThanOrEqual(source.length);
        expect(el.start <= el.startTagEnd && el.startTagEnd <= el.end).toBe(true);
        if (el.endTagStart !== null) expect(el.endTagStart >= el.startTagEnd && el.endTagStart <= el.end).toBe(true);
        if (el.startTagEnd !== el.start) {
          expect(source[el.start]).toBe('<');
          expect(source.slice(el.start + 1, el.start + 1 + el.tag.length).toLowerCase()).toBe(el.tag.toLowerCase());
          expect(source[el.startTagEnd - 1]).toBe('>');
          for (const a of el.attrs) expect(a.start >= el.start && a.end < el.startTagEnd).toBe(true);
        }
        if (el.parent !== null) expect(idx.elements.get(el.parent)!.children).toContain(el.id);
        for (const c of el.children) expect(idx.elements.get(c)!.parent).toBe(el.id);
      }
    });
  }

  it('parses the realistic deck', () => {
    const idx = parse(DECK);
    const slides = findByClass(idx, 'slide');
    expect(slides).toHaveLength(2);
    expect(findByAttr(idx, 'data-layer-id').map((e) => getAttr(e, 'data-layer-id'))).toEqual(['bg', 'title', 'sub', 'logo', 'mark', 'card']);
    expect(findByTag(idx, 'style')).toHaveLength(2);
    expect(getAttr(findByTag(idx, 'svg')[0], 'viewBox')).toBe('0 0 80 80');
  });
});

describe('lookup helpers', () => {
  const idx = parse(DECK);
  it('finds by tag, class and attribute', () => {
    expect(findByTag(idx, 'SECTION')).toHaveLength(2);
    expect(findByClass(idx, 'title')).toHaveLength(1);
    expect(findByAttr(idx, 'data-popost-page', 'p-bbbbbbbbbbbb')).toHaveLength(1);
    expect(findByAttr(idx, 'data-slot').length).toBe(3);
  });
  it('reads attributes case-insensitively', () => {
    const svg = findByTag(idx, 'svg')[0];
    expect(findAttr(svg, 'viewbox')?.value).toBe('0 0 80 80');
    expect(getAttr(svg, 'nope')).toBeNull();
  });
  it('answers ancestry questions', () => {
    const slide = findByClass(idx, 'slide')[0];
    const h1 = findByTag(idx, 'h1')[0];
    expect(isAncestor(idx, slide.id, h1.id)).toBe(true);
    expect(isAncestor(idx, h1.id, slide.id)).toBe(false);
    expect(isAncestor(idx, h1.id, h1.id)).toBe(false);
  });
  it('returns text content with entities decoded and comments dropped', () => {
    const h1 = findByTag(idx, 'h1')[0];
    expect(textContent(idx, h1.id)).toBe('春季发布 Spring & Launch');
    const p = findByTag(idx, 'p')[0];
    expect(textContent(idx, p.id)).toBe('Line oneLine two');
    const t = parse('<style>a>b{}</style><p>a<!-- c -->b<template>x</template></p>');
    expect(textContent(t, findByTag(t, 'style')[0].id)).toBe('a>b{}');
    expect(textContent(t, findByTag(t, 'p')[0].id)).toBe('ab');
    expect(textContent(t, 'missing')).toBe('');
  });
});

describe('attribute and whitespace helpers', () => {
  it('locates attribute values', () => {
    const src = `<a href="x&amp;y" b='1' c=2 d e = "5">`;
    const idx = parse(src);
    const a = one(idx, 'a');
    const ranges = a.attrs.map((at) => {
      const r = attrValueRange(src, at);
      return [at.name, src.slice(r.start, r.end), r.quote, r.hasValue];
    });
    expect(ranges).toEqual([
      ['href', 'x&amp;y', '"', true],
      ['b', '1', "'", true],
      ['c', '2', null, true],
      ['d', '', null, false],
      ['e', '5', '"', true],
    ]);
  });
  it('escapes attribute values for the chosen quote', () => {
    expect(escapeAttrValue('a"b&c')).toBe('a&quot;b&amp;c');
    expect(escapeAttrValue(`a'b"c`, "'")).toBe('a&#39;b"c');
  });
  it('finds where new attributes go', () => {
    const cases: Array<[string, string]> = [
      ['<div class="a">x</div>', '<div class="a"|>x</div>'],
      ['<br/>', '<br|/>'],
      ['<br />', '<br| />'],
      ['<img src=a/>', '<img src=a/|>'],
      ['<p>x</p>', '<p|>x</p>'],
    ];
    for (const [src, expected] of cases) {
      const idx = parse(src);
      const el = findByTag(idx, src.slice(1).split(/[ />]/)[0])[0];
      const at = attrInsertPos(el);
      expect(`${src.slice(0, at)}|${src.slice(at)}`).toBe(expected);
    }
  });
  it('detects indentation and line endings', () => {
    expect(leadingIndent('a\n  <b>', 4)).toBe('  ');
    expect(leadingIndent('a <b>', 2)).toBeNull();
    expect(leadingIndent('<b>', 0)).toBe('');
    expect(detectEol('a\r\nb\n')).toBe('\r\n');
    expect(detectEol('a\nb\r\n')).toBe('\n');
    expect(detectEol('single')).toBe('\n');
  });
});
