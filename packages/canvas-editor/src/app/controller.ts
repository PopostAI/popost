import { ConflictError } from '../contracts';
import type {
  CloudAdapter,
  DocIndex,
  DocStore,
  EditOp,
  EditorController,
  EditorSnapshot,
  FontPalette,
  FrameController,
  FrameToShell,
  HostParams,
  LiveUpdate,
  NodeId,
  Notice,
  NoticeKey,
  PageInfo,
  Rect,
  ShellToFrame,
  Splice,
  TextFormat,
} from '../contracts';
import { EditError, applyOp, applySplicesToIndex } from '../core/edits';
import type { EditContext } from '../core/edits';
import { History } from '../core/history';
import { createIdSource } from '../core/ids';
import { blockKind, DEFAULT_PAGE_SIZE, detectPages, pageOf, pageRoots, selectableBlocks } from '../core/pages';
import { getAttr, parseIndex, textContent } from '../core/source';
import { composeSplices } from '../core/splices';
import { exceedsLimit, validateSource } from '../core/validate';
import { DownloadError } from '../host/download';
import { selectFont, UNKNOWN_FONT_ERROR } from '../fonts/palette';
import type { PaletteRole } from '../fonts/palette';
import { buildFormatOps, formatCoalesceKey } from './format';
import { downloadTextFile, exportFileName, makeStaticHtml } from './static-html';

export interface EditorDeps {
  store: DocStore;
  frame: FrameController;
  params: HostParams;
  now?: () => number;
  randomHex?: (length: number) => string;
  schedule?: (fn: () => void) => void;
}

export interface EditorHandle extends EditorController {
  /** Load the document (docState loading, then ready or error). */
  start(): Promise<void>;
  dispose(): void;
}

/** `EditorSnapshot.error` value when the document has no `.slide` page (the UI maps it to text). */
export const ERROR_NO_PAGES = 'no-pages';

const defaultSchedule = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else queueMicrotask(fn);
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function sameRects(a: Readonly<Record<NodeId, Rect>>, b: Readonly<Record<NodeId, Rect>>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k] as Rect;
    const y = b[k];
    return y !== undefined && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height;
  });
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

function samePage(a: PageInfo, b: PageInfo): boolean {
  return a.id === b.id && a.pageKey === b.pageKey && a.name === b.name && a.width === b.width && a.height === b.height;
}

export function createEditorController(deps: EditorDeps): EditorHandle {
  return new Controller(deps);
}

class Controller implements EditorHandle {
  private readonly store: DocStore;

  get cloud(): CloudAdapter | undefined {
    return this.store.cloud;
  }
  private readonly frame: FrameController;
  private readonly params: HostParams;
  private readonly schedule: (fn: () => void) => void;
  private readonly history: History;
  private readonly ids = createIdSource();
  private readonly ctx: EditContext;

  private idx: DocIndex;
  private savedSource = '';
  private rev = '';
  private snap: EditorSnapshot;

  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(n: Notice) => void>();
  private readonly frameListeners = new Set<(e: FrameToShell) => void>();

  private iframe: HTMLIFrameElement | null = null;
  private frameOff: (() => void) | null = null;
  private mounted = false;
  private mountToken = 0;

  private overflowBase: readonly NodeId[] | null = null;
  private measureQueued = false;
  private savePromise: Promise<void> | null = null;
  private palette: Promise<FontPalette> | null = null;
  private disposed = false;

  constructor(deps: EditorDeps) {
    this.store = deps.store;
    this.frame = deps.frame;
    this.params = deps.params;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.history = new History({ now: deps.now });
    this.ctx = { newId: () => this.ids.newId(), randomHex: deps.randomHex };
    this.idx = parseIndex('', this.ids);
    this.snap = {
      docState: 'loading',
      error: null,
      mode: deps.store.mode,
      name: deps.params.name ?? '',
      path: '',
      pages: [],
      currentPageId: null,
      selection: [],
      hoverId: null,
      editingTextId: null,
      textState: null,
      rects: {},
      overflow: [],
      saveState: 'saved',
      canUndo: false,
      canRedo: false,
      conflict: false,
      sourceVersion: 0,
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Store plumbing                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  getSnapshot = (): EditorSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Merge a patch into the snapshot; a new object (and one notification) only when something differs. */
  private set(patch: Partial<EditorSnapshot>): void {
    const next = { ...this.snap, ...patch, canUndo: this.history.canUndo, canRedo: this.history.canRedo };
    const keys = Object.keys(next) as Array<keyof EditorSnapshot>;
    if (keys.every((k) => next[k] === this.snap[k])) return;
    this.snap = next;
    for (const l of [...this.listeners]) l();
  }

  private notify(kind: Notice['kind'], key: NoticeKey, detail?: string): void {
    const notice: Notice = detail === undefined ? { kind, key } : { kind, key, detail };
    for (const l of [...this.noticeListeners]) l(notice);
  }

  onNotice = (listener: (notice: Notice) => void): (() => void) => {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  };

  onFrameEvent = (listener: (event: FrameToShell) => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  index = (): DocIndex => this.idx;

  pageSize = (): { width: number; height: number } => {
    const page = this.snap.pages.find((p) => p.id === this.snap.currentPageId);
    return page ? { width: page.width, height: page.height } : { ...DEFAULT_PAGE_SIZE };
  };

  private get ready(): boolean {
    return this.snap.docState === 'ready';
  }

  private dirtyState(): EditorSnapshot['saveState'] {
    if (this.snap.saveState === 'saving') return 'saving';
    return this.idx.source === this.savedSource ? 'saved' : 'dirty';
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Load / reload                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  async start(): Promise<void> {
    this.set({ docState: 'loading', error: null });
    await this.loadDocument(null);
  }

  async reload(): Promise<void> {
    if (this.snap.editingTextId) this.endTextEdit(false);
    while (this.savePromise) await this.savePromise;
    const pos = this.snap.pages.findIndex((p) => p.id === this.snap.currentPageId);
    await this.loadDocument(pos < 0 ? 0 : pos);
  }

  externalChange = async (): Promise<void> => {
    if (!this.ready) return;
    while (this.savePromise) await this.savePromise;
    if (this.snap.editingTextId || this.idx.source !== this.savedSource) this.set({ conflict: true });
    else await this.reload();
  };

  /** `keepPage`: page position to keep (reload) or null (first load). */
  private async loadDocument(keepPage: number | null): Promise<void> {
    try {
      const doc = await this.store.load();
      if (this.disposed) return;
      const index = parseIndex(doc.content, this.ids);
      const pages = detectPages(index, { ratio: this.params.ratio });
      if (pages.length === 0) throw new Error(ERROR_NO_PAGES);
      this.idx = index;
      this.savedSource = doc.content;
      this.rev = doc.rev;
      this.history.clear();
      this.overflowBase = null;
      const page = pages[Math.min(keepPage ?? 0, pages.length - 1)] as PageInfo;
      this.set({
        docState: 'ready',
        error: null,
        name: doc.name,
        path: doc.path,
        pages,
        currentPageId: page.id,
        selection: [],
        hoverId: null,
        editingTextId: null,
        textState: null,
        rects: {},
        overflow: [],
        saveState: 'saved',
        conflict: false,
        sourceVersion: this.snap.sourceVersion + 1,
      });
      this.remount();
    } catch (error) {
      if (this.disposed) return;
      this.set({ docState: 'error', error: messageOf(error) });
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Frame lifecycle                                                                          */
  /* ---------------------------------------------------------------------------------------- */

  attachFrame = (iframe: HTMLIFrameElement | null): void => {
    if (iframe === null) {
      this.frameOff?.();
      this.frameOff = null;
      this.iframe = null;
      this.mounted = false;
      this.mountToken++;
      return;
    }
    if (iframe === this.iframe && this.frameOff) return;
    this.iframe = iframe;
    this.frameOff ??= this.frame.on((msg) => this.onFrame(msg));
    this.remount();
  };

  /** Rebuild the frame from the current index (new iframe, reload, structural edits). */
  private pendingTextEdit: (() => void) | null = null;

  private remount(): void {
    const iframe = this.iframe;
    if (!iframe || !this.ready || this.disposed) return;
    const token = ++this.mountToken;
    this.mounted = false;
    if (this.snap.editingTextId) this.set({ editingTextId: null, textState: null });
    const initialPage = this.snap.currentPageId;
    this.frame.mount(iframe, this.idx, { currentPageId: initialPage }).then(
      () => {
        if (token !== this.mountToken || this.disposed) return;
        this.mounted = true;
        const currentPage = this.snap.currentPageId;
        if (currentPage !== null && currentPage !== initialPage) this.frame.send({ type: 'currentPage', id: currentPage });
        const pending = this.pendingTextEdit;
        this.pendingTextEdit = null;
        pending?.();
        this.runMeasure();
      },
      (error: unknown) => {
        if (token !== this.mountToken || this.disposed) return;
        this.set({ docState: 'error', error: messageOf(error) });
      },
    );
  }

  private onFrame(msg: FrameToShell): void {
    switch (msg.type) {
      case 'ready':
      case 'fontsReady':
        if (this.mounted) this.runMeasure();
        break;
      case 'rects':
        this.setMeasure(msg.rects, msg.overflow);
        break;
      case 'hover':
        this.set({ hoverId: msg.id });
        break;
      case 'textState':
        if (msg.id === this.snap.editingTextId) {
          const prev = this.snap.textState;
          const same =
            prev &&
            prev.range === msg.range &&
            (['bold', 'italic', 'underline', 'strike'] as const).every((k) => !!prev.active[k] === !!msg.active[k]);
          if (!same) this.set({ textState: { range: msg.range, active: msg.active } });
        }
        break;
      case 'textCommit':
        if (msg.id === this.snap.editingTextId) {
          this.set({ editingTextId: null, textState: null });
          this.runOps([{ kind: 'setInnerHTML', id: msg.id, html: msg.html }], 'text');
        }
        break;
      case 'textCancel':
        if (msg.id === this.snap.editingTextId) this.set({ editingTextId: null, textState: null });
        break;
      default:
        break;
    }
    for (const l of [...this.frameListeners]) l(msg);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Measuring                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  private setMeasure(rects: Record<NodeId, Rect>, overflow: readonly NodeId[]): void {
    this.set({
      rects: sameRects(this.snap.rects, rects) ? this.snap.rects : rects,
      overflow: sameList(this.snap.overflow, overflow) ? this.snap.overflow : overflow,
    });
  }

  private markOverflowBase(): void {
    this.overflowBase ??= this.snap.overflow;
  }

  private scheduleMeasure(): void {
    this.markOverflowBase();
    if (this.measureQueued) return;
    this.measureQueued = true;
    this.schedule(() => {
      this.measureQueued = false;
      if (this.mounted && !this.disposed) this.runMeasure();
    });
  }

  /** Measure the whole current page; announces text blocks that started to overflow since the last baseline. */
  private runMeasure(): void {
    let result: { rects: Record<NodeId, Rect>; overflow: NodeId[] };
    try {
      result = this.frame.measure('page');
    } catch {
      return;
    }
    const base = this.overflowBase;
    this.overflowBase = null;
    this.setMeasure(result.rects, result.overflow);
    if (base && result.overflow.some((id) => !base.includes(id) && blockKind(this.idx, id) === 'text')) {
      this.notify('info', 'textOverflow');
    }
  }

  measure = (ids: NodeId[] | 'page'): void => {
    if (!this.mounted) return;
    if (ids === 'page') {
      this.runMeasure();
      return;
    }
    let result: { rects: Record<NodeId, Rect>; overflow: NodeId[] };
    try {
      result = this.frame.measure(ids);
    } catch {
      return;
    }
    const measured = new Set(ids);
    this.set({
      rects: { ...this.snap.rects, ...result.rects },
      overflow: [...this.snap.overflow.filter((id) => !measured.has(id)), ...result.overflow],
    });
  };

  styles = (id: NodeId, props: string[]): Record<string, string> => {
    if (!this.mounted) return {};
    try {
      return this.frame.styles(id, props);
    } catch {
      return {};
    }
  };

  /* ---------------------------------------------------------------------------------------- */
  /* Editing                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  apply = (op: EditOp, opts: { label?: string; coalesceKey?: string } = {}): void => {
    this.runOps([op], opts.label ?? op.kind, opts.coalesceKey);
  };

  applyBatch = (ops: EditOp[], label: string, opts: { coalesceKey?: string } = {}): void => {
    this.runOps(ops, label, opts.coalesceKey);
  };

  /** Apply ops on successive indexes as ONE history entry; all-or-nothing. Returns false when rejected. */
  private runOps(ops: EditOp[], label: string, coalesceKey?: string): boolean {
    if (!this.ready || ops.length === 0) return false;
    this.commitTextEdit();
    const start = this.idx;
    let index = start;
    let splices: Splice[] = [];
    let inverse: Splice[] = [];
    const live: LiveUpdate[] = [];
    let createdId: NodeId | undefined;
    try {
      ops.forEach((op, i) => {
        const r = applyOp(index, op, this.ctx);
        index = r.index;
        splices = i === 0 ? r.splices : composeSplices(splices, r.splices);
        inverse = i === 0 ? r.inverse : composeSplices(r.inverse, inverse);
        live.push(...r.live);
        if (r.createdId !== undefined) createdId = r.createdId;
      });
    } catch (error) {
      this.notify('error', 'editRejected', error instanceof EditError ? error.message : messageOf(error));
      return false;
    }
    if (index.source === start.source) return true;
    this.history.push({ label, splices, inverse, coalesceKey });
    this.install(index, live, createdId);
    return true;
  }

  undo = (): void => {
    this.step('undo');
  };

  redo = (): void => {
    this.step('redo');
  };

  private step(dir: 'undo' | 'redo'): void {
    if (!this.ready) return;
    this.commitTextEdit();
    const entry = dir === 'undo' ? this.history.undo() : this.history.redo();
    if (!entry) return;
    const r = applySplicesToIndex(this.idx, dir === 'undo' ? entry.inverse : entry.splices, this.ctx);
    this.install(r.index, r.live);
  }

  /**
   * Make `next` the current document: recompute pages, current page and selection, bump the version and
   * tell the frame (live updates, or a remount when asked to reload).
   */
  private install(next: DocIndex, live: LiveUpdate[], createdId?: NodeId): void {
    this.idx = next;
    const old = this.snap;
    const detected = detectPages(next, { ratio: this.params.ratio });
    const unchanged = detected.length === old.pages.length && detected.every((p, i) => samePage(p, old.pages[i] as PageInfo));
    const pages = unchanged ? old.pages : detected;

    let current = old.currentPageId;
    let pageChanged = false;
    if (!pages.some((p) => p.id === current)) {
      const pos = Math.max(0, old.pages.findIndex((p) => p.id === current));
      current = pages[Math.min(pos, pages.length - 1)]?.id ?? null;
      pageChanged = true;
    }

    let selection = old.selection.filter((id) => next.elements.has(id));
    if (createdId !== undefined && next.elements.has(createdId)) {
      const page = pageOf(next, createdId);
      if (page !== null && page !== createdId && selectableBlocks(next, page).includes(createdId)) {
        selection = [createdId];
        if (page !== current) {
          current = page;
          pageChanged = true;
        }
      }
    }
    if (selection.length === old.selection.length && selection.every((id, i) => id === old.selection[i])) selection = old.selection as NodeId[];

    this.markOverflowBase();
    this.set({
      pages,
      currentPageId: current,
      selection,
      hoverId: old.hoverId !== null && next.elements.has(old.hoverId) ? old.hoverId : null,
      sourceVersion: old.sourceVersion + 1,
      saveState: this.snap.saveState === 'saving' ? 'saving' : next.source === this.savedSource ? 'saved' : 'dirty',
    });
    if (!this.iframe) return;
    if (!this.mounted || live.some((u) => u.kind === 'reload')) {
      this.remount();
      return;
    }
    if (live.length) this.frame.send({ type: 'live', updates: live });
    if (pageChanged && current !== null) this.frame.send({ type: 'currentPage', id: current });
    this.scheduleMeasure();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Selection and pages                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  select = (ids: NodeId[], opts: { additive?: boolean } = {}): void => {
    if (!this.ready) return;
    const roots = new Set(pageRoots(this.idx).map((el) => el.id));
    const valid = [...new Set(ids)].filter((id) => this.idx.elements.has(id) && !roots.has(id));
    const cur = this.snap.selection;
    let next: NodeId[];
    let added: NodeId[];
    if (opts.additive) {
      next = [...cur];
      added = [];
      for (const id of valid) {
        const at = next.indexOf(id);
        if (at >= 0) next.splice(at, 1);
        else {
          next.push(id);
          added.push(id);
        }
      }
    } else {
      next = valid;
      added = valid;
    }
    if (this.snap.editingTextId && !(next.length === 1 && next[0] === this.snap.editingTextId)) this.commitTextEdit();
    const target = added.length ? pageOf(this.idx, added[0] as NodeId) : null;
    if (target !== null && target !== this.snap.currentPageId) {
      this.switchPage(target);
      next = next.filter((id) => pageOf(this.idx, id) === target);
    }
    if (sameList(next, cur)) return;
    this.history.breakCoalescing();
    this.set({ selection: next });
  };

  selectParent = (): void => {
    const first = this.snap.selection[0];
    const page = this.snap.currentPageId;
    if (!this.ready || first === undefined || page === null) return;
    const blocks = new Set(selectableBlocks(this.idx, page));
    for (let cur = this.idx.elements.get(first)?.parent ?? null; cur !== null && cur !== page; cur = this.idx.elements.get(cur)?.parent ?? null) {
      if (blocks.has(cur)) {
        this.select([cur]);
        return;
      }
    }
  };

  setCurrentPage = (id: NodeId): void => {
    if (!this.ready || id === this.snap.currentPageId || !this.snap.pages.some((p) => p.id === id)) return;
    this.switchPage(id);
  };

  /** Switch the current page (clears selection, tells the frame, re-measures). */
  private switchPage(id: NodeId): void {
    this.commitTextEdit();
    this.history.breakCoalescing();
    this.set({ currentPageId: id, selection: [], hoverId: null, rects: {}, overflow: [] });
    this.overflowBase = null;
    if (this.mounted) {
      this.frame.send({ type: 'currentPage', id });
      this.runMeasure();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Text editing and formatting                                                              */
  /* ---------------------------------------------------------------------------------------- */

  beginTextEdit = (id: NodeId, caret: 'end' | 'all' | { x: number; y: number } = 'end'): void => {
    const msg: ShellToFrame =
      typeof caret === 'string' ? { type: 'beginTextEdit', id, caret } : { type: 'beginTextEdit', id, caret: 'point', x: caret.x, y: caret.y };
    if (!this.ready || !this.idx.elements.has(id)) return;
    if (!this.mounted) {
      this.pendingTextEdit = () => {
        if (this.snap.selection[0] === id) this.beginTextEdit(id, caret);
      };
      return;
    }
    if (this.snap.editingTextId === id) return;
    this.commitTextEdit();
    const page = pageOf(this.idx, id);
    if (page !== null && page !== this.snap.currentPageId) this.switchPage(page);
    this.set({ selection: [id], editingTextId: id, textState: null });
    this.frame.send(msg);
  };

  endTextEdit = (commit: boolean): void => {
    if (!this.snap.editingTextId) return;
    if (this.mounted) this.frame.send({ type: 'endTextEdit', commit });
    // The frame answers synchronously with textCommit / textCancel; leave edit mode if it did not.
    if (this.snap.editingTextId) this.set({ editingTextId: null, textState: null });
  };

  private commitTextEdit(): void {
    if (this.snap.editingTextId) this.endTextEdit(true);
  }

  format = (format: TextFormat): void => {
    if (!this.ready) return;
    const editing = this.snap.editingTextId;
    if (editing && this.snap.textState?.range) {
      this.frame.send({ type: 'format', format });
      return;
    }
    const targets = (editing ? [editing] : this.snap.selection).filter((id) => this.idx.elements.has(id));
    if (targets.length === 0) return;
    this.commitTextEdit();
    const ops = buildFormatOps(format, targets, this.styles);
    this.runOps(ops, `format:${format.command}`, formatCoalesceKey(format, targets));
  };

  highlight = (ids: NodeId[]): void => {
    if (this.mounted) this.frame.send({ type: 'highlight', ids: ids.filter((id) => this.idx.elements.has(id)) });
  };

  /* ---------------------------------------------------------------------------------------- */
  /* Live preview                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  livePreview = (updates: LiveUpdate[]): void => {
    const safe = updates.filter((u) => u.kind !== 'reload');
    if (this.mounted && safe.length) this.frame.send({ type: 'live', updates: safe });
  };

  cancelLivePreview = (ids: NodeId[]): void => {
    const updates: LiveUpdate[] = [];
    for (const id of ids) {
      const el = this.idx.elements.get(id);
      if (!el) continue;
      updates.push({ kind: 'attr', id, name: 'style', value: getAttr(el, 'style') });
      updates.push({ kind: 'attr', id, name: 'src', value: getAttr(el, 'src') });
    }
    this.livePreview(updates);
  };

  /* ---------------------------------------------------------------------------------------- */
  /* Save                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  save = async (opts: { force?: boolean } = {}): Promise<void> => {
    if (!this.ready) return;
    const force = opts.force === true;
    this.commitTextEdit();
    if (this.snap.conflict && !force) return;
    while (this.savePromise) await this.savePromise;
    if (!force && this.idx.source === this.savedSource) return;
    if (this.snap.conflict && !force) return;
    const run = this.runSave(force);
    this.savePromise = run;
    try {
      await run;
    } finally {
      if (this.savePromise === run) this.savePromise = null;
    }
  };

  private async runSave(force: boolean): Promise<void> {
    const content = this.idx.source;
    if (exceedsLimit(content)) {
      this.set({ saveState: 'error' });
      this.notify('error', 'saveFailed', 'too-large');
      return;
    }
    this.set({ saveState: 'saving' });
    try {
      const result = await this.store.save(content, { rev: this.rev, force });
      this.rev = result.rev;
      this.savedSource = content;
      this.set({ saveState: this.idx.source === content ? 'saved' : 'dirty', conflict: false });
    } catch (error) {
      const conflict = error instanceof ConflictError || (error as { status?: number } | null)?.status === 409;
      if (conflict) this.set({ saveState: 'dirty', conflict: true });
      else {
        this.set({ saveState: 'error' });
        this.notify('error', 'saveFailed', messageOf(error));
      }
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Document-level actions                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  resetToInitial = async (): Promise<void> => {
    if (!this.ready) return;
    this.commitTextEdit();
    let initial;
    try {
      initial = await this.store.initial();
    } catch (error) {
      this.notify('error', 'resetUnavailable', messageOf(error));
      return;
    }
    if (!initial.available) {
      this.notify('info', 'resetUnavailable');
      return;
    }
    if (this.runOps([{ kind: 'replaceDocument', source: initial.content }], 'reset')) this.notify('info', 'resetDone');
  };

  replaceSource = (source: string): string | null => {
    if (!this.ready) return 'not-ready';
    const result = validateSource(source);
    if (!result.ok) return result.code;
    return this.runOps([{ kind: 'replaceDocument', source }], 'code') ? null : 'rejected';
  };

  uploadImage: EditorController['uploadImage'] = async (file) => {
    if (!this.store.uploadImage) throw new Error('Project asset upload unavailable');
    const result = await this.store.uploadImage(file, { rev: this.rev });
    this.rev = result.rev;
    return result.image;
  };

  downloadAll = async (): Promise<void> => {
    if (!this.ready) return;
    this.commitTextEdit();
    while (this.savePromise) await this.savePromise;
    const content = this.idx.source;
    try {
      const result = await this.store.downloadAll(content, { rev: this.rev });
      this.rev = result.rev;
      if (this.store.mode === 'local') {
        this.savedSource = content;
        this.set({ saveState: this.dirtyState(), conflict: false });
      }
      this.notify('info', 'downloadDone');
    } catch (error) {
      this.notify('error', 'downloadFailed', error instanceof DownloadError ? error.message : messageOf(error));
    }
  };

  exportHTML = (): void => {
    if (!this.ready) return;
    this.commitTextEdit();
    try {
      downloadTextFile(exportFileName(this.snap.name), makeStaticHtml(this.idx.source));
    } catch (error) {
      this.notify('error', 'downloadFailed', messageOf(error));
    }
  };

  /* ---------------------------------------------------------------------------------------- */
  /* Fonts                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  fontPalette = (): Promise<FontPalette> => {
    if (!this.palette) {
      this.palette = this.store.fontPalette().catch((error: unknown) => {
        this.palette = null;
        throw error;
      });
    }
    return this.palette;
  };

  applyFont = async (roleId: string, targetIds: NodeId[]): Promise<void> => {
    if (!this.ready) return;
    this.commitTextEdit();
    try {
      const roles = (await this.fontPalette()).roles as PaletteRole[];
      const role = roles.find((r) => r.id === roleId);
      if (!role) throw new Error(UNKNOWN_FONT_ERROR);
      const targets = targetIds.filter((id) => this.idx.elements.has(id));
      if (targets.length === 0) return;
      const text = targets.map((id) => textContent(this.idx, id)).join('\n');
      const choice = selectFont(roles, role.family, text);
      const embedded = await this.store.fontCSS(choice.needed.map((r) => r.id), { rev: this.rev });
      this.rev = embedded.rev;
      const ops: EditOp[] = choice.needed.map((r) => {
        const css = embedded.css[r.id];
        if (css === undefined) throw new Error(`Missing font CSS: ${r.id}`);
        return { kind: 'upsertFontStyle', key: r.id, css };
      });
      for (const id of targets.filter((t) => this.idx.elements.has(t))) {
        ops.push({ kind: 'setStyle', id, props: { 'font-family': choice.stack } });
      }
      this.runOps(ops, 'font');
    } catch (error) {
      this.notify('error', 'fontFailed', messageOf(error));
    }
  };

  /* ---------------------------------------------------------------------------------------- */

  dispose(): void {
    this.disposed = true;
    this.mountToken++;
    this.mounted = false;
    this.frameOff?.();
    this.frameOff = null;
    this.listeners.clear();
    this.noticeListeners.clear();
    this.frameListeners.clear();
    this.frame.dispose();
  }
}
