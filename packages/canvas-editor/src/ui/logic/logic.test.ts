import { describe, expect, it } from 'vitest';
import { parseIndex } from '../../core/source';
import { reorderOp, topLevelIds } from './blocks';
import { MIN_SIZE, moveProps, parseTranslate, readPlacement, resizeBlock } from './geometry';
import { isTypingTarget, resolveKey } from './keymap';
import type { KeyInfo } from './keymap';
import { boxBetween, boxesIntersect, snapBox, unionBox } from './snap';
import { clampZoom, fitZoom, stepZoom, wheelZoom, ZOOM_MAX, ZOOM_MIN } from './zoom';

const key = (k: string, mods: Partial<KeyInfo> = {}): KeyInfo => ({ key: k, ctrl: false, meta: false, shift: false, alt: false, ...mods });
const ctx = (selectionCount = 0, editing = false) => ({ selectionCount, editing });

describe('zoom', () => {
  it('clamps to 10..300', () => {
    expect(clampZoom(4)).toBe(ZOOM_MIN);
    expect(clampZoom(900)).toBe(ZOOM_MAX);
    expect(clampZoom(49.6)).toBe(49.6);
  });

  it('fits the page into the stage minus padding', () => {
    // stage 832x1132 content area, page 1080x1350 -> limited by width: 768/1080
    expect(fitZoom({ width: 832, height: 1414 }, { width: 1080, height: 1350 })).toBeCloseTo((832 - 64) / 1080 * 100, 5);
    expect(fitZoom({ width: 100, height: 100 }, { width: 10000, height: 10000 })).toBe(ZOOM_MIN);
    expect(fitZoom({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(100);
  });

  it('steps and always changes the value inside the limits', () => {
    expect(stepZoom(100, 1)).toBeCloseTo(112);
    expect(stepZoom(100, -1)).toBeCloseTo(100 / 1.12);
    expect(stepZoom(10, 1)).toBeGreaterThan(10);
    expect(stepZoom(10, -1)).toBe(10);
    expect(stepZoom(300, 1)).toBe(300);
    expect(stepZoom(299, 1)).toBe(300);
  });

  it('wheel zooms out for positive deltaY', () => {
    expect(wheelZoom(100, 100)).toBeLessThan(100);
    expect(wheelZoom(100, -100)).toBeGreaterThan(100);
  });
});

describe('snapBox', () => {
  const page = { width: 1000, height: 1000 };
  it('snaps to page edges and centre within the threshold', () => {
    const r = snapBox({ x: 4, y: 100, width: 200, height: 100 }, [], page, 6);
    expect(r.dx).toBe(-4);
    expect(r.dy).toBe(0);
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 0)).toBe(true);
    const c = snapBox({ x: 398, y: 100, width: 200, height: 100 }, [], page, 6);
    expect(c.dx).toBe(2); // centre of the box 498 -> page centre 500
  });

  it('does not snap beyond the threshold', () => {
    const r = snapBox({ x: 20, y: 120, width: 200, height: 100 }, [], page, 6);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('snaps to other blocks and reports a guide spanning both', () => {
    const other = { x: 300, y: 600, width: 100, height: 100 };
    const r = snapBox({ x: 303, y: 100, width: 50, height: 50 }, [other], page, 6);
    expect(r.dx).toBe(-3);
    const g = r.guides.find((x) => x.axis === 'x' && x.pos === 300);
    expect(g).toEqual({ axis: 'x', pos: 300, from: 100, to: 700 });
  });

  it('picks the closest candidate per axis', () => {
    const r = snapBox({ x: 104, y: 0, width: 10, height: 10 }, [{ x: 100, y: 0, width: 10, height: 10 }, { x: 106, y: 0, width: 10, height: 10 }], page, 6);
    expect(r.dx).toBe(1); // centre 109 -> right edge 110 of the first block (distance 1) beats everything else
  });

  it('helpers: union, intersection, normalised box', () => {
    expect(unionBox([])).toBeNull();
    expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }])).toEqual({ x: 0, y: 0, width: 30, height: 15 });
    expect(boxesIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(boxesIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(boxBetween(10, 20, 4, 30)).toEqual({ x: 4, y: 20, width: 6, height: 10 });
  });
});

describe('placement', () => {
  it('parses translate values', () => {
    expect(parseTranslate('none')).toEqual({ x: 0, y: 0 });
    expect(parseTranslate(undefined)).toEqual({ x: 0, y: 0 });
    expect(parseTranslate('10px 20px')).toEqual({ x: 10, y: 20 });
    expect(parseTranslate('10px')).toEqual({ x: 10, y: 0 });
    expect(parseTranslate('-5.5px 0px 0px')).toEqual({ x: -5.5, y: 0 });
    expect(parseTranslate('50% 0px')).toBeNull();
  });

  it('absolute blocks move through left/top, others through translate', () => {
    const abs = readPlacement({ position: 'absolute', left: '80px', top: '120px', translate: 'none' });
    expect(moveProps(abs, 5.4, -10)).toEqual({ left: '85px', top: '110px' });
    const fixed = readPlacement({ position: 'fixed', left: '0px', top: '0px' });
    expect(fixed.mode).toBe('abs');
    const flow = readPlacement({ position: 'static', left: 'auto', top: 'auto', translate: '3px 4px' });
    expect(moveProps(flow, 7, 1)).toEqual({ translate: '10px 5px' });
    expect(readPlacement({ position: 'absolute', left: 'auto', top: 'auto' }).mode).toBe('flow');
    expect(readPlacement({ position: 'relative', translate: 'none' })).toEqual({ mode: 'flow', x: 0, y: 0 });
  });
});

describe('resizeBlock', () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  const base = { start, fontSize: 20, extra: { width: 0, height: 0 } };

  it('side handle on text changes width only', () => {
    const r = resizeBlock({ ...base, handle: 'e', kind: 'text', dx: 30, dy: 99 });
    expect(r.props).toEqual({ width: '230px' });
    expect(r.shift).toEqual({ x: 0, y: 0 });
  });

  it('west handle shifts the left edge', () => {
    const r = resizeBlock({ ...base, handle: 'w', kind: 'text', dx: -40, dy: 0 });
    expect(r.props.width).toBe('240px');
    expect(r.shift).toEqual({ x: -40, y: 0 });
  });

  it('side handle on images sets width and proportional height', () => {
    const r = resizeBlock({ ...base, handle: 'e', kind: 'image', dx: 100, dy: 0 });
    expect(r.props).toEqual({ width: '300px', height: '150px' });
  });

  it('corner on text scales font-size (0.5 px steps) and width', () => {
    const r = resizeBlock({ ...base, handle: 'se', kind: 'text', dx: 100, dy: 0 });
    expect(r.props).toEqual({ width: '300px', 'font-size': '30px' });
    const odd = resizeBlock({ ...base, handle: 'se', kind: 'text', dx: 13, dy: 0 });
    expect(odd.props['font-size']).toBe('21.5px');
  });

  it('corner on images keeps the aspect ratio; north-west moves the origin', () => {
    const r = resizeBlock({ ...base, handle: 'nw', kind: 'image', dx: -100, dy: 55 });
    expect(r.props).toEqual({ width: '300px', height: '150px' });
    expect(r.shift).toEqual({ x: -100, y: -50 });
  });

  it('corner on boxes is free; content-box padding is subtracted', () => {
    const r = resizeBlock({ ...base, handle: 'se', kind: 'box', dx: 50, dy: 20, extra: { width: 20, height: 10 } });
    expect(r.props).toEqual({ width: '230px', height: '110px' });
    expect(r.width).toBe(250);
  });

  it('never collapses below the minimum size', () => {
    const r = resizeBlock({ ...base, handle: 'e', kind: 'text', dx: -1000, dy: 0 });
    expect(r.props.width).toBe(`${MIN_SIZE}px`);
  });
});

describe('keymap', () => {
  it('save, undo, redo with ctrl or meta', () => {
    expect(resolveKey(key('s', { ctrl: true }), ctx())).toEqual({ type: 'save' });
    expect(resolveKey(key('S', { meta: true }), ctx())).toEqual({ type: 'save' });
    expect(resolveKey(key('z', { ctrl: true }), ctx())).toEqual({ type: 'undo' });
    expect(resolveKey(key('Z', { ctrl: true, shift: true }), ctx())).toEqual({ type: 'redo' });
    expect(resolveKey(key('y', { meta: true }), ctx())).toEqual({ type: 'redo' });
  });

  it('zoom keys', () => {
    expect(resolveKey(key('+'), ctx())).toEqual({ type: 'zoom', mode: 'in' });
    expect(resolveKey(key('-'), ctx())).toEqual({ type: 'zoom', mode: 'out' });
    expect(resolveKey(key('-'), ctx(1))).toEqual({ type: 'scaleSelection', direction: -1 });
    expect(resolveKey(key('+'), ctx(1))).toEqual({ type: 'scaleSelection', direction: 1 });
    expect(resolveKey(key('=', { ctrl: true }), ctx())).toEqual({ type: 'zoom', mode: 'in' });
    expect(resolveKey(key('+', { ctrl: true, shift: true }), ctx())).toEqual({ type: 'zoom', mode: 'in' });
    expect(resolveKey(key('-', { meta: true }), ctx())).toEqual({ type: 'zoom', mode: 'out' });
    expect(resolveKey(key('0', { ctrl: true }), ctx())).toEqual({ type: 'zoom', mode: 'fit' });
  });

  it('selection keys: delete, duplicate, enter, nudge, reorder', () => {
    expect(resolveKey(key('Delete'), ctx(1))).toEqual({ type: 'delete' });
    expect(resolveKey(key('Backspace'), ctx(2))).toEqual({ type: 'delete' });
    expect(resolveKey(key('Delete'), ctx(0))).toBeNull();
    expect(resolveKey(key('d', { ctrl: true }), ctx(1))).toEqual({ type: 'duplicate' });
    expect(resolveKey(key('d', { ctrl: true }), ctx(0))).toBeNull();
    expect(resolveKey(key('Enter'), ctx(1))).toEqual({ type: 'edit' });
    expect(resolveKey(key('Enter'), ctx(2))).toBeNull();
    expect(resolveKey(key('ArrowLeft'), ctx(1))).toEqual({ type: 'nudge', dx: -1, dy: 0 });
    expect(resolveKey(key('ArrowDown', { shift: true }), ctx(3))).toEqual({ type: 'nudge', dx: 0, dy: 10 });
    expect(resolveKey(key('ArrowUp', { alt: true }), ctx(1))).toEqual({ type: 'reorder', direction: 'up' });
    expect(resolveKey(key('ArrowDown', { alt: true }), ctx(1))).toEqual({ type: 'reorder', direction: 'down' });
    expect(resolveKey(key('ArrowLeft', { alt: true }), ctx(1))).toBeNull();
  });

  it('page keys only when nothing is selected', () => {
    expect(resolveKey(key('ArrowLeft'), ctx(0))).toEqual({ type: 'page', direction: 'prev' });
    expect(resolveKey(key('PageDown'), ctx(0))).toEqual({ type: 'page', direction: 'next' });
    expect(resolveKey(key('PageDown'), ctx(1))).toBeNull();
    expect(resolveKey(key('ArrowUp'), ctx(0))).toBeNull();
  });

  it('escape always; other keys are left to the text editor while editing', () => {
    expect(resolveKey(key('Escape'), ctx(0, true))).toEqual({ type: 'escape' });
    expect(resolveKey(key('Delete'), ctx(1, true))).toBeNull();
    expect(resolveKey(key('z', { ctrl: true }), ctx(1, true))).toBeNull();
    expect(resolveKey(key('s', { ctrl: true }), ctx(1, true))).toEqual({ type: 'save' });
    expect(resolveKey(key('=', { ctrl: true }), ctx(1, true))).toEqual({ type: 'zoom', mode: 'in' });
  });

  it('style copy/paste', () => {
    expect(resolveKey(key('c', { ctrl: true, alt: true }), ctx(1))).toEqual({ type: 'copyStyle' });
    expect(resolveKey(key('v', { ctrl: true, alt: true }), ctx(1))).toEqual({ type: 'pasteStyle' });
  });

  it('detects typing targets', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const button = document.createElement('button');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('block helpers', () => {
  const html = '<body><section class="slide"><h1>A</h1><p>B</p><div><p>C</p></div></section></body>';
  const index = parseIndex(html);
  const byTag = (tag: string): string[] => index.order.filter((id) => index.elements.get(id)?.tag === tag);

  it('topLevelIds drops nested ids', () => {
    const [div] = byTag('div');
    const [, , pInDiv] = byTag('p').concat(byTag('p'));
    const nested = byTag('p')[1] as string;
    expect(topLevelIds(index, [div as string, nested])).toEqual([div]);
    expect(pInDiv).toBeDefined();
    expect(topLevelIds(index, ['nope'])).toEqual([]);
  });

  it('reorderOp moves among siblings and stops at the ends', () => {
    const [h1] = byTag('h1');
    const [p] = byTag('p');
    const [div] = byTag('div');
    const section = index.elements.get(h1 as string)?.parent as string;
    expect(reorderOp(index, h1 as string, 'up')).toBeNull();
    expect(reorderOp(index, h1 as string, 'down')).toEqual({ kind: 'move', id: h1, parentId: section, beforeId: div });
    expect(reorderOp(index, p as string, 'up')).toEqual({ kind: 'move', id: p, parentId: section, beforeId: h1 });
    expect(reorderOp(index, div as string, 'down')).toBeNull();
  });
});
