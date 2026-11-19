import type { HistoryEntry, Splice } from '../contracts';
import { composeSplices } from './splices';

export const MERGE_WINDOW_MS = 600;
export const MAX_HISTORY_ENTRIES = 300;

export interface HistoryOptions {
  /** Clock in milliseconds (injectable for tests). */
  now?: () => number;
  mergeWindowMs?: number;
  maxEntries?: number;
}

export type HistoryInput = Omit<HistoryEntry, 'at'> & { at?: number };

/** Undo/redo stacks of splice entries with time-window coalescing by `coalesceKey`. */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** The entry a following push may merge into; cleared by undo, redo, clear and `breakCoalescing`. */
  private open: HistoryEntry | null = null;
  private readonly now: () => number;
  private readonly mergeWindowMs: number;
  private readonly maxEntries: number;

  constructor(opts: HistoryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.mergeWindowMs = opts.mergeWindowMs ?? MERGE_WINDOW_MS;
    this.maxEntries = opts.maxEntries ?? MAX_HISTORY_ENTRIES;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
  get size(): number {
    return this.undoStack.length;
  }

  /** Record an applied edit. Clears the redo stack. */
  push(input: HistoryInput): void {
    const at = input.at ?? this.now();
    this.redoStack = [];
    const open = this.open;
    if (
      open &&
      input.coalesceKey !== undefined &&
      open.coalesceKey === input.coalesceKey &&
      this.undoStack[this.undoStack.length - 1] === open &&
      at - open.at <= this.mergeWindowMs
    ) {
      const merged = this.merge(open, input, at);
      this.undoStack[this.undoStack.length - 1] = merged;
      this.open = merged;
      if (merged.splices.length === 0) {
        this.undoStack.pop();
        this.open = null;
      }
      return;
    }
    const entry: HistoryEntry = { ...input, splices: [...input.splices], inverse: [...input.inverse], at };
    this.undoStack.push(entry);
    this.open = entry;
    if (this.undoStack.length > this.maxEntries) this.undoStack.splice(0, this.undoStack.length - this.maxEntries);
  }

  /** Pop the newest entry; the caller applies `entry.inverse`. */
  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop() ?? null;
    this.open = null;
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  /** Pop the newest undone entry; the caller applies `entry.splices`. */
  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop() ?? null;
    this.open = null;
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  /** End the current coalescing run (e.g. on pointer-up) so the next push starts a new step. */
  breakCoalescing(): void {
    this.open = null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
  }

  private merge(older: HistoryEntry, newer: HistoryInput, at: number): HistoryEntry {
    const splices: Splice[] = composeSplices(older.splices, newer.splices);
    const inverse: Splice[] = composeSplices(newer.inverse, older.inverse);
    return { label: newer.label, splices, inverse, coalesceKey: older.coalesceKey, at };
  }
}
