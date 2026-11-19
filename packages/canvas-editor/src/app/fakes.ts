/** Test doubles for the controller tests: a recording FrameController and an in-memory DocStore. */
import { ConflictError } from '../contracts';
import type {
  CloudAdapter,
  DocIndex,
  DocStore,
  FontPalette,
  FrameController,
  FrameToShell,
  InitialDoc,
  LoadedDoc,
  NodeId,
  Rect,
  ShellToFrame,
} from '../contracts';
import { getAttr } from '../core/source';
import type { EditorHandle } from './controller';

export const DOC = `<!doctype html>
<html><head><title>T</title></head>
<body>
<section class="slide" data-popost-page="p-aaaaaaaaaaaa" style="width:1080px;height:1350px">
<h1 data-layer-id="title" style="color:red">Hello</h1>
<div data-layer-id="box"><p data-layer-id="inner">Inner</p></div>
</section>
<section class="slide" data-popost-page="p-bbbbbbbbbbbb" style="width:1080px;height:1350px">
<p data-layer-id="second">Second</p>
</section>
</body></html>
`;

export class FakeFrame implements FrameController {
  sent: ShellToFrame[] = [];
  mounts: Array<{ index: DocIndex; currentPageId: NodeId | null }> = [];
  measures: Array<NodeId[] | 'page'> = [];
  rects: Record<NodeId, Rect> = {};
  overflow: NodeId[] = [];
  computed: Record<NodeId, Record<string, string>> = {};
  editing: NodeId | null = null;
  editHtml = '';
  disposed = false;
  private listeners = new Set<(msg: FrameToShell) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  async mount(_iframe: HTMLIFrameElement, index: DocIndex, opts: { currentPageId: NodeId | null }): Promise<void> {
    this.mounts.push({ index, currentPageId: opts.currentPageId });
  }

  send(msg: ShellToFrame): void {
    this.sent.push(msg);
    if (msg.type === 'beginTextEdit') this.editing = msg.id;
    if (msg.type === 'endTextEdit' && this.editing !== null) {
      const id = this.editing;
      this.editing = null;
      this.emit(msg.commit ? { type: 'textCommit', id, html: this.editHtml } : { type: 'textCancel', id });
    }
  }

  measure(ids: NodeId[] | 'page'): { rects: Record<NodeId, Rect>; overflow: NodeId[] } {
    this.measures.push(ids);
    return { rects: this.rects, overflow: this.overflow };
  }

  styles(id: NodeId, props: string[]): Record<string, string> {
    const all = this.computed[id] ?? {};
    return Object.fromEntries(props.filter((p) => p in all).map((p) => [p, all[p] as string]));
  }

  on(listener: (msg: FrameToShell) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(msg: FrameToShell): void {
    for (const l of [...this.listeners]) l(msg);
  }

  /** Sent messages of one type. */
  of<T extends ShellToFrame['type']>(type: T): Array<Extract<ShellToFrame, { type: T }>> {
    return this.sent.filter((m): m is Extract<ShellToFrame, { type: T }> => m.type === type);
  }
}

export class FakeStore implements DocStore {
  mode: 'browser' | 'local' = 'browser';
  cloud?: CloudAdapter;
  content: string;
  rev = '1';
  name = 'My post';
  path = 'p1.html';
  saves: Array<{ content: string; rev: string; force?: boolean }> = [];
  loadError: Error | null = null;
  saveError: Error | null = null;
  saveGate: Promise<void> | null = null;
  initialDoc: InitialDoc = { content: DOC, available: true, reliable: true, source: 'test', createdAt: '' };
  palette: FontPalette = {
    roles: [
      { id: 'inter', family: 'Inter Variable', label: 'Inter', group: 'Sans', fallback: 'sans-serif' },
      { id: 'cjk-sans', family: 'Noto Sans SC Variable', label: 'Noto Sans SC', group: 'Sans', fallback: 'sans-serif' },
    ],
  };
  paletteCalls = 0;
  fontCalls: string[][] = [];
  fontError: Error | null = null;
  downloads: Array<{ content: string; rev: string }> = [];
  downloadError: Error | null = null;

  constructor(content: string = DOC) {
    this.content = content;
  }

  async load(): Promise<LoadedDoc> {
    if (this.loadError) throw this.loadError;
    return { content: this.content, rev: this.rev, name: this.name, path: this.path };
  }

  async save(content: string, opts: { rev: string; force?: boolean }): Promise<{ rev: string }> {
    this.saves.push({ content, rev: opts.rev, force: opts.force });
    if (this.saveGate) await this.saveGate;
    if (this.saveError) throw this.saveError;
    if (opts.rev !== this.rev && !opts.force) throw new ConflictError('stale');
    this.content = content;
    this.rev = String(Number(this.rev) + 1);
    return { rev: this.rev };
  }

  async initial(): Promise<InitialDoc> {
    return this.initialDoc;
  }

  async preview(): Promise<string> {
    return 'blob:x';
  }

  async fontPalette(): Promise<FontPalette> {
    this.paletteCalls++;
    return this.palette;
  }

  async fontCSS(roleIds: string[], ctx: { rev: string }): Promise<{ css: Record<string, string>; rev: string }> {
    this.fontCalls.push(roleIds);
    if (this.fontError) throw this.fontError;
    return { css: Object.fromEntries(roleIds.map((id) => [id, `/* ${id} */`])), rev: ctx.rev };
  }

  async downloadAll(content: string, ctx: { rev: string }): Promise<{ rev: string }> {
    this.downloads.push({ content, rev: ctx.rev });
    if (this.downloadError) throw this.downloadError;
    return { rev: ctx.rev };
  }
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** First element id whose `data-layer-id` (or `data-popost-page`) equals `value`. */
export function idByAttr(c: EditorHandle, value: string): NodeId {
  const index = c.index();
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (el && (getAttr(el, 'data-layer-id') === value || getAttr(el, 'data-popost-page') === value)) return id;
  }
  throw new Error(`no element ${value}`);
}
