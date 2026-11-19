import { ConflictError } from '../contracts';
import type { DocStore, HostParams, InitialDoc, LoadedDoc } from '../contracts';
import { HostStoreError, requestFromHost, requestImageDownload } from '../host';
import { projectIdFromFile } from './browser-store';
import { blobPreview, createLibraryFonts } from './library';
import type { LibraryOptions } from './library';

export type HostStoreOptions = LibraryOptions;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HostStoreError('invalid-reply', `The project returned no ${field}.`);
  return value;
}

/**
 * Host-mode DocStore (`store=host`): the embedding page owns persistence and answers M6 `store` requests with
 * M7 `store-result` (see EMBEDDING.md). Everything else behaves like browser mode: blob previews, the static font
 * library next to the editor (linked by root-relative path instead of inlined), and "Download all" through M4/M5.
 * Reports `mode: 'browser'` for that reason.
 */
export function createHostStore(params: Pick<HostParams, 'file' | 'name'>, options: HostStoreOptions = {}): DocStore {
  const id = projectIdFromFile(params.file);
  const path = id + '.html';
  // Linked, not inlined: hosts store documents server-side, where multi-megabyte embedded fonts do not belong.
  const { fontPalette, fontCSS } = createLibraryFonts({ fonts: 'link', ...options });

  async function load(): Promise<LoadedDoc> {
    const reply = (await requestFromHost<Record<string, unknown> | null>(id, 'load')) ?? {};
    return {
      content: requireText(reply.content, 'content'),
      rev: requireText(reply.rev, 'revision'),
      name: text(reply.name) || params.name || id,
      path,
    };
  }

  async function save(content: string, opts: { rev: string; force?: boolean }): Promise<{ rev: string }> {
    try {
      const reply = (await requestFromHost<Record<string, unknown> | null>(id, 'save', { content, rev: opts.rev, force: Boolean(opts.force) })) ?? {};
      return { rev: requireText(reply.rev, 'revision') };
    } catch (error) {
      if (error instanceof HostStoreError && error.code === 'conflict') throw new ConflictError(error.message);
      throw error;
    }
  }

  async function initial(): Promise<InitialDoc> {
    const reply = (await requestFromHost<Record<string, unknown> | null>(id, 'initial')) ?? {};
    const content = text(reply.content);
    return {
      content,
      available: reply.available === true && content !== '',
      reliable: reply.reliable === true,
      source: text(reply.source) || 'host',
      createdAt: text(reply.createdAt),
    };
  }

  async function downloadAll(content: string, ctx: { rev: string }): Promise<{ rev: string }> {
    await requestImageDownload(id, content);
    return { rev: ctx.rev };
  }

  return { mode: 'browser', load, save, initial, preview: blobPreview, fontPalette, fontCSS, downloadAll };
}
