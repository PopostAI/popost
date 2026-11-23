/** The pure parts of edit mode: the operations of /api/edit, and the page's span, snap, box and operation helpers. */
import { describe, expect, it } from 'vitest';
import type { Resolved } from '../../src/video/types';
import { applyOp, labelOf, parsePath, readOp, type EditOp } from '../../src/video/preview/edit/ops';
import { dragResult } from '../../src/video/preview/shell/edit/lanes-edit';
import { draggedBox } from '../../src/video/preview/shell/edit/stage-edit';
import { opFor, snapFrame, spanFor } from '../../src/video/preview/shell/edit/source';

describe('edit operations (pure)', () => {
  const json = { tracks: [{ id: 't1', box: [0, 0, 1, 1] }, { id: 't2' }], note: 'x' };

  it('sets, inserts, removes and moves without changing the input', () => {
    const before = JSON.stringify(json);
    const set = applyOp(json, { op: 'set', path: ['tracks', 0, 'box', 2], value: 0.5 });
    expect('json' in set && (set.json as typeof json).tracks[0]?.box).toEqual([0, 0, 0.5, 1]);
    const added = applyOp(json, { op: 'set', path: ['tracks', 1, 'text'], value: 'new' });
    expect('json' in added && (added.json as { tracks: unknown[] }).tracks[1]).toEqual({ id: 't2', text: 'new' });
    const inserted = applyOp(json, { op: 'insert', path: ['tracks', 2], value: { id: 't3' } });
    expect('json' in inserted && (inserted.json as typeof json).tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    const removed = applyOp(json, { op: 'remove', path: ['tracks', 0] });
    expect('json' in removed && (removed.json as typeof json).tracks.map((t) => t.id)).toEqual(['t2']);
    const unset = applyOp(json, { op: 'remove', path: ['note'] });
    expect('json' in unset && unset.json).toEqual({ tracks: json.tracks });
    const moved = applyOp(json, { op: 'move', path: ['tracks', 0], to: 1 });
    expect('json' in moved && (moved.json as typeof json).tracks.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(JSON.stringify(json)).toBe(before);
  });

  it('refuses a path that leaves the shape it walks, with a message and a fix', () => {
    const cases: EditOp[] = [
      { op: 'set', path: ['tracks', 5, 'box'], value: 1 },
      { op: 'set', path: ['tracks', 'x'], value: 1 },
      { op: 'set', path: ['tracks', 0, 'box', 'x'], value: 1 },
      { op: 'set', path: ['note', 'deeper'], value: 1 },
      { op: 'set', path: ['tracks', 2], value: {} },
      { op: 'insert', path: ['tracks', 0, 'id'], value: 1 },
      { op: 'remove', path: ['tracks', 0, 'nothing'] },
      { op: 'move', path: ['tracks', 0], to: 2 },
    ];
    for (const op of cases) {
      const r = applyOp(json, op);
      expect('problem' in r, JSON.stringify(op)).toBe(true);
      if ('problem' in r) expect([r.problem.level, r.problem.message.length > 10, Boolean(r.problem.fix)], JSON.stringify(op)).toEqual(['error', true, true]);
    }
    expect('problem' in readOp({ op: 'set', path: ['__proto__', 'polluted'], value: 1 })).toBe(true);
    expect('problem' in readOp({ op: 'set', path: [], value: 1 })).toBe(true);
    expect('problem' in readOp({ op: 'set', path: ['tracks', -1], value: 1 })).toBe(true);
    expect('problem' in readOp({ op: 'replace', path: ['note'], value: 1 })).toBe(true);
    expect('problem' in readOp({ op: 'set', path: ['note'] })).toBe(true);
  });

  it('reads text paths and names what an operation touched by its id', () => {
    expect(parsePath('tracks[2].during.segment')).toEqual(['tracks', 2, 'during', 'segment']);
    expect(parsePath('tracks[2]..x')).toBeUndefined();
    expect(labelOf(json, ['tracks', 0, 'box'])).toBe('t1.box');
    expect(labelOf(json, ['tracks', 0, 'box', 2])).toBe('t1.box[2]');
    expect(labelOf(json, ['note'])).toBe('note');
  });
});

describe('edit helpers of the page (pure)', () => {
  /** Two segments: a on 0..19, b on 20..39. */
  const timeline = { segments: [{ id: 'a', index: 0, start: 0, end: 20 }, { id: 'b', index: 1, start: 20, end: 40 }] } as unknown as Resolved;

  it('snaps an edge within 4 pixels and otherwise keeps whole frames', () => {
    const targets = [{ frame: 10, kind: 'playhead' as const }, { frame: 20, kind: 'segment' as const }];
    expect(snapFrame(11.5, targets, 2)).toEqual({ frame: 10, kind: 'playhead' });
    expect(snapFrame(13.4, targets, 2)).toEqual({ frame: 13, kind: 'frame' });
    expect(snapFrame(18.2, targets, 2)).toEqual({ frame: 20, kind: 'segment' });
    const moved = dragResult({ mode: 'move', start: 5, end: 15 }, 4.4, targets, 2);
    expect(moved).toEqual({ start: 10, end: 20, snap: { frame: 10, kind: 'playhead' } });
    expect(dragResult({ mode: 'end', start: 5, end: 15 }, -30, [], 20)).toMatchObject({ start: 5, end: 6 });
  });

  it('keeps a span in its segment while its start stays there, and moves it to the next one when not', () => {
    const span = { segment: 'a', from: 5, to: 15 };
    expect(spanFor(timeline, span, 3, 12)).toEqual({ segment: 'a', from: 3, to: 12 });
    expect(spanFor(timeline, span, 22, 30)).toEqual({ segment: 'b', from: 2, to: 10 });
    expect(spanFor(timeline, { ...span, note: 'kept' }, 15, 25)).toEqual({ segment: 'a', from: 15, to: 25, note: 'kept' });
  });

  it('sets a missing parent with the value inside it, and removes an emptied field', () => {
    const root = { tracks: [{ id: 't', enter: { preset: 'fade' } }] };
    expect(opFor(root, ['tracks', 0, 'enter', 'frames'], 8)).toEqual({ op: 'set', path: ['tracks', 0, 'enter', 'frames'], value: 8 });
    expect(opFor(root, ['tracks', 0, 'exit', 'preset'], 'pop')).toEqual({ op: 'set', path: ['tracks', 0, 'exit'], value: { preset: 'pop' } });
    expect(opFor(root, ['tracks', 0, 'enter'], undefined)).toEqual({ op: 'remove', path: ['tracks', 0, 'enter'] });
    expect(opFor(root, ['tracks', 0, 'exit'], undefined)).toBeUndefined();
  });

  it('moves and resizes a box by whole pixels of the canvas, Shift keeping its proportions', () => {
    const box0: [number, number, number, number] = [0.1, 0.7, 0.8, 0.05];
    const moved = draggedBox({ mode: 'move', box0 }, 0.0333, -0.01, 180, 320, false);
    expect(moved.map((v, i) => Math.round(v * (i % 2 ? 320 : 180) * 1000) / 1000)).toEqual([24, 221, 144, 16]);
    const wide = draggedBox({ mode: 'e', box0 }, 0.2, 0, 180, 320, true);
    const ratio = (b: number[]): number => ((b[2] ?? 0) * 180) / ((b[3] ?? 1) * 320);
    expect(Math.abs(ratio(wide) - ratio(box0))).toBeLessThan(0.1);
    const corner = draggedBox({ mode: 'nw', box0 }, -0.05, 0, 180, 320, false);
    expect([corner[0] * 180, corner[2] * 180].map(Math.round)).toEqual([9, 153]);
  });
});
