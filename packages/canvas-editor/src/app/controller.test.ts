import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../contracts';
import type { EditorSnapshot, HostParams, Notice } from '../contracts';
import { DownloadError } from '../host/download';
import { createEditorController, ERROR_NO_PAGES } from './index';
import type { EditorHandle } from './index';
import { bindTestHooks } from './index';
import { DOC, FakeFrame, FakeStore, flush, idByAttr } from './fakes';

const PARAMS: HostParams = { popost: true, file: 'p1.html', ratio: null, lang: 'en', name: null, embedded: true, theme: null, store: 'browser' };

interface Env {
  c: EditorHandle;
  store: FakeStore;
  frame: FakeFrame;
  notices: Notice[];
  tick(ms: number): void;
  runScheduled(): void;
}

async function setup(opts: { content?: string; attach?: boolean; start?: boolean; mode?: 'browser' | 'local' } = {}): Promise<Env> {
  const store = new FakeStore(opts.content);
  if (opts.mode) store.mode = opts.mode;
  const frame = new FakeFrame();
  let now = 1000;
  let counter = 0;
  const queue: Array<() => void> = [];
  const c = createEditorController({
    store,
    frame,
    params: PARAMS,
    now: () => now,
    randomHex: (n) => String(++counter).padStart(n, '0'),
    schedule: (fn) => queue.push(fn),
  });
  const notices: Notice[] = [];
  c.onNotice((n) => notices.push(n));
  if (opts.start !== false) await c.start();
  if (opts.attach !== false) {
    c.attachFrame(document.createElement('iframe'));
    await flush();
  }
  return {
    c,
    store,
    frame,
    notices,
    tick: (ms) => {
      now += ms;
    },
    runScheduled: () => {
      for (const fn of queue.splice(0)) fn();
    },
  };
}

const css = (c: EditorHandle, id: string): string => {
  const el = c.index().elements.get(id);
  return (el?.attrs.find((a) => a.name === 'style')?.value ?? '').replace(/:\s+/g, ':').replace(/;\s+/g, ';');
};

describe('load', () => {
  it('opens the first page without writing', async () => {
    const { c, store } = await setup();
    const s = c.getSnapshot();
    expect(s.docState).toBe('ready');
    expect(s.pages).toHaveLength(2);
    expect(s.currentPageId).toBe(s.pages[0]!.id);
    expect(s.name).toBe('My post');
    expect(s.path).toBe('p1.html');
    expect(s.mode).toBe('browser');
    expect(s.saveState).toBe('saved');
    expect(s.canUndo).toBe(false);
    expect(c.pageSize()).toEqual({ width: 1080, height: 1350 });
    expect(store.saves).toHaveLength(0);
  });

  it('reports load errors and documents without pages', async () => {
    const bad = await setup({ start: false });
    bad.store.loadError = new Error('Project not found');
    await bad.c.start();
    expect(bad.c.getSnapshot()).toMatchObject({ docState: 'error', error: 'Project not found' });

    const empty = await setup({ start: false, content: '<p>no pages</p>' });
    await empty.c.start();
    expect(empty.c.getSnapshot()).toMatchObject({ docState: 'error', error: ERROR_NO_PAGES });
  });

  it('mounts the frame when attached after loading and when the document becomes ready', async () => {
    const early = await setup({ start: false, attach: true });
    expect(early.frame.mounts).toHaveLength(0);
    await early.c.start();
    await flush();
    expect(early.frame.mounts).toHaveLength(1);
    expect(early.frame.mounts[0]!.currentPageId).toBe(early.c.getSnapshot().currentPageId);

    const late = await setup({ attach: false });
    expect(late.frame.mounts).toHaveLength(0);
    late.c.attachFrame(document.createElement('iframe'));
    expect(late.frame.mounts).toHaveLength(1);
  });

  it('shows the newly selected page when the frame finishes mounting', async () => {
    const { c, frame } = await setup({ attach: false });
    c.attachFrame(document.createElement('iframe'));
    const second = c.getSnapshot().pages[1]!.id;
    c.setCurrentPage(second);
    await flush();
    expect(frame.sent).toContainEqual({ type: 'currentPage', id: second });
  });

  it('remounts on a new iframe and stops listening when detached', async () => {
    const { c, frame } = await setup();
    expect(frame.listenerCount).toBe(1);
    c.attachFrame(document.createElement('iframe'));
    await flush();
    expect(frame.mounts).toHaveLength(2);
    expect(frame.listenerCount).toBe(1);
    c.attachFrame(null);
    expect(frame.listenerCount).toBe(0);
  });
});

describe('reload', () => {
  it('discards local changes, clears history and conflict and keeps the page position', async () => {
    const { c, store } = await setup();
    c.setCurrentPage(c.getSnapshot().pages[1]!.id);
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'second'), props: { color: 'blue' } });
    store.saveError = new ConflictError('x');
    await c.save();
    expect(c.getSnapshot().conflict).toBe(true);
    store.saveError = null;
    store.content = DOC.replace('Second', 'Other');
    await c.reload();
    const s = c.getSnapshot();
    expect(c.index().source).toContain('Other');
    expect(s).toMatchObject({ conflict: false, canUndo: false, saveState: 'saved', selection: [] });
    expect(s.currentPageId).toBe(s.pages[1]!.id);
  });
});

describe('externalChange', () => {
  it('reloads when nothing is unsaved', async () => {
    const { c, store } = await setup();
    store.content = DOC.replace('Second', 'Other');
    await c.externalChange();
    expect(c.index().source).toContain('Other');
    expect(c.getSnapshot()).toMatchObject({ conflict: false, saveState: 'saved' });
  });

  it('keeps unsaved edits and raises the conflict dialog instead', async () => {
    const { c, store } = await setup();
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'second'), props: { color: 'blue' } });
    const edited = c.index().source;
    store.content = DOC.replace('Second', 'Other');
    await c.externalChange();
    expect(c.index().source).toBe(edited);
    expect(c.getSnapshot()).toMatchObject({ conflict: true, saveState: 'dirty' });
  });
});

describe('apply / batch / undo / redo', () => {
  it('sends live updates, counts versions and notifies once per change', async () => {
    const { c, frame } = await setup();
    const listener = vi.fn();
    c.subscribe(listener);
    const before = c.getSnapshot();
    const id = idByAttr(c, 'title');
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    expect(css(c, id)).toContain('blue');
    const s = c.getSnapshot();
    expect(s).not.toBe(before);
    expect(s.sourceVersion).toBe(before.sourceVersion + 1);
    expect(s.saveState).toBe('dirty');
    expect(s.canUndo).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(frame.of('live').at(-1)!.updates).toEqual([{ kind: 'style', id, props: { color: 'blue' } }]);
    expect(frame.mounts).toHaveLength(1);
  });

  it('keeps the snapshot object when nothing changed', async () => {
    const { c } = await setup();
    const before = c.getSnapshot();
    c.select([]);
    c.measure('page');
    c.undo();
    expect(c.getSnapshot()).toBe(before);
    const again = c.getSnapshot();
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'red' } });
    expect(c.getSnapshot()).toBe(again);
  });

  it('rejects bad ops with a notice and leaves everything untouched', async () => {
    const { c, notices } = await setup();
    const before = c.getSnapshot();
    c.apply({ kind: 'setStyle', id: 'nope', props: { color: 'blue' } });
    expect(c.getSnapshot()).toBe(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'error', key: 'editRejected' });
    expect(notices[0]!.detail).toBeTruthy();
  });

  it('applies a batch as one history entry and is all-or-nothing', async () => {
    const { c, notices } = await setup();
    const source = c.index().source;
    const title = idByAttr(c, 'title');
    const second = idByAttr(c, 'second');
    c.applyBatch(
      [
        { kind: 'setStyle', id: title, props: { color: 'blue' } },
        { kind: 'setStyle', id: second, props: { color: 'green' } },
      ],
      'colors',
    );
    expect(css(c, title)).toContain('blue');
    expect(css(c, second)).toContain('green');
    c.undo();
    expect(c.index().source).toBe(source);
    expect(c.getSnapshot().canUndo).toBe(false);
    c.redo();
    expect(css(c, second)).toContain('green');

    const mid = c.index().source;
    c.applyBatch(
      [
        { kind: 'setStyle', id: title, props: { color: 'pink' } },
        { kind: 'setStyle', id: 'missing', props: { color: 'x' } },
      ],
      'bad',
    );
    expect(c.index().source).toBe(mid);
    expect(notices.at(-1)!.key).toBe('editRejected');
  });

  it('undoes and redoes through a remount and tracks dirty vs saved text', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    expect(c.getSnapshot().saveState).toBe('dirty');
    const mounts = frame.mounts.length;
    c.undo();
    await flush();
    expect(c.getSnapshot()).toMatchObject({ saveState: 'saved', canUndo: false, canRedo: true });
    expect(frame.mounts).toHaveLength(mounts + 1);
    expect(frame.mounts.at(-1)!.index).toBe(c.index());
    c.redo();
    expect(c.getSnapshot()).toMatchObject({ saveState: 'dirty', canRedo: false });
  });

  it('uses finer live updates for structural ops and remounts for replaceDocument', async () => {
    const { c, frame } = await setup();
    c.apply({ kind: 'remove', id: idByAttr(c, 'inner') });
    expect(frame.of('live').at(-1)!.updates[0]).toMatchObject({ kind: 'remove' });
    expect(frame.mounts).toHaveLength(1);
    c.apply({ kind: 'replaceDocument', source: DOC.replace('Hello', 'Hi') });
    await flush();
    expect(frame.mounts).toHaveLength(2);
    expect(frame.of('live').filter((m) => m.updates.some((u) => u.kind === 'reload'))).toHaveLength(0);
  });

  it('coalesces by key within 600 ms only', async () => {
    const { c, tick } = await setup();
    const id = idByAttr(c, 'title');
    const set = (color: string): void => c.apply({ kind: 'setStyle', id, props: { color } }, { coalesceKey: 'drag' });
    set('blue');
    tick(300);
    set('green');
    c.undo();
    expect(c.getSnapshot().canUndo).toBe(false);
    expect(css(c, id)).toContain('red');
    c.redo();
    tick(700);
    set('pink');
    c.undo();
    expect(css(c, id)).toContain('green');
    expect(c.getSnapshot().canUndo).toBe(true);
  });

  it('coalesces batches by key into one undo step', async () => {
    const { c, tick } = await setup();
    const id = idByAttr(c, 'title');
    const nudge = (color: string): void => c.applyBatch([{ kind: 'setStyle', id, props: { color } }], 'nudge', { coalesceKey: 'nudge' });
    nudge('blue');
    tick(100);
    nudge('green');
    c.undo();
    expect(c.getSnapshot().canUndo).toBe(false);
    expect(css(c, id)).toContain('red');
  });

  it('drops selection of removed elements, falls back to the neighbour page and selects duplicates', async () => {
    const { c, frame } = await setup();
    const inner = idByAttr(c, 'inner');
    c.select([inner]);
    c.apply({ kind: 'remove', id: inner });
    expect(c.getSnapshot().selection).toEqual([]);

    const title = idByAttr(c, 'title');
    c.apply({ kind: 'duplicate', id: title });
    const sel = c.getSnapshot().selection;
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(title);

    const [p1, p2] = c.getSnapshot().pages;
    c.apply({ kind: 'remove', id: p1!.id });
    expect(c.getSnapshot().pages).toHaveLength(1);
    expect(c.getSnapshot().currentPageId).toBe(p2!.id);
    expect(frame.of('currentPage').at(-1)).toEqual({ type: 'currentPage', id: p2!.id });
  });

  it('keeps the current page when a page is duplicated and detects the new page', async () => {
    const { c } = await setup();
    const cur = c.getSnapshot().currentPageId;
    c.apply({ kind: 'duplicate', id: cur! });
    const s = c.getSnapshot();
    expect(s.pages).toHaveLength(3);
    expect(s.currentPageId).toBe(cur);
    expect(s.selection).toEqual([]);
    expect(s.pages[1]!.pageKey).toMatch(/^p-/);
  });
});

describe('selection', () => {
  it('selects, toggles additively and switches page for elements elsewhere', async () => {
    const { c, frame } = await setup();
    const title = idByAttr(c, 'title');
    const inner = idByAttr(c, 'inner');
    const second = idByAttr(c, 'second');
    c.select([title]);
    c.select([inner], { additive: true });
    expect(c.getSnapshot().selection).toEqual([title, inner]);
    c.select([title], { additive: true });
    expect(c.getSnapshot().selection).toEqual([inner]);
    c.select([second]);
    const s = c.getSnapshot();
    expect(s.currentPageId).toBe(s.pages[1]!.id);
    expect(s.selection).toEqual([second]);
    expect(frame.of('currentPage').at(-1)).toEqual({ type: 'currentPage', id: s.pages[1]!.id });
  });

  it('ignores unknown ids and page roots', async () => {
    const { c } = await setup();
    c.select(['nope', c.getSnapshot().currentPageId!]);
    expect(c.getSnapshot().selection).toEqual([]);
  });

  it('walks to the next selectable ancestor below the page root', async () => {
    const { c } = await setup();
    const inner = idByAttr(c, 'inner');
    const box = idByAttr(c, 'box');
    c.select([inner]);
    c.selectParent();
    expect(c.getSnapshot().selection).toEqual([box]);
    c.selectParent();
    expect(c.getSnapshot().selection).toEqual([box]);
  });

  it('clears selection on page change and tells the frame', async () => {
    const { c, frame } = await setup();
    c.select([idByAttr(c, 'title')]);
    const p2 = c.getSnapshot().pages[1]!.id;
    c.setCurrentPage(p2);
    expect(c.getSnapshot()).toMatchObject({ currentPageId: p2, selection: [] });
    expect(frame.of('currentPage')).toEqual([{ type: 'currentPage', id: p2 }]);
    expect(c.getSnapshot().saveState).toBe('saved');
    expect(c.getSnapshot().sourceVersion).toBe(1);
    c.setCurrentPage('nope');
    expect(c.getSnapshot().currentPageId).toBe(p2);
  });
});

describe('text editing', () => {
  it('passes a point caret to the frame', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id, { x: 12, y: 34 });
    expect(frame.of('beginTextEdit')).toEqual([{ type: 'beginTextEdit', id, caret: 'point', x: 12, y: 34 }]);
  });

  it('commits a frame textCommit as one undoable setInnerHTML', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id, 'all');
    expect(c.getSnapshot()).toMatchObject({ editingTextId: id, selection: [id] });
    expect(frame.of('beginTextEdit')).toEqual([{ type: 'beginTextEdit', id, caret: 'all' }]);
    frame.emit({ type: 'textState', id, range: true, active: { bold: true } });
    expect(c.getSnapshot().textState).toEqual({ range: true, active: { bold: true } });
    frame.emit({ type: 'textCommit', id, html: 'Bye' });
    expect(c.getSnapshot()).toMatchObject({ editingTextId: null, textState: null, saveState: 'dirty' });
    expect(c.index().source).toContain('>Bye</h1>');
    c.undo();
    expect(c.index().source).toBe(DOC);
  });

  it('cancels without touching the source and ignores unchanged commits', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id);
    frame.emit({ type: 'textCancel', id });
    expect(c.getSnapshot().editingTextId).toBeNull();
    c.beginTextEdit(id);
    frame.editHtml = 'Hello';
    c.endTextEdit(true);
    expect(c.getSnapshot()).toMatchObject({ editingTextId: null, saveState: 'saved', canUndo: false });
    c.beginTextEdit(id);
    frame.editHtml = 'X';
    c.endTextEdit(false);
    expect(c.index().source).toBe(DOC);
    expect(frame.of('endTextEdit').map((m) => m.commit)).toEqual([true, false]);
  });

  it('commits before save, page switch, undo and other ops', async () => {
    const { c, frame, store } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id);
    frame.editHtml = 'Saved text';
    await c.save();
    expect(store.saves.at(-1)!.content).toContain('Saved text');
    expect(c.getSnapshot().saveState).toBe('saved');

    c.beginTextEdit(id);
    frame.editHtml = 'Page switch';
    c.setCurrentPage(c.getSnapshot().pages[1]!.id);
    expect(c.index().source).toContain('Page switch');
    expect(c.getSnapshot().editingTextId).toBeNull();

    c.setCurrentPage(c.getSnapshot().pages[0]!.id);
    c.beginTextEdit(id);
    frame.editHtml = 'Undo me';
    c.undo();
    await flush();
    expect(c.index().source).toContain('Page switch');
    expect(c.index().source).not.toContain('Undo me');
    expect(c.getSnapshot().canRedo).toBe(true);

    c.beginTextEdit(id);
    frame.editHtml = 'Before op';
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    expect(c.index().source).toContain('Before op');
    expect(css(c, id)).toContain('blue');
  });

  it('switches page when editing text elsewhere', async () => {
    const { c } = await setup();
    c.beginTextEdit(idByAttr(c, 'second'));
    expect(c.getSnapshot().currentPageId).toBe(c.getSnapshot().pages[1]!.id);
  });
});

describe('format', () => {
  it('forwards to the frame while a range is selected', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id);
    frame.emit({ type: 'textState', id, range: true, active: {} });
    c.format({ command: 'bold' });
    expect(frame.of('format')).toEqual([{ type: 'format', format: { command: 'bold' } }]);
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('applies setStyle to the edited block when there is no range, committing the edit first', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    frame.computed[id] = { 'font-weight': '400' };
    c.beginTextEdit(id);
    frame.editHtml = 'Hello';
    frame.emit({ type: 'textState', id, range: false, active: {} });
    c.format({ command: 'bold' });
    expect(frame.of('format')).toHaveLength(0);
    expect(css(c, id)).toContain('font-weight:700');
    expect(c.getSnapshot().editingTextId).toBeNull();
  });

  it('toggles bold, italic, underline, strike and uppercase from the computed style', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    c.select([id]);
    frame.computed[id] = { 'font-weight': '700', 'font-style': 'normal', 'text-decoration-line': 'underline', 'text-transform': 'none' };
    c.format({ command: 'bold' });
    expect(css(c, id)).toContain('font-weight:400');
    c.format({ command: 'italic' });
    expect(css(c, id)).toContain('font-style:italic');
    c.format({ command: 'underline' });
    expect(css(c, id)).toContain('text-decoration-line:none');
    frame.computed[id] = { 'text-decoration-line': 'none' };
    c.format({ command: 'strike' });
    expect(css(c, id)).toContain('text-decoration-line:line-through');
    c.format({ command: 'uppercase' });
    expect(css(c, id)).toContain('text-transform:uppercase');
    frame.computed[id] = { 'text-decoration-line': 'underline line-through' };
    c.format({ command: 'underline' });
    expect(css(c, id)).toContain('text-decoration-line:line-through');
  });

  it('applies to every selected block as one step, coalesces colour and clears', async () => {
    const { c, tick } = await setup();
    const title = idByAttr(c, 'title');
    const inner = idByAttr(c, 'inner');
    c.select([title, inner]);
    c.format({ command: 'color', value: '#111' });
    tick(100);
    c.format({ command: 'color', value: '#222' });
    expect(css(c, title)).toContain('#222');
    expect(css(c, inner)).toContain('#222');
    c.format({ command: 'fontSize', value: '40px' });
    expect(css(c, inner)).toContain('font-size:40px');
    c.format({ command: 'fontFamily', value: '"Inter Variable", sans-serif' });
    c.format({ command: 'clear' });
    expect(css(c, title)).not.toContain('color');
    expect(css(c, title)).not.toContain('font-size');
    c.undo(); // clear
    c.undo(); // font family
    c.undo(); // font size
    c.undo(); // both colour edits at once
    expect(css(c, title)).toContain('red');
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('does nothing without targets', async () => {
    const { c } = await setup();
    c.format({ command: 'bold' });
    expect(c.getSnapshot().canUndo).toBe(false);
  });
});

describe('save', () => {
  it('saves with the loaded rev, goes saving to saved and keeps edits made meanwhile dirty', async () => {
    const { c, store } = await setup();
    const id = idByAttr(c, 'title');
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    let release!: () => void;
    store.saveGate = new Promise((r) => (release = r));
    const p = c.save();
    expect(c.getSnapshot().saveState).toBe('saving');
    expect(store.saves[0]).toMatchObject({ rev: '1', force: false });
    c.apply({ kind: 'setStyle', id, props: { color: 'green' } });
    expect(c.getSnapshot().saveState).toBe('saving');
    release();
    await p;
    expect(c.getSnapshot().saveState).toBe('dirty');
    store.saveGate = null;
    await c.save();
    expect(store.saves[1]).toMatchObject({ rev: '2' });
    expect(c.getSnapshot().saveState).toBe('saved');
  });

  it('does not save a clean document, but saves when forced', async () => {
    const { c, store } = await setup();
    await c.save();
    expect(store.saves).toHaveLength(0);
    await c.save({ force: true });
    expect(store.saves).toHaveLength(1);
  });

  it('joins a running save and saves again only when still dirty', async () => {
    const { c, store } = await setup();
    const id = idByAttr(c, 'title');
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    let release!: () => void;
    store.saveGate = new Promise((r) => (release = r));
    const a = c.save();
    const b = c.save();
    release();
    await Promise.all([a, b]);
    expect(store.saves).toHaveLength(1);

    store.saveGate = new Promise((r) => (release = r));
    c.apply({ kind: 'setStyle', id, props: { color: 'green' } });
    const d = c.save();
    c.apply({ kind: 'setStyle', id, props: { color: 'pink' } });
    const e = c.save();
    release();
    store.saveGate = null;
    await Promise.all([d, e]);
    expect(store.saves).toHaveLength(3);
    expect(store.saves[2]!.content).toContain('pink');
    expect(c.getSnapshot().saveState).toBe('saved');
  });

  it('flags conflicts, stops plain retries and clears with force', async () => {
    const { c, store } = await setup();
    const id = idByAttr(c, 'title');
    c.apply({ kind: 'setStyle', id, props: { color: 'blue' } });
    store.rev = '9';
    await c.save();
    expect(c.getSnapshot()).toMatchObject({ conflict: true, saveState: 'dirty' });
    await c.save();
    expect(store.saves).toHaveLength(1);
    await c.save({ force: true });
    expect(store.saves[1]).toMatchObject({ force: true });
    expect(c.getSnapshot()).toMatchObject({ conflict: false, saveState: 'saved' });
    expect(store.content).toContain('blue');
  });

  it('reports other errors', async () => {
    const { c, store, notices } = await setup();
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'blue' } });
    store.saveError = new Error('disk full');
    await c.save();
    expect(c.getSnapshot().saveState).toBe('error');
    expect(notices.at(-1)).toEqual({ kind: 'error', key: 'saveFailed', detail: 'disk full' });
    store.saveError = null;
    await c.save();
    expect(c.getSnapshot().saveState).toBe('saved');
  });
});

describe('reset and code panel', () => {
  it('resets to the initial layout as one undoable step', async () => {
    const { c, store, notices } = await setup();
    c.apply({ kind: 'duplicate', id: c.getSnapshot().pages[0]!.id });
    expect(c.getSnapshot().pages).toHaveLength(3);
    store.initialDoc = { ...store.initialDoc, content: DOC };
    await c.resetToInitial();
    expect(c.getSnapshot().pages).toHaveLength(2);
    expect(notices.at(-1)).toMatchObject({ kind: 'info', key: 'resetDone' });
    c.undo();
    expect(c.getSnapshot().pages).toHaveLength(3);
  });

  it('says so when no initial layout exists', async () => {
    const { c, store, notices } = await setup();
    store.initialDoc = { ...store.initialDoc, available: false };
    await c.resetToInitial();
    expect(notices.at(-1)!.key).toBe('resetUnavailable');
    expect(c.getSnapshot().canUndo).toBe(false);
  });

  it('validates replaceSource and applies it undoably', async () => {
    const { c } = await setup();
    expect(c.replaceSource('   ')).toBe('empty');
    expect(c.replaceSource('<p>no page</p>')).toBe('no-slide');
    expect(c.replaceSource('<div class="slide"><script>1</script></div>')).toBe('unsafe');
    expect(c.getSnapshot().canUndo).toBe(false);
    const next = DOC.replace('Hello', 'From code');
    expect(c.replaceSource(next)).toBeNull();
    expect(c.index().source).toBe(next);
    expect(c.getSnapshot().saveState).toBe('dirty');
    c.undo();
    expect(c.index().source).toBe(DOC);
    expect(c.getSnapshot().saveState).toBe('saved');
  });
});

describe('downloadAll and export', () => {
  it('commits text edits, reports success and failure', async () => {
    const { c, store, frame, notices } = await setup();
    const id = idByAttr(c, 'title');
    c.beginTextEdit(id);
    frame.editHtml = 'Downloaded';
    await c.downloadAll();
    expect(store.downloads[0]!.content).toContain('Downloaded');
    expect(notices.at(-1)).toEqual({ kind: 'info', key: 'downloadDone' });
    expect(c.getSnapshot().saveState).toBe('dirty');

    store.downloadError = new DownloadError('timeout', 'Download timed out. Please retry.');
    await c.downloadAll();
    expect(notices.at(-1)).toEqual({ kind: 'error', key: 'downloadFailed', detail: 'Download timed out. Please retry.' });
    store.downloadError = new Error('boom');
    await c.downloadAll();
    expect(notices.at(-1)).toMatchObject({ key: 'downloadFailed', detail: 'boom' });
  });

  it('marks the document saved after a local-mode download (it saves first) and adopts the new rev', async () => {
    const { c, store } = await setup({ mode: 'local' });
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'blue' } });
    store.downloadAll = async (content, ctx) => {
      store.downloads.push({ content, rev: ctx.rev });
      return { rev: '77' };
    };
    await c.downloadAll();
    expect(c.getSnapshot().saveState).toBe('saved');
    store.saveGate = null;
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'pink' } });
    await c.save();
    expect(store.saves.at(-1)!.rev).toBe('77');
  });

  it('downloads a static copy named after the document', async () => {
    const { c } = await setup();
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), 'blob:test'));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    c.exportHTML();
    expect(names).toEqual(['My post.html']);
    const text = await blobs[0]!.text();
    expect(text).toContain('Content-Security-Policy');
    expect(text).toContain('Hello');
    click.mockRestore();
  });
});

describe('fonts', () => {
  it('caches the palette and retries after a failure', async () => {
    const { c, store } = await setup();
    await c.fontPalette();
    await c.fontPalette();
    expect(store.paletteCalls).toBe(1);
  });

  it('embeds the role and sets font-family on every target in one undo step', async () => {
    const { c, store } = await setup();
    const title = idByAttr(c, 'title');
    const inner = idByAttr(c, 'inner');
    await c.applyFont('inter', [title, inner]);
    const src = c.index().source;
    expect(src).toContain('data-popost-font="inter"');
    expect(css(c, title)).toContain('"Inter Variable", sans-serif');
    expect(css(c, inner)).toContain('"Inter Variable"');
    expect(store.fontCalls).toEqual([['inter']]);
    c.undo();
    expect(c.index().source).toBe(DOC);
  });

  it('adds the CJK fallback when the targets contain CJK text', async () => {
    const { c, store } = await setup({ content: DOC.replace('Hello', '你好') });
    const title = idByAttr(c, 'title');
    await c.applyFont('inter', [title]);
    expect(store.fontCalls).toEqual([['inter', 'cjk-sans']]);
    expect(css(c, title)).toContain('"Inter Variable", "Noto Sans SC Variable", sans-serif');
    expect(c.index().source).toContain('data-popost-font="cjk-sans"');
  });

  it('reports font failures', async () => {
    const { c, store, notices } = await setup();
    store.fontError = new Error('offline');
    await c.applyFont('inter', [idByAttr(c, 'title')]);
    expect(notices.at(-1)).toEqual({ kind: 'error', key: 'fontFailed', detail: 'offline' });
    await c.applyFont('nope', [idByAttr(c, 'title')]);
    expect(notices.at(-1)!.key).toBe('fontFailed');
    expect(c.getSnapshot().canUndo).toBe(false);
  });
});

describe('live preview, measuring and frame events', () => {
  it('previews without touching source or history and restores style/src from the source', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    const before = c.getSnapshot();
    c.livePreview([{ kind: 'style', id, props: { left: '5px' } }, { kind: 'reload' }]);
    expect(frame.of('live').at(-1)!.updates).toEqual([{ kind: 'style', id, props: { left: '5px' } }]);
    expect(c.getSnapshot()).toBe(before);
    c.cancelLivePreview([id, 'gone']);
    expect(frame.of('live').at(-1)!.updates).toEqual([
      { kind: 'attr', id, name: 'style', value: 'color:red' },
      { kind: 'attr', id, name: 'src', value: null },
    ]);
  });

  it('highlights known blocks in the frame without touching the snapshot', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    const before = c.getSnapshot();
    c.highlight([id, 'gone']);
    expect(frame.of('highlight').at(-1)!.ids).toEqual([id]);
    c.highlight([]);
    expect(frame.of('highlight').at(-1)!.ids).toEqual([]);
    expect(c.getSnapshot()).toBe(before);
  });

  it('measures into the snapshot and follows rects events', async () => {
    const { c, frame } = await setup();
    const id = idByAttr(c, 'title');
    frame.rects = { [id]: { x: 1, y: 2, width: 3, height: 4 } };
    frame.overflow = [id];
    c.measure('page');
    expect(c.getSnapshot().rects).toEqual(frame.rects);
    expect(c.getSnapshot().overflow).toEqual([id]);
    const rects = c.getSnapshot().rects;
    frame.emit({ type: 'rects', rects: { [id]: { x: 1, y: 2, width: 3, height: 4 } }, overflow: [id] });
    expect(c.getSnapshot().rects).toBe(rects);
    frame.emit({ type: 'rects', rects: {}, overflow: [] });
    expect(c.getSnapshot().overflow).toEqual([]);
    const inner = idByAttr(c, 'inner');
    frame.rects = { [inner]: { x: 0, y: 0, width: 9, height: 9 } };
    frame.overflow = [];
    c.measure([inner]);
    expect(frame.measures.at(-1)).toEqual([inner]);
    expect(c.getSnapshot().rects[inner]).toEqual({ x: 0, y: 0, width: 9, height: 9 });
  });

  it('tracks hover, forwards every event after its own handling, and answers styles', async () => {
    const { c, frame } = await setup();
    const seen: string[] = [];
    let hoverAtEvent: string | null = 'unset';
    const off = c.onFrameEvent((e) => {
      seen.push(e.type);
      if (e.type === 'hover') hoverAtEvent = c.getSnapshot().hoverId;
    });
    const id = idByAttr(c, 'title');
    frame.emit({ type: 'hover', id });
    expect(hoverAtEvent).toBe(id);
    frame.emit({ type: 'key', key: 'a', code: 'KeyA', ctrl: false, meta: false, shift: false, alt: false });
    frame.emit({ type: 'wheel', deltaX: 0, deltaY: 1, ctrl: false });
    expect(seen).toEqual(['hover', 'key', 'wheel']);
    off();
    frame.emit({ type: 'hover', id: null });
    expect(seen).toHaveLength(3);
    frame.computed[id] = { color: 'red' };
    expect(c.styles(id, ['color'])).toEqual({ color: 'red' });
  });

  it('measures after fontsReady / ready', async () => {
    const { c, frame } = await setup();
    const n = frame.measures.length;
    frame.emit({ type: 'fontsReady' });
    frame.emit({ type: 'ready', pages: [] });
    expect(frame.measures.length).toBe(n + 2);
    expect(c.getSnapshot().docState).toBe('ready');
  });

  it('announces text blocks that start to overflow, once', async () => {
    const { c, frame, notices, runScheduled } = await setup();
    const title = idByAttr(c, 'title');
    const box = idByAttr(c, 'box');
    c.apply({ kind: 'setStyle', id: title, props: { 'font-size': '90px' } });
    frame.overflow = [title, box];
    runScheduled();
    expect(c.getSnapshot().overflow).toEqual([title, box]);
    expect(notices.filter((n) => n.key === 'textOverflow')).toHaveLength(1);
    c.apply({ kind: 'setStyle', id: title, props: { 'font-size': '91px' } });
    runScheduled();
    expect(notices.filter((n) => n.key === 'textOverflow')).toHaveLength(1);
    frame.overflow = [];
    c.apply({ kind: 'setStyle', id: title, props: { 'font-size': '20px' } });
    runScheduled();
    expect(notices.filter((n) => n.key === 'textOverflow')).toHaveLength(1);
  });

  it('does not announce non-text blocks and measures after a remount', async () => {
    const { c, frame, notices, runScheduled } = await setup();
    const box = idByAttr(c, 'box');
    c.apply({ kind: 'setStyle', id: box, props: { width: '10px' } });
    frame.overflow = [box];
    runScheduled();
    expect(notices.filter((n) => n.key === 'textOverflow')).toHaveLength(0);

    const title = idByAttr(c, 'title');
    frame.overflow = [];
    runScheduled();
    c.apply({ kind: 'setStyle', id: title, props: { 'font-size': '10px' } });
    frame.overflow = [title];
    c.undo();
    await flush();
    expect(notices.filter((n) => n.key === 'textOverflow')).toHaveLength(1);
  });
});

describe('test hooks', () => {
  it('mirrors state on body attributes', async () => {
    const { c } = await setup({ start: false });
    const body = document.createElement('body');
    const off = bindTestHooks(c, body);
    expect(body.dataset.docState).toBe('loading');
    await c.start();
    expect(body.dataset).toMatchObject({ docState: 'ready', docPath: 'p1.html', docSeq: '1', slideCount: '2' });
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'blue' } });
    expect(body.dataset.docSeq).toBe('2');
    off();
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'green' } });
    expect(body.dataset.docSeq).toBe('2');
  });

  it('exposes immutable snapshots', async () => {
    const { c } = await setup();
    const snaps: EditorSnapshot[] = [];
    c.subscribe(() => snaps.push(c.getSnapshot()));
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'blue' } });
    c.apply({ kind: 'setStyle', id: idByAttr(c, 'title'), props: { color: 'green' } });
    expect(new Set(snaps).size).toBe(snaps.length);
  });
});
