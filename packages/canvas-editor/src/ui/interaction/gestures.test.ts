import { describe, expect, it } from 'vitest';
import { createEditorController } from '../../app';
import { DOC, FakeFrame, FakeStore, flush, idByAttr } from '../../app/fakes';
import type { EditorHandle } from '../../app';
import { createActions } from '../actions';
import { Gestures } from './gestures';
import type { GestureView } from './gestures';

const PARAMS = { popost: true, file: 'p1.html', ratio: null, lang: 'en' as const, name: null, embedded: true, theme: null, store: 'browser' as const };

async function setup() {
  const store = new FakeStore(DOC);
  const frame = new FakeFrame();
  const c: EditorHandle = createEditorController({ store, frame, params: PARAMS, schedule: (fn) => fn() });
  await c.start();
  c.attachFrame(document.createElement('iframe'));
  await flush();
  const title = idByAttr(c, 'title');
  const box = idByAttr(c, 'box');
  frame.rects = {
    [title]: { x: 100, y: 100, width: 400, height: 80 },
    [box]: { x: 600, y: 300, width: 200, height: 100 },
  };
  frame.computed[title] = { position: 'absolute', left: '100px', top: '100px', translate: 'none' };
  c.measure('page');
  const views: GestureView[] = [];
  const g = new Gestures({ controller: c, getZoom: () => 1, onView: (v) => views.push(v) });
  g.attach();
  const toasts: string[] = [];
  const actions = createActions({ controller: c, gestures: g, zoom: { step: () => undefined, fit: () => undefined }, toast: (t) => toasts.push(t), t: (k) => k });
  const pointer = (action: 'down' | 'move' | 'up', x: number, y: number, id: string | null = null, extra: { shift?: boolean; alt?: boolean } = {}) =>
    frame.emit({ type: 'pointer', action, id, deepId: id, shift: !!extra.shift, alt: !!extra.alt, meta: false, x, y });
  return { c, frame, title, box, g, views, pointer, actions, toasts };
}

const style = (c: EditorHandle, id: string): string => c.index().elements.get(id)?.attrs.find((a) => a.name === 'style')?.value ?? '';

describe('Gestures', () => {
  it('click selects; drag moves through left/top as one undo step', async () => {
    const { c, title, pointer } = await setup();
    pointer('down', 200, 120, title);
    expect(c.getSnapshot().selection).toEqual([title]);
    pointer('move', 250, 160, title); // 50, 40 px: not near any snap line
    pointer('move', 270, 190, title);
    pointer('up', 270, 190, title);
    expect(style(c, title).replace(/\s+/g, '')).toContain('left:170px');
    expect(style(c, title).replace(/\s+/g, '')).toContain('top:170px');
    c.undo();
    expect(style(c, title)).toBe('color:red');
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('snaps to another block edge unless Alt is held, and shows guides', async () => {
    const { c, title, pointer, views } = await setup();
    pointer('down', 200, 120, title);
    pointer('move', 500, 120, title); // box left would be 400 -> block right edge 800 ... aim: left 403 vs box.x 600? use right edge
    // moved left edge = 100 + 300 = 400, right edge = 800 = other block's right edge (600 + 200)
    expect(views.some((v) => v.guides.length > 0)).toBe(true);
    pointer('up', 503, 120, title); // right edge 803 -> snaps back to 800 (threshold 6)
    expect(style(c, title).replace(/\s+/g, '')).toContain('left:400px');

    const t2 = await setup();
    t2.pointer('down', 200, 120, t2.title);
    t2.pointer('move', 400, 120, t2.title);
    t2.pointer('move', 503, 120, t2.title, { alt: true });
    t2.pointer('up', 503, 120, t2.title);
    expect(style(t2.c, t2.title).replace(/\s+/g, '')).toContain('left:403px');
  });

  it('Esc cancels a drag and nothing is committed', async () => {
    const { c, title, pointer, g, actions } = await setup();
    pointer('down', 200, 120, title);
    pointer('move', 300, 220, title);
    expect(g.active).toBe(true);
    actions.run({ type: 'escape' });
    pointer('up', 300, 220, title);
    expect(g.active).toBe(false);
    expect(c.getSnapshot().canUndo).toBe(false);
    expect(c.getSnapshot().selection).toEqual([title]); // Esc only cancelled the drag
  });

  it('shift-click toggles, marquee selects leaves, group delete is one undo step', async () => {
    const { c, title, box, pointer, actions, toasts } = await setup();
    pointer('down', 200, 120, title);
    pointer('up', 200, 120, title);
    pointer('down', 650, 320, box, { shift: true });
    pointer('up', 650, 320, box, { shift: true });
    expect(c.getSnapshot().selection).toEqual([title, box]);
    actions.run({ type: 'delete' });
    expect(c.index().source).not.toContain('data-layer-id="title"');
    expect(c.index().source).not.toContain('data-layer-id="box"');
    expect(toasts).toEqual(['toast.deleted']);
    c.undo();
    expect(c.index().source).toContain('data-layer-id="title"');
    expect(c.index().source).toContain('data-layer-id="box"');
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('marquee on empty space selects intersecting blocks; a plain click clears', async () => {
    const { c, title, box, pointer, views } = await setup();
    pointer('down', 50, 50, null);
    pointer('move', 700, 350, null);
    expect(views.at(-1)?.marquee).toEqual({ x: 50, y: 50, width: 650, height: 300 });
    pointer('up', 700, 350, null);
    expect(new Set(c.getSnapshot().selection)).toEqual(new Set([title, box]));
    pointer('down', 1000, 1000, null);
    pointer('up', 1000, 1000, null);
    expect(c.getSnapshot().selection).toEqual([]);
  });

  it('nudge writes 1 px / 10 px steps and coalesces', async () => {
    const { c, frame, title, actions } = await setup();
    c.select([title]);
    actions.run({ type: 'nudge', dx: 1, dy: 0 });
    frame.computed[title] = { position: 'absolute', left: '101px', top: '100px', translate: 'none' }; // the real frame reports the live style
    actions.run({ type: 'nudge', dx: 0, dy: 10 });
    expect(style(c, title).replace(/\s+/g, '')).toContain('left:101px');
    expect(style(c, title).replace(/\s+/g, '')).toContain('top:110px');
    c.undo();
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('resize from a handle commits width in one step; east handle on text', async () => {
    const { c, title, g } = await setup();
    c.select([title]);
    g.startResize('e', 500, 140);
    g.overlayMove(540, 140, false);
    g.overlayUp();
    expect(style(c, title).replace(/\s+/g, '')).toContain('width:440px');
    expect(c.getSnapshot().canUndo).toBe(true);
    c.undo();
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('dblclick on a text block starts editing at the point', async () => {
    const { c, frame, title, pointer } = await setup();
    frame.emit({ type: 'pointer', action: 'dblclick', id: title, deepId: title, shift: false, alt: false, meta: false, x: 210, y: 130 });
    expect(c.getSnapshot().editingTextId).toBe(title);
    expect(frame.of('beginTextEdit').at(-1)).toMatchObject({ caret: 'point', x: 210, y: 130 });
    pointer('up', 0, 0);
  });

  it('keyboard actions: reorder, duplicate, page change', async () => {
    const { c, title, actions } = await setup();
    c.select([title]);
    actions.run({ type: 'reorder', direction: 'down' });
    const order = c.index().source.indexOf('data-layer-id="box"') < c.index().source.indexOf('data-layer-id="title"');
    expect(order).toBe(true);
    actions.run({ type: 'duplicate' });
    expect(c.index().source.match(/data-layer-id="title"/g)).toHaveLength(2);
    c.select([]);
    const first = c.getSnapshot().currentPageId;
    actions.run({ type: 'page', direction: 'next' });
    expect(c.getSnapshot().currentPageId).not.toBe(first);
  });
});
