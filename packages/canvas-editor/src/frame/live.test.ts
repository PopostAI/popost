import { beforeEach, describe, expect, it } from 'vitest';
import { applyLiveUpdates } from './live';
import { applyMarks } from './marks';
import { el, resetDoc, startSession } from './test-dom';

beforeEach(() => resetDoc());

describe('applyLiveUpdates', () => {
  it('sets and removes style properties', () => {
    applyLiveUpdates(document, [{ kind: 'style', id: 'n7', props: { color: 'red', 'font-size': '20px' } }]);
    expect(el('n7').style.color).toBe('red');
    expect(el('n7').style.getPropertyValue('font-size')).toBe('20px');
    applyLiveUpdates(document, [{ kind: 'style', id: 'n7', props: { color: null } }]);
    expect(el('n7').style.color).toBe('');
    expect(el('n7').style.getPropertyValue('font-size')).toBe('20px');
  });

  it('sets and removes attributes but never touches data-pp-* or handlers', () => {
    applyLiveUpdates(document, [
      { kind: 'attr', id: 'n7', name: 'title', value: 'hi' },
      { kind: 'attr', id: 'n7', name: 'data-pp-id', value: 'evil' },
      { kind: 'attr', id: 'n7', name: 'onclick', value: 'alert(1)' },
      { kind: 'attr', id: 'n7', name: 'href', value: 'javascript:alert(1)' },
    ]);
    expect(el('n7').getAttribute('title')).toBe('hi');
    expect(el('n7').getAttribute('data-pp-id')).toBe('n7');
    expect(el('n7').hasAttribute('onclick')).toBe(false);
    expect(el('n7').hasAttribute('href')).toBe(false);
    applyLiveUpdates(document, [{ kind: 'attr', id: 'n7', name: 'title', value: null }]);
    expect(el('n7').hasAttribute('title')).toBe(false);
  });

  // happy-dom ignores the parse context, so check which context is requested (namespaces: see the Chrome harness).
  function contexts(run: () => void): Node[] {
    const seen: Node[] = [];
    const proto = Range.prototype;
    const original = proto.createContextualFragment;
    proto.createContextualFragment = function (this: Range, html: string) {
      seen.push(this.startContainer);
      return original.call(this, html);
    };
    try {
      run();
    } finally {
      proto.createContextualFragment = original;
    }
    return seen;
  }

  it('replaces subtrees using the parent as parse context (SVG stays SVG)', () => {
    const seen = contexts(() =>
      applyLiveUpdates(document, [
        { kind: 'subtrees', items: [{ id: 'n9', previewHTML: '<g data-pp-id="n9"><rect data-pp-id="n20"></rect></g>' }] },
      ]),
    );
    expect(seen).toEqual([el('n8')]);
    expect(el('n10')).toBeNull();
    expect(el('n20').parentElement).toBe(el('n9'));
    expect(el('n9').parentElement).toBe(el('n8'));
  });

  it('replaces HTML subtrees', () => {
    applyLiveUpdates(document, [{ kind: 'subtrees', items: [{ id: 'n7', previewHTML: '<p data-pp-id="n7">New</p>' }] }]);
    expect(el('n7').textContent).toBe('New');
  });

  it('inserts before a sibling or appends', () => {
    applyLiveUpdates(document, [
      { kind: 'insert', parentId: 'n4', beforeId: 'n7', previewHTML: '<h2 data-pp-id="n30">A</h2>' },
      { kind: 'insert', parentId: 'n4', beforeId: null, previewHTML: '<h2 data-pp-id="n31">B</h2>' },
    ]);
    expect(el('n30').nextElementSibling).toBe(el('n7'));
    expect(el('n4').lastElementChild).toBe(el('n31'));
  });

  it('inserts using the parent as parse context', () => {
    const seen = contexts(() =>
      applyLiveUpdates(document, [
        { kind: 'insert', parentId: 'n9', beforeId: 'n10', previewHTML: '<path data-pp-id="n40" d="M0 0"></path>' },
      ]),
    );
    expect(seen).toEqual([el('n9')]);
    expect(el('n40').nextElementSibling).toBe(el('n10'));
  });

  it('moves and removes', () => {
    applyLiveUpdates(document, [{ kind: 'move', id: 'n7', parentId: 'n11', beforeId: 'n12' }]);
    expect(el('n7').parentElement).toBe(el('n11'));
    expect(el('n7').nextElementSibling).toBe(el('n12'));
    applyLiveUpdates(document, [{ kind: 'move', id: 'n4', parentId: 'n5', beforeId: null }]); // cycle: ignored
    expect(el('n4').parentElement).toBe(document.body);
    applyLiveUpdates(document, [{ kind: 'remove', id: 'n7' }]);
    expect(el('n7')).toBeNull();
  });

  it('upserts head font styles by key', () => {
    applyLiveUpdates(document, [{ kind: 'headStyle', key: 'brand', css: '@font-face{a:1}' }]);
    applyLiveUpdates(document, [{ kind: 'headStyle', key: 'other', css: 'x' }]);
    applyLiveUpdates(document, [{ kind: 'headStyle', key: 'brand', css: '@font-face{a:2}' }]);
    const styles = document.head.querySelectorAll('style[data-popost-font]');
    expect(styles).toHaveLength(2);
    expect(document.head.querySelector('style[data-popost-font="brand"]')!.textContent).toBe('@font-face{a:2}');
  });

  it('ignores reload and unknown ids', () => {
    expect(() =>
      applyLiveUpdates(document, [{ kind: 'reload' }, { kind: 'remove', id: 'nope' }, { kind: 'style', id: 'nope', props: { a: 'b' } }]),
    ).not.toThrow();
  });
});

describe('session.send live', () => {
  it('re-applies page marks, current class and highlight after updates', () => {
    const h = startSession();
    h.session.send({ type: 'highlight', ids: ['n7'] });
    expect(el('n7').hasAttribute('data-pp-hl')).toBe(true);
    h.session.send({
      type: 'live',
      updates: [
        { kind: 'subtrees', items: [{ id: 'n4', previewHTML: '<section class="slide" data-pp-id="n4"><p data-pp-id="n7" data-pp-sel="text">x</p></section>' }] },
        { kind: 'attr', id: 'n11', name: 'class', value: 'slide other' },
      ],
    });
    expect(el('n4').classList.contains('ed-cur')).toBe(true);
    expect(el('n4').hasAttribute('data-pp-root')).toBe(true);
    expect(el('n11').classList.contains('ed-cur')).toBe(false);
    expect(el('n11').hasAttribute('data-pp-root')).toBe(true);
    expect(el('n7').hasAttribute('data-pp-hl')).toBe(true);
    h.session.send({ type: 'highlight', ids: [] });
    expect(document.querySelector('[data-pp-hl]')).toBeNull();
    h.session.dispose();
  });

  it('marks pages inserted by a live update', () => {
    const h = startSession();
    h.session.send({
      type: 'live',
      updates: [{ kind: 'insert', parentId: 'n3', beforeId: null, previewHTML: '<section class="slide" data-pp-id="n50"></section>' }],
    });
    expect(el('n50').hasAttribute('data-pp-root')).toBe(true);
    h.session.dispose();
  });

  it('switches the current page', () => {
    const h = startSession();
    h.session.send({ type: 'currentPage', id: 'n11' });
    expect(el('n11').classList.contains('ed-cur')).toBe(true);
    expect(el('n4').classList.contains('ed-cur')).toBe(false);
    expect(h.of('rects').length).toBe(1);
    expect(Object.keys(h.of('rects')[0].rects)).toEqual(['n12']);
    h.session.dispose();
  });
});

describe('applyMarks', () => {
  it('is idempotent', () => {
    const state = { doc: document, pageIds: ['n4', 'n11'], currentId: 'n4', highlightIds: [] };
    applyMarks(state);
    applyMarks(state);
    expect(el('n4').className).toBe('slide ed-cur');
  });
});
