import { ConflictError } from '../contracts';
import type { DocStore, HostParams, InitialDoc, LoadedDoc } from '../contracts';
import { postToHost, requestImageDownload } from '../host';
import { flushStorage, initStorage, readStored, refreshStored, writeStored } from './browser-storage';
import { blobPreview, createLibraryFonts } from './library';
import type { LibraryOptions } from './library';

/** Immutable "initial layout" snapshot (`initial-decks[id]`). */
interface InitialRecord {
  content: string;
  source: string;
  createdAt: string;
}

interface HistoryEntry {
  name: string;
  content: string;
}

interface ProjectRecord {
  id: string;
  name?: string;
}

interface WorkspaceState {
  projects: ProjectRecord[];
}

type Dict<T> = Record<string, T>;

const HISTORY_LIMIT = 5;

export type BrowserStoreOptions = LibraryOptions;

const stamp = (): string => String(Date.now());

export function projectIdFromFile(file: string | null): string {
  return String(file ?? '').replace(/\.html$/, '');
}

function validProject(id: string): ProjectRecord {
  const project = readStored<WorkspaceState>('state', { projects: [] }).projects.find((p) => p.id === id);
  if (!project) throw new Error('Project not found');
  return project;
}

/**
 * Return the initial-layout record, seeding it from the OLDEST retained history entry when missing.
 * A record is written once and never overwritten; with no history nothing is stored.
 */
export function ensureInitialDeck(id: string): InitialRecord {
  const all = readStored<Dict<InitialRecord>>('initial-decks', {});
  const existing = all[id];
  if (existing) return existing;
  const history = readStored<Dict<HistoryEntry[]>>('deck-history', {})[id] ?? [];
  const oldest = history[history.length - 1];
  if (!oldest) return { content: '', source: 'current', createdAt: '' };
  const record: InitialRecord = { content: oldest.content || '', source: 'earliest-retained-history', createdAt: new Date().toISOString() };
  writeStored('initial-decks', { ...all, [id]: record });
  return record;
}

async function refreshKeys(keys: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
  for (const [key, fallback] of keys) await refreshStored(key, fallback);
}

function isStale(sent: string, stored: string | undefined, force: boolean | undefined): boolean {
  return Boolean(sent) && Boolean(stored) && sent !== stored && !force;
}

function pushHistory(id: string, previous: string): void {
  const history = readStored<Dict<HistoryEntry[]>>('deck-history', {});
  history[id] = [{ name: stamp(), content: previous }, ...(history[id] ?? [])].slice(0, HISTORY_LIMIT);
  writeStored('deck-history', history);
}

/** Browser-mode DocStore: IndexedDB semantics of current-contracts.md §3. */
export function createBrowserStore(params: Pick<HostParams, 'file' | 'name'>, options: BrowserStoreOptions = {}): DocStore {
  const id = projectIdFromFile(params.file);
  const path = id + '.html';
  const { fontPalette, fontCSS } = createLibraryFonts(options);

  async function load(): Promise<LoadedDoc> {
    await initStorage();
    await refreshKeys([['state', { projects: [] }], ['decks', {}]]);
    const project = validProject(id);
    const content = readStored<Dict<string>>('decks', {})[id];
    if (!content) throw new Error('Project content missing');
    return { content, rev: readStored<Dict<string>>('revs', {})[id] || '1', name: params.name || project.name || id, path };
  }

  async function save(content: string, opts: { rev: string; force?: boolean }): Promise<{ rev: string }> {
    await initStorage();
    await refreshKeys([['decks', {}], ['revs', {}], ['deck-history', {}], ['initial-decks', {}]]);
    validProject(id);
    ensureInitialDeck(id);
    const decks = readStored<Dict<string>>('decks', {});
    const revs = readStored<Dict<string>>('revs', {});
    if (isStale(opts.rev, revs[id], opts.force)) throw new ConflictError('File changed');
    pushHistory(id, decks[id] ?? '');
    decks[id] = content;
    writeStored('decks', decks);
    const rev = stamp();
    revs[id] = rev;
    writeStored('revs', revs);
    await flushStorage();
    // Only after the flush: the web app re-reads decks and revs when it receives this message.
    postToHost({ source: 'popost-editor', type: 'saved', id });
    return { rev };
  }

  async function initial(): Promise<InitialDoc> {
    await initStorage();
    await refreshStored('initial-decks', {});
    validProject(id);
    const record = ensureInitialDeck(id);
    return {
      content: record.content,
      available: !!record.content && (record.source === 'create' || record.source === 'earliest-retained-history'),
      reliable: record.source === 'create',
      source: record.source,
      createdAt: record.createdAt,
    };
  }

  async function downloadAll(content: string, ctx: { rev: string }): Promise<{ rev: string }> {
    await requestImageDownload(id, content);
    return { rev: ctx.rev };
  }

  return { mode: 'browser', load, save, initial, preview: blobPreview, fontPalette, fontCSS, downloadAll };
}
