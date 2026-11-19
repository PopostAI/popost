import { describe, expect, it } from 'vitest';
import type { DocIndex, Splice } from '../contracts';
import { assignIds, createIdSource, isImplied, mapOffset, mapStart, matchElements, sessionIds } from './ids';
import type { Relocation } from './ids';
import { findByTag, getAttr, parseIndex, parseRawIndex } from './source';
import { applySplices } from './splices';
import { DECK, session } from './test-fixtures';

function reparse(prev: DocIndex, splices: Splice[], ids = createIdSource(1000), moved?: Relocation[]): DocIndex {
  const source = applySplices(prev.source, splices);
  return assignIds(parseRawIndex(source), { index: prev, splices, moved }, ids);
}

describe('id sources', () => {
  it('hands out n<counter> ids, monotonic per source', () => {
    const a = createIdSource();
    expect([a.newId(), a.newId(), a.newId()]).toEqual(['n1', 'n2', 'n3']);
    expect(createIdSource(10).newId()).toBe('n10');
    const before = sessionIds.newId();
    expect(sessionIds.newId()).not.toBe(before);
  });

  it('numbers a fresh parse in document order', () => {
    const idx = parseIndex('<div><p>a</p><p>b</p></div>', createIdSource());
    expect(idx.order).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(idx.elements.get('n4')!.tag).toBe('div');
    expect(idx.elements.get('n4')!.children).toEqual(['n5', 'n6']);
    expect(idx.elements.get('n5')!.parent).toBe('n4');
    expect([idx.html, idx.head, idx.body]).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('assignIds', () => {
  const src = '<div id="a"><p>one</p><p>two</p></div>\n<span>tail</span>';

  it('keeps ids of elements after an insertion (positions shift)', () => {
    const idx = parseIndex(src, createIdSource());
    const span = findByTag(idx, 'span')[0];
    const next = reparse(idx, [{ start: 0, end: 0, text: '<hr>' }]);
    expect(findByTag(next, 'span')[0].id).toBe(span.id);
    expect(findByTag(next, 'hr')[0].id).not.toBe(span.id);
    for (const el of findByTag(idx, 'p')) expect(next.elements.get(el.id)!.tag).toBe('p');
  });

  it('keeps ids when only an attribute inside a start tag changes', () => {
    const idx = parseIndex(src, createIdSource());
    const div = findByTag(idx, 'div')[0];
    const at = div.attrs[0];
    const next = reparse(idx, [{ start: at.start, end: at.end, text: 'id="a" class="long-new-class"' }]);
    expect(next.elements.get(div.id)!.tag).toBe('div');
    expect(next.order.filter((id) => idx.elements.has(id))).toEqual(idx.order);
    expect(next.order).toEqual(idx.order);
  });

  it('gives new ids to elements inside a replaced range, keeps the container and siblings', () => {
    const idx = parseIndex(src, createIdSource());
    const div = findByTag(idx, 'div')[0];
    const [p1, p2] = findByTag(idx, 'p');
    const span = findByTag(idx, 'span')[0];
    const next = reparse(idx, [{ start: div.startTagEnd, end: div.endTagStart!, text: '<p>new</p>' }]);
    expect(next.elements.has(div.id)).toBe(true);
    expect(next.elements.has(span.id)).toBe(true);
    expect(next.elements.has(p1.id)).toBe(false);
    expect(next.elements.has(p2.id)).toBe(false);
    expect(next.elements.get(next.elements.get(div.id)!.children[0])!.tag).toBe('p');
  });

  it('does not reuse a replaced element id for a new element with the same tag at the same offset', () => {
    const idx = parseIndex('<b>x</b>', createIdSource());
    const b = findByTag(idx, 'b')[0];
    const next = reparse(idx, [{ start: b.start, end: b.end, text: '<b>y</b>' }]);
    expect(findByTag(next, 'b')[0].id).not.toBe(b.id);
  });

  it('gives a new id when the tag at the mapped start differs', () => {
    const idx = parseIndex('<div>x</div>', createIdSource());
    const div = findByTag(idx, 'div')[0];
    const next = reparse(idx, [
      { start: div.start + 1, end: div.start + 4, text: 'section' },
      { start: div.endTagStart! + 2, end: div.endTagStart! + 5, text: 'section' },
    ]);
    expect(findByTag(next, 'section')[0].id).not.toBe(div.id);
  });

  it('never reuses ids across a session (counter is monotonic)', () => {
    const s = session('<p>a</p><p>b</p>');
    const seen = new Set(s.index.order);
    const p = s.byTag('p', 0);
    s.apply({ kind: 'remove', id: p.id });
    s.apply({ kind: 'insertHTML', parentId: s.index.body!, beforeId: null, html: '<p>c</p>' });
    const created = s.byTag('p', 1);
    expect(seen.has(created.id)).toBe(false);
    expect(s.index.elements.has(p.id)).toBe(false);
  });

  it('keeps html/head/body identity even when they are implied', () => {
    const idx = parseIndex('<div>a</div>', createIdSource());
    const next = reparse(idx, [{ start: 0, end: 0, text: '<style>x{}</style>' }]);
    expect([next.html, next.head, next.body]).toEqual([idx.html, idx.head, idx.body]);
  });

  it('carries ids through a relocation (moved elements)', () => {
    const idx = parseIndex('<p id="a"><b>x</b></p><p id="b">y</p>', createIdSource());
    const [a, b] = findByTag(idx, 'p');
    const text = idx.source.slice(a.start, a.end);
    const splices: Splice[] = [
      { start: a.start, end: a.end, text: '' },
      { start: b.end, end: b.end, text },
    ];
    const moved = [{ from: a.start, to: b.end - (a.end - a.start), length: a.end - a.start }];
    const next = reparse(idx, splices, createIdSource(1000), moved);
    const ps = findByTag(next, 'p');
    expect(ps.map((p) => getAttr(p, 'id'))).toEqual(['b', 'a']);
    expect(ps[1].id).toBe(a.id);
    expect(findByTag(next, 'b')[0].id).toBe(findByTag(idx, 'b')[0].id);
    expect(ps[0].id).toBe(b.id);
  });

  it('detects id collisions with the supplied id source', () => {
    const idx = parseIndex('<p>a</p>', createIdSource());
    expect(() => reparse(idx, [{ start: 0, end: 0, text: '<i></i>' }], createIdSource(1))).toThrow(/collision/);
  });
});

describe('matching helpers', () => {
  it('mapStart returns null inside replaced ranges and honours relocations', () => {
    const splices = [{ start: 5, end: 9, text: 'x' }];
    expect(mapStart({ splices }, 4)).toBe(4);
    expect(mapStart({ splices }, 5)).toBeNull();
    expect(mapStart({ splices }, 8)).toBeNull();
    expect(mapStart({ splices }, 9)).toBe(6);
    expect(mapStart({ splices, moved: [{ from: 5, to: 20, length: 4 }] }, 7)).toBe(22);
  });

  it('exports mapOffset', () => {
    expect(mapOffset([{ start: 0, end: 0, text: 'ab' }], 3, 1)).toBe(5);
  });

  it('flags implied structural elements', () => {
    const idx = parseIndex('<p>x</p>', createIdSource());
    expect(isImplied(idx.elements.get(idx.body!)!)).toBe(true);
    expect(isImplied(findByTag(idx, 'p')[0])).toBe(false);
  });

  it('matchElements pairs unchanged documents one to one', () => {
    const idx = parseIndex(DECK, createIdSource());
    const pairs = matchElements(parseRawIndex(DECK), { index: idx, splices: [] });
    expect(pairs.size).toBe(idx.order.length);
  });
});
