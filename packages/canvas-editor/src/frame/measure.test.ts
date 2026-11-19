import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alignPage } from './align';
import { isOverflowing, measure, computedStyles } from './measure';
import { el, resetDoc, startSession } from './test-dom';

const rect = (x: number, y: number, w: number, h: number) =>
  ({ left: x, top: y, right: x + w, bottom: y + h, x, y, width: w, height: h, toJSON() {} }) as DOMRect;
const stub = (id: string, r: DOMRect, sizes?: { sh?: number; ch?: number; sw?: number; cw?: number }) => {
  el(id).getBoundingClientRect = () => r;
  const def = (k: string, v: number) => Object.defineProperty(el(id), k, { value: v, configurable: true });
  if (sizes) {
    def('scrollHeight', sizes.sh ?? 0);
    def('clientHeight', sizes.ch ?? 0);
    def('scrollWidth', sizes.sw ?? 0);
    def('clientWidth', sizes.cw ?? 0);
  }
};
const state = { doc: document, pageIds: ['n4', 'n11'], currentId: 'n4' as string | null, highlightIds: [] };

beforeEach(() => {
  resetDoc();
  state.currentId = 'n4';
  stub('n4', rect(100, 40, 1080, 1440));
});

describe('measure', () => {
  it('reports rects relative to the page root for every selectable block', () => {
    stub('n5', rect(180, 140, 500, 80));
    stub('n7', rect(100.004, 300, 200, 50));
    const m = measure(state, 'page');
    expect(Object.keys(m.rects).sort()).toEqual(['n5', 'n7', 'n8']);
    expect(m.rects.n5).toEqual({ x: 80, y: 100, width: 500, height: 80 });
    expect(m.rects.n7.x).toBe(0);
    expect(m.overflow).toEqual([]);
  });

  it('measures only requested ids, skipping unknown ones', () => {
    stub('n5', rect(180, 140, 500, 80));
    const m = measure(state, ['n5', 'nope', 'n14']);
    expect(Object.keys(m.rects).sort()).toEqual(['n14', 'n5']);
  });

  it('flags text blocks whose scroll size exceeds the client size by more than 1px', () => {
    stub('n5', rect(180, 140, 500, 80), { sh: 100, ch: 80 });
    stub('n7', rect(180, 300, 500, 80), { sh: 81, ch: 80 });
    expect(measure(state, 'page').overflow).toEqual(['n5']);
  });

  it('flags text blocks sticking out of the page, but not other kinds', () => {
    stub('n5', rect(100 + 1000, 140, 200, 80)); // right edge 1100 > 1080 + 1
    stub('n7', rect(100, 40 + 1440 + 0.5, 100, 10)); // within tolerance at x, 10 over at bottom
    stub('n8', rect(100 - 50, 40, 10, 10)); // svg outside: not text
    expect(measure(state, 'page').overflow).toEqual(['n5', 'n7']);
  });

  it('returns nothing when there is no current page', () => {
    state.currentId = null;
    expect(measure(state, 'page')).toEqual({ rects: {}, overflow: [] });
  });

  it('isOverflowing tolerates 1px', () => {
    const page = { width: 100, height: 100 };
    const box = { x: -1, y: 0, width: 101, height: 100 };
    expect(isOverflowing(document.createElement('p'), box, page)).toBe(false);
    expect(isOverflowing(document.createElement('p'), { ...box, x: -1.5 }, page)).toBe(true);
  });
});

describe('styles', () => {
  it('returns computed values; missing element gives {}', () => {
    el('n7').style.color = 'red';
    expect(computedStyles(state, 'n7', ['color'])).toHaveProperty('color');
    expect(computedStyles(state, 'nope', ['color'])).toEqual({});
  });

  it('is exposed through the session', () => {
    const h = startSession();
    expect(h.session.styles('nope', ['color'])).toEqual({});
    expect(Object.keys(h.session.measure([ 'n7' ]).rects)).toEqual(['n7']);
    h.session.dispose();
  });
});

describe('alignPage', () => {
  it('translates <html> so the root sits at (0,0) and removes it when already aligned', () => {
    const root = el('n4');
    // Simulated layout: the root is centred at (100, 40) unless html is translated.
    root.getBoundingClientRect = () => {
      const t = document.documentElement.style.getPropertyValue('translate');
      const [tx, ty] = t ? t.split(' ').map(parseFloat) : [0, 0];
      return rect(100 + tx, 40 + ty, 1080, 1440);
    };
    expect(alignPage(document, root)).toEqual({ x: -100, y: -40 });
    expect(document.documentElement.style.getPropertyValue('translate')).toBe('-100px -40px');
    // Idempotent: measuring while translated gives the same offset.
    expect(alignPage(document, root)).toEqual({ x: -100, y: -40 });
    root.getBoundingClientRect = () => rect(0, 0, 1080, 1440);
    expect(alignPage(document, root)).toEqual({ x: -0, y: -0 });
    expect(document.documentElement.style.getPropertyValue('translate')).toBe('');
  });

  it('resets document scroll', () => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const set = vi.fn();
    Object.defineProperty(scroller, 'scrollTop', { get: () => 30, set, configurable: true });
    alignPage(document, el('n4'));
    expect(set).toHaveBeenCalledWith(0);
    delete (scroller as unknown as Record<string, unknown>).scrollTop;
  });
});
