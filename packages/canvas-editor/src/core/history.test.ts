import { describe, expect, it } from 'vitest';
import type { DocIndex, EditOp, Splice } from '../contracts';
import { applyOp, applySplices, applySplicesToIndex } from './edits';
import { History, MAX_HISTORY_ENTRIES, MERGE_WINDOW_MS } from './history';
import { parseIndex } from './source';
import { makeCtx } from './test-fixtures';

function clock(start = 1000): { now(): number; tick(ms: number): void } {
  let t = start;
  return { now: () => t, tick: (ms) => void (t += ms) };
}

const entry = (label: string, key?: string): Parameters<History['push']>[0] => ({
  label,
  splices: [{ start: 0, end: 0, text: label }],
  inverse: [{ start: 0, end: label.length, text: '' }],
  coalesceKey: key,
});

describe('History basics', () => {
  it('starts empty', () => {
    const h = new History();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
    expect(h.undoLabel).toBeNull();
    expect(h.redoLabel).toBeNull();
    expect(h.size).toBe(0);
  });

  it('undoes and redoes in order with labels', () => {
    const h = new History({ now: clock().now });
    h.push(entry('a'));
    h.push(entry('b'));
    expect([h.canUndo, h.canRedo, h.undoLabel, h.redoLabel]).toEqual([true, false, 'b', null]);
    expect(h.undo()?.label).toBe('b');
    expect([h.canUndo, h.canRedo, h.undoLabel, h.redoLabel]).toEqual([true, true, 'a', 'b']);
    expect(h.undo()?.label).toBe('a');
    expect(h.canUndo).toBe(false);
    expect(h.redo()?.label).toBe('a');
    expect(h.redo()?.label).toBe('b');
    expect(h.canRedo).toBe(false);
    expect(h.size).toBe(2);
  });

  it('clears the redo stack on a new push', () => {
    const h = new History();
    h.push(entry('a'));
    h.push(entry('b'));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.push(entry('c'));
    expect(h.canRedo).toBe(false);
    expect(h.undoLabel).toBe('c');
  });

  it('stamps entries with the clock unless `at` is given', () => {
    const c = clock(5);
    const h = new History({ now: c.now });
    h.push(entry('a'));
    h.push({ ...entry('b'), at: 99 });
    expect(h.undo()?.at).toBe(99);
    expect(h.undo()?.at).toBe(5);
  });

  it('clear() empties both stacks', () => {
    const h = new History();
    h.push(entry('a'));
    h.undo();
    h.clear();
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
  });

  it('does not alias the caller arrays', () => {
    const h = new History();
    const e = entry('a');
    h.push(e);
    e.splices.push({ start: 9, end: 9, text: 'z' });
    expect(h.undo()?.splices).toHaveLength(1);
  });

  it('keeps replaceDocument as an ordinary undoable entry', () => {
    const h = new History();
    h.push({ label: 'replaceDocument', splices: [{ start: 0, end: 3, text: 'new' }], inverse: [{ start: 0, end: 3, text: 'old' }] });
    expect(h.canUndo).toBe(true);
    expect(h.undo()?.inverse[0].text).toBe('old');
  });

  it('limits the stack to 300 entries, dropping the oldest', () => {
    expect(MAX_HISTORY_ENTRIES).toBe(300);
    const h = new History();
    for (let i = 0; i < 305; i++) h.push(entry(`e${i}`));
    expect(h.size).toBe(300);
    let last = '';
    let count = 0;
    for (let e = h.undo(); e; e = h.undo()) {
      last = e.label;
      count++;
    }
    expect(count).toBe(300);
    expect(last).toBe('e5');
    const small = new History({ maxEntries: 2 });
    small.push(entry('a'));
    small.push(entry('b'));
    small.push(entry('c'));
    expect(small.size).toBe(2);
  });
});

describe('History coalescing', () => {
  it('merges same-key entries within the window and extends the window on each push', () => {
    expect(MERGE_WINDOW_MS).toBe(600);
    const c = clock();
    const h = new History({ now: c.now });
    h.push(entry('a', 'drag'));
    c.tick(500);
    h.push(entry('b', 'drag'));
    c.tick(500);
    h.push(entry('c', 'drag'));
    expect(h.size).toBe(1);
    expect(h.undoLabel).toBe('c');
  });

  it('starts a new entry after the window, for a different key, or without a key', () => {
    const c = clock();
    const h = new History({ now: c.now });
    h.push(entry('a', 'k'));
    c.tick(601);
    h.push(entry('b', 'k'));
    expect(h.size).toBe(2);
    c.tick(10);
    h.push(entry('c', 'other'));
    expect(h.size).toBe(3);
    h.push(entry('d'));
    h.push(entry('e'));
    expect(h.size).toBe(5);
  });

  it('merges exactly at the window boundary', () => {
    const c = clock();
    const h = new History({ now: c.now, mergeWindowMs: 600 });
    h.push(entry('a', 'k'));
    c.tick(600);
    h.push(entry('b', 'k'));
    expect(h.size).toBe(1);
  });

  it('does not merge across undo/redo or an explicit break', () => {
    const c = clock();
    const h = new History({ now: c.now });
    h.push(entry('a', 'k'));
    h.push(entry('x', 'k')); // merged into the first
    h.undo();
    h.redo();
    h.push(entry('b', 'k'));
    expect(h.size).toBe(2);
    h.breakCoalescing();
    h.push(entry('c', 'k'));
    expect(h.size).toBe(3);
  });

  it('does not merge into an older entry after an undo followed by a push', () => {
    const c = clock();
    const h = new History({ now: c.now });
    h.push(entry('a', 'k'));
    h.push(entry('plain'));
    h.undo();
    h.push(entry('b', 'k'));
    expect(h.size).toBe(2);
  });

  it('clears the redo stack when merging', () => {
    const c = clock();
    const h = new History({ now: c.now });
    h.push(entry('a', 'k'));
    h.push(entry('b', 'k'));
    h.push(entry('c', 'k'));
    expect(h.canRedo).toBe(false);
  });

  it('drops an entry whose merged effect is empty', () => {
    const c = clock();
    const h = new History({ now: c.now });
    h.push({ label: 'a', splices: [{ start: 0, end: 0, text: 'XY' }], inverse: [{ start: 0, end: 2, text: '' }], coalesceKey: 'k' });
    h.push({ label: 'b', splices: [{ start: 0, end: 2, text: '' }], inverse: [{ start: 0, end: 0, text: 'XY' }], coalesceKey: 'k' });
    expect(h.canUndo).toBe(false);
  });
});

describe('History with real edits', () => {
  const setup = (): { h: History; clock: ReturnType<typeof clock>; state: { index: DocIndex }; ctx: ReturnType<typeof makeCtx> } => {
    const ctx = makeCtx();
    const c = clock();
    return { h: new History({ now: c.now }), clock: c, state: { index: parseIndex('<p style="left:0px">a</p><i>b</i>', ctx) }, ctx };
  };
  const doOp = (s: ReturnType<typeof setup>, op: EditOp, key?: string): void => {
    const r = applyOp(s.state.index, op, s.ctx);
    s.state.index = r.index;
    s.h.push({ label: op.kind, splices: r.splices, inverse: r.inverse, coalesceKey: key });
  };
  const undo = (s: ReturnType<typeof setup>): void => {
    const e = s.h.undo()!;
    s.state.index = applySplicesToIndex(s.state.index, e.inverse, s.ctx).index;
  };
  const redo = (s: ReturnType<typeof setup>): void => {
    const e = s.h.redo()!;
    s.state.index = applySplicesToIndex(s.state.index, e.splices, s.ctx).index;
  };

  it('a coalesced drag undoes in one step and redoes to the final state', () => {
    const s = setup();
    const original = s.state.index.source;
    const p = [...s.state.index.elements.values()].find((e) => e.tag === 'p')!;
    for (let i = 1; i <= 20; i++) {
      doOp(s, { kind: 'setStyle', id: p.id, props: { left: `${i * 7}px`, top: `${i}px` } }, `drag:${p.id}`);
      s.clock.tick(16);
    }
    const final = s.state.index.source;
    expect(final).toContain('left:140px; top: 20px');
    expect(s.h.size).toBe(1);
    undo(s);
    expect(s.state.index.source).toBe(original);
    expect(s.h.canUndo).toBe(false);
    redo(s);
    expect(s.state.index.source).toBe(final);
  });

  it('interleaved ops undo back to the exact original, and redo replays them', () => {
    const s = setup();
    const original = s.state.index.source;
    const find = (tag: string) => [...s.state.index.elements.values()].find((e) => e.tag === tag)!;
    doOp(s, { kind: 'setAttr', id: find('p').id, name: 'class', value: 'x' });
    doOp(s, { kind: 'duplicate', id: find('i').id });
    doOp(s, { kind: 'setInnerHTML', id: find('p').id, html: '<b>new</b>' });
    doOp(s, { kind: 'remove', id: find('i').id });
    doOp(s, { kind: 'upsertFontStyle', key: 'k', css: 'a{}' });
    const final = s.state.index.source;
    const states: string[] = [];
    while (s.h.canUndo) {
      undo(s);
      states.push(s.state.index.source);
    }
    expect(s.state.index.source).toBe(original);
    expect(states).toHaveLength(5);
    while (s.h.canRedo) redo(s);
    expect(s.state.index.source).toBe(final);
  });

  it('coalesced entries compose splices that apply to the right text', () => {
    const s = setup();
    const original = s.state.index.source;
    const p = [...s.state.index.elements.values()].find((e) => e.tag === 'p')!;
    doOp(s, { kind: 'setStyle', id: p.id, props: { left: '10px' } }, 'k');
    doOp(s, { kind: 'setStyle', id: p.id, props: { left: '1000px', top: '5px' } }, 'k');
    doOp(s, { kind: 'setStyle', id: p.id, props: { top: null } }, 'k');
    const entry = s.h.undo()!;
    const after = s.state.index.source;
    expect(applySplices(original, entry.splices)).toBe(after);
    expect(applySplices(after, entry.inverse)).toBe(original);
    const spl: Splice[] = entry.splices;
    expect(spl.length).toBeGreaterThan(0);
  });
});

