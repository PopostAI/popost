import type { ProjectImage } from './host/project-tools';
/**
 * Shared contracts of the Popost canvas editor.
 *
 * Every module implements or consumes the interfaces below; change them only together with
 * docs/editor-rewrite/SPEC.md. Behavioural compatibility requirements live in
 * docs/editor-rewrite/current-contracts.md (section 10.1) and SPEC.md.
 */

/* ------------------------------------------------------------------------------------------ */
/* Document source and stable element ids (core/source, core/ids)                            */
/* ------------------------------------------------------------------------------------------ */

/** Editor-only element id ("n1", "n2", …). Never written into saved HTML. */
export type NodeId = string;

/** A replacement of `source.slice(start, end)` with `text`. Offsets refer to the text BEFORE the edit. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

export interface AttrInfo {
  name: string;
  value: string;
  /** Range of the whole attribute (`name="value"`) in the source. */
  start: number;
  end: number;
}

export interface ElementInfo {
  id: NodeId;
  tag: string;
  /** Range of the whole element (start tag … end tag) in the source. */
  start: number;
  end: number;
  /** End of the start tag (exclusive) — where the element's content begins. */
  startTagEnd: number;
  /** Start of the end tag, or null for void / implicitly closed elements. */
  endTagStart: number | null;
  attrs: AttrInfo[];
  parent: NodeId | null;
  children: NodeId[];
}

/** Parsed, indexed view of one HTML document. Immutable; every edit produces a new index. */
export interface DocIndex {
  readonly source: string;
  readonly elements: ReadonlyMap<NodeId, ElementInfo>;
  /** Element ids in document order. */
  readonly order: readonly NodeId[];
  readonly html: NodeId | null;
  readonly head: NodeId | null;
  readonly body: NodeId | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Edit operations (core/edits)                                                               */
/* ------------------------------------------------------------------------------------------ */

export type EditOp =
  /** Replace the element's content (used for committed inline text edits). */
  | { kind: 'setInnerHTML'; id: NodeId; html: string }
  /** Merge declarations into the inline `style` attribute; `null` removes a property. */
  | { kind: 'setStyle'; id: NodeId; props: Readonly<Record<string, string | null>> }
  /** Set (string) or remove (null) one attribute. */
  | { kind: 'setAttr'; id: NodeId; name: string; value: string | null }
  | { kind: 'remove'; id: NodeId }
  /** Insert a copy right after the element. Copies of page roots get a fresh `data-popost-page`. */
  | { kind: 'duplicate'; id: NodeId }
  /** Move the element before `beforeId` inside `parentId` (`beforeId` null = append). */
  | { kind: 'move'; id: NodeId; parentId: NodeId; beforeId: NodeId | null }
  | { kind: 'insertHTML'; parentId: NodeId; beforeId: NodeId | null; html: string }
  /** Create or replace `<style data-popost-font="{key}">` at the end of `<head>`. */
  | { kind: 'upsertFontStyle'; key: string; css: string }
  /** Replace the whole document (code panel, reset to initial layout). */
  | { kind: 'replaceDocument'; source: string };

/** How the live edit frame should follow an applied edit. */
export type LiveUpdate =
  | { kind: 'style'; id: NodeId; props: Readonly<Record<string, string | null>> }
  | { kind: 'attr'; id: NodeId; name: string; value: string | null }
  /** Re-render these subtrees (outer HTML in preview form, i.e. with `data-pp-id`). */
  | { kind: 'subtrees'; items: ReadonlyArray<{ id: NodeId; previewHTML: string }> }
  | { kind: 'remove'; id: NodeId }
  | { kind: 'insert'; parentId: NodeId; beforeId: NodeId | null; previewHTML: string }
  | { kind: 'move'; id: NodeId; parentId: NodeId; beforeId: NodeId | null }
  | { kind: 'headStyle'; key: string; css: string }
  /** Anything else: rebuild the frame from the new source. */
  | { kind: 'reload' };

export interface EditResult {
  index: DocIndex;
  /** Splices applied to the old source (sorted, non-overlapping). */
  splices: Splice[];
  /** Splices that turn the new source back into the old one. */
  inverse: Splice[];
  live: LiveUpdate[];
  /** Id of the element created by `duplicate` / `insertHTML`, if any. */
  createdId?: NodeId;
}

/* ------------------------------------------------------------------------------------------ */
/* Pages (core/pages)                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface PageInfo {
  id: NodeId;
  /** `data-popost-page` value (local mode) or null. */
  pageKey: string | null;
  name: string;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Undo history (core/history)                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface HistoryEntry {
  label: string;
  splices: Splice[];
  inverse: Splice[];
  /** Consecutive entries with the same key within the merge window become one undo step. */
  coalesceKey?: string;
  at: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Storage (storage/*)                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface LoadedDoc {
  content: string;
  /** Opaque revision echoed on save (browser: `revs[id]` or "1"; local: `canvasRev`). */
  rev: string;
  /** Display name for the title bar and file names. */
  name: string;
  /** Logical path (`<id>.html` in browser mode, `pages/<projectId>.html` in local mode). */
  path: string;
}

export interface InitialDoc {
  content: string;
  available: boolean;
  reliable: boolean;
  source: string;
  createdAt: string;
}

export class ConflictError extends Error {
  readonly status = 409;
}

export interface FontRole {
  id: string;
  family: string;
  label: string;
  group: string;
  fallback: string;
  coverage?: unknown;
}

export interface FontPalette {
  roles: FontRole[];
}

/** One document store per editor session. Browser mode = IndexedDB, local mode = skill server. */
/** Cloud save of a local project (the skill server's `/api/cloud/*`); only the local store offers it. */
export type CloudMode = 'keyed' | 'anonymous';
export type CloudPhase = 'idle' | 'waiting' | 'uploading' | 'saved' | 'failed' | 'conflict';

export interface CloudStatus {
  ok: boolean;
  mode: CloudMode | 'off';
  state: CloudPhase;
  /** The project has local changes the web copy does not have. */
  dirty: boolean;
  deckId?: string;
  webUrl?: string;
  syncedAt?: string;
  error?: { code: string; message: string };
}

export interface CloudAdapter {
  readonly mode: CloudMode;
  status(): Promise<CloudStatus>;
  /** Anonymous mode: begin the login on the site; resolves with the address to open. */
  start(lang: 'zh' | 'en'): Promise<{ authorizeUrl: string; expiresAt: string }>;
  /** Sync now and resolve with the status after it; `force` overwrites web edits. A status with `ok: false` and `error.code` `LOGIN_REQUIRED` means `start` first. */
  push(opts?: { force?: boolean; lang?: 'zh' | 'en' }): Promise<CloudStatus>;
}

export interface DocStore {
  readonly mode: 'browser' | 'local';
  /** Present only when the skill server offers cloud save (`LocalBoot.cloud`); without it the editor shows no cloud button. */
  readonly cloud?: CloudAdapter;
  load(): Promise<LoadedDoc>;
  /** Throws ConflictError when `rev` is stale and `force` is not set. Returns the new revision. */
  save(content: string, opts: { rev: string; force?: boolean }): Promise<{ rev: string }>;
  initial(): Promise<InitialDoc>;
  /** URL to load into the edit frame for this (already preview-transformed) document. */
  preview(html: string, nonce: string): Promise<string>;
  fontPalette(): Promise<FontPalette>;
  uploadImage?(file: File, ctx: { rev: string }): Promise<{ image: ProjectImage; rev: string }>;
  /** CSS for `<style data-popost-font="{role.id}">` (and its CJK fallback when `needsCJK`). */
  fontCSS(roleIds: string[], ctx: { rev: string }): Promise<{ css: Record<string, string>; rev: string }>;
  /**
   * "Download all images" for the current content (browser: via the host app; local: forced save + export).
   * Returns the revision after the call (changes in local mode because of the save).
   */
  downloadAll(content: string, ctx: { rev: string }): Promise<{ rev: string }>;
}

/* ------------------------------------------------------------------------------------------ */
/* Host embedding (host/*) — see current-contracts.md §1                                      */
/* ------------------------------------------------------------------------------------------ */

export interface HostParams {
  popost: boolean;
  /** `<projectId>.html` in browser mode. */
  file: string | null;
  ratio: string | null;
  lang: 'zh' | 'en';
  name: string | null;
  embedded: boolean;
  theme: 'dark' | 'light' | null;
  /** `host`: the embedding page owns load/save/initial (M6/M7); `browser`: the shared IndexedDB. */
  store: 'browser' | 'host';
}

/** Injected by the skill server in local mode. */
export interface LocalBoot {
  projectId: string;
  width: number;
  height: number;
  name: string;
  /** True for a replicate project or one that records layout references. */
  comparison?: boolean;
  /** Cloud save offered by this server; absent means none. */
  cloud?: { mode: CloudMode };
}

/* ------------------------------------------------------------------------------------------ */
/* Edit frame (frame/*) — direct same-origin DOM access, see SPEC §6                          */
/* ------------------------------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Inline formatting applied inside the edit frame to the current text range (or the whole block). */
export type TextFormat =
  | { command: 'bold' | 'italic' | 'underline' | 'strike' | 'uppercase' | 'clear' }
  | { command: 'color' | 'fontSize' | 'fontFamily'; value: string };

/**
 * Events from the edit frame. The frame is same-origin with the editor and runs no scripts; FrameController
 * listens to its DOM directly and translates DOM events into these. Coordinates are document CSS px of the frame.
 */
export type FrameToShell =
  | { type: 'ready'; pages: NodeId[] }
  | { type: 'pointer'; action: 'down' | 'move' | 'up' | 'dblclick' | 'contextmenu'; id: NodeId | null; deepId: NodeId | null; shift: boolean; alt: boolean; meta: boolean; x: number; y: number }
  | { type: 'hover'; id: NodeId | null }
  /** Layout changed (image/font loads, resize): `measure('page')` results; `overflow` = text blocks exceeding their box. */
  | { type: 'rects'; rects: Record<NodeId, Rect>; overflow: NodeId[] }
  /** Text edit state changed (selection inside the edited block); `range` true when a non-empty range is selected. */
  | { type: 'textState'; id: NodeId; range: boolean; active: Partial<Record<'bold' | 'italic' | 'underline' | 'strike', boolean>> }
  | { type: 'textCommit'; id: NodeId; html: string }
  | { type: 'textCancel'; id: NodeId }
  | { type: 'key'; key: string; code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
  | { type: 'wheel'; deltaX: number; deltaY: number; ctrl: boolean }
  | { type: 'drop'; id: NodeId | null; files: Array<{ name: string; type: string; dataURL: string }> }
  | { type: 'fontsReady' };

/** Commands from the editor to the edit frame (applied synchronously to the frame DOM). */
export type ShellToFrame =
  | { type: 'live'; updates: LiveUpdate[] }
  | { type: 'currentPage'; id: NodeId }
  | { type: 'beginTextEdit'; id: NodeId; caret: 'end' | 'all' | 'point'; x?: number; y?: number }
  | { type: 'endTextEdit'; commit: boolean }
  | { type: 'format'; format: TextFormat }
  | { type: 'highlight'; ids: NodeId[] };

/** Owner of the edit frame (frame/*). The frame is same-origin and script-free; all access is direct DOM access. */
export interface FrameController {
  /** Build the preview for `index`, load it into the iframe and resolve once its document is ready. */
  mount(iframe: HTMLIFrameElement, index: DocIndex, opts: { currentPageId: NodeId | null }): Promise<void>;
  send(msg: ShellToFrame): void;
  /** Rects relative to the current page root, in document px; `'page'` = every selectable block of the current page. */
  measure(ids: NodeId[] | 'page'): { rects: Record<NodeId, Rect>; overflow: NodeId[] };
  styles(id: NodeId, props: string[]): Record<string, string>;
  on(listener: (msg: FrameToShell) => void): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------------------------------ */
/* Editor controller (app/*) — the only API the React UI talks to                            */
/* ------------------------------------------------------------------------------------------ */

export type DocState = 'loading' | 'ready' | 'error';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface EditorSnapshot {
  docState: DocState;
  /** Message key or raw text for the error state. */
  error: string | null;
  mode: 'browser' | 'local';
  name: string;
  path: string;
  pages: PageInfo[];
  currentPageId: NodeId | null;
  /** Selected block ids (multi-select when length > 1). */
  selection: NodeId[];
  hoverId: NodeId | null;
  editingTextId: NodeId | null;
  textState: { range: boolean; active: Partial<Record<'bold' | 'italic' | 'underline' | 'strike', boolean>> } | null;
  /** Latest measured rects (document CSS px of the current page) and overflowing text blocks. */
  rects: Readonly<Record<NodeId, Rect>>;
  overflow: readonly NodeId[];
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  conflict: boolean;
  /** Increments on every source change (thumbnails and panels re-render from it). */
  sourceVersion: number;
}

/** Outcome messages for toasts; the UI owns the texts (zh/en). `detail` is raw extra text (e.g. a server error). */
export type NoticeKey =
  | 'saveFailed'
  | 'editRejected'
  | 'resetDone'
  | 'resetUnavailable'
  | 'downloadDone'
  | 'downloadFailed'
  | 'fontFailed'
  | 'imageFailed'
  | 'textOverflow';

export interface Notice {
  kind: 'info' | 'error';
  key: NoticeKey;
  detail?: string;
}

export interface EditorController {
  /** The store's cloud-save adapter, when it has one. */
  readonly cloud?: CloudAdapter;
  getSnapshot(): EditorSnapshot;
  subscribe(listener: () => void): () => void;
  index(): DocIndex;
  /** Current page size in CSS px. */
  pageSize(): { width: number; height: number };

  apply(op: EditOp, opts?: { label?: string; coalesceKey?: string }): void;
  /** Several ops as ONE undo step (all-or-nothing); `coalesceKey` merges repeated batches (arrow nudges). */
  applyBatch(ops: EditOp[], label: string, opts?: { coalesceKey?: string }): void;
  undo(): void;
  redo(): void;
  save(opts?: { force?: boolean }): Promise<void>;
  reload(): Promise<void>;
  /** The stored document changed elsewhere: reload when nothing is unsaved, otherwise raise the conflict dialog. */
  externalChange(): Promise<void>;
  resetToInitial(): Promise<void>;
  /** Code panel: validate, then apply as one undoable `replaceDocument`. Returns a validation error code or null. */
  replaceSource(source: string): string | null;
  downloadAll(): Promise<void>;
  uploadImage?(file: File): Promise<ProjectImage>;
  exportHTML(): void;

  select(ids: NodeId[], opts?: { additive?: boolean }): void;
  selectParent(): void;
  setCurrentPage(id: NodeId): void;
  /** Enter inline text editing; `caret` = end of text (default), select all, or at a point (frame document px). */
  beginTextEdit(id: NodeId, caret?: 'end' | 'all' | { x: number; y: number }): void;
  endTextEdit(commit: boolean): void;
  format(format: TextFormat): void;
  styles(id: NodeId, props: string[]): Record<string, string>;
  /** Refresh `rects`/`overflow` in the snapshot (ids, or every selectable block of the current page). */
  measure(ids: NodeId[] | 'page'): void;
  /** Show uncommitted changes in the frame (drag/resize/crop in progress); the next apply/undo supersedes them. */
  livePreview(updates: LiveUpdate[]): void;
  /** Drop uncommitted live changes (e.g. Esc during a drag) by re-applying the current source state of `ids`. */
  cancelLivePreview(ids: NodeId[]): void;
  /** Raw frame events for the UI's interaction layer (pointer drag, keys, wheel, file drops). */
  onFrameEvent(listener: (event: FrameToShell) => void): () => void;
  /** Font menu + embedding (applies `upsertFontStyle` and the font-family style in one undo step). */
  fontPalette(): Promise<FontPalette>;
  applyFont(roleId: string, targetIds: NodeId[]): Promise<void>;

  /** Outline these blocks inside the frame (layers panel hover); an empty list clears it. */
  highlight(ids: NodeId[]): void;

  /** Toast-worthy outcomes of controller actions (failed save, rejected edit, reset, download, font, image, overflow). */
  onNotice(listener: (notice: Notice) => void): () => void;

  /** Attach / detach the edit frame element rendered by the UI. */
  attachFrame(iframe: HTMLIFrameElement | null): void;
}
