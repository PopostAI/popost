import { ConflictError } from '../contracts';
import type { CloudAdapter, CloudStatus, DocStore, FontPalette, InitialDoc, LoadedDoc, LocalBoot } from '../contracts';
import type { ProjectImage } from '../host/project-tools';
import { LOCAL_PALETTE_URL, loadPalette } from '../fonts';
import { compileProject, splitProject } from './compile';
import type { CompileEnv, ProjectManifest } from './compile';

/** Failure of a skill-server call; `status` is the HTTP status (409 is mapped to ConflictError on save). */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface LocalStoreOptions {
  fetch?: typeof fetch;
  origin?: string;
}

interface ProjectReply {
  manifest: ProjectManifest;
  canvasRev: string;
}

interface SaveReply {
  canvasRev: string;
}

interface InitialReply {
  manifest: ProjectManifest;
  createdAt: string;
}

interface ServerReply {
  ok?: boolean;
  error?: string;
}

export const EXPORT_ALL_URL = '/api/export?page=all';
export const IMAGES_ZIP_NAME = 'popost-images.zip';

/** Save a blob through a temporary download link; the object URL is revoked after 60 s. */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** The cloud-save routes of the skill server (`/api/cloud/*`). A `push` that needs a login answers 409 with a status body. */
function createCloudAdapter(mode: CloudAdapter['mode'], fetchImpl: typeof fetch): CloudAdapter {
  const call = async (url: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  const failure = (reply: { status: number; data: Record<string, unknown> }): HttpError =>
    new HttpError(typeof reply.data.error === 'string' ? reply.data.error : `HTTP ${reply.status}`, reply.status);
  const asStatus = (reply: { status: number; data: Record<string, unknown> }): CloudStatus => {
    if (typeof reply.data.state !== 'string') throw failure(reply);
    return reply.data as unknown as CloudStatus;
  };
  return {
    mode,
    async status() {
      return asStatus(await call('/api/cloud/status'));
    },
    async start(lang) {
      const reply = await call('/api/cloud/start', { lang });
      if (reply.status !== 200 || reply.data.ok === false || typeof reply.data.authorizeUrl !== 'string') throw failure(reply);
      return { authorizeUrl: reply.data.authorizeUrl, expiresAt: String(reply.data.expiresAt ?? '') };
    },
    async push(opts = {}) {
      return asStatus(await call('/api/cloud/push', { force: opts.force === true, ...(opts.lang ? { lang: opts.lang } : {}) }));
    },
  };
}

/** Local-mode DocStore against the skill's HTTP API (current-contracts.md §4.2, §4.6, §4.7). */
export function createLocalStore(boot: LocalBoot, options: LocalStoreOptions = {}): DocStore {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const origin = options.origin ?? window.location.origin;
  const path = `pages/${boot.projectId}.html`;
  let current: ProjectReply | undefined;

  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const data = (await response.json()) as T & ServerReply;
    if (!response.ok || data.ok === false) throw new HttpError(data.error || `HTTP ${response.status}`, response.status);
    return data;
  }

  const env: CompileEnv = {
    origin,
    async fetchStylesheet(url) {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error('样式文件无法读取：' + url.pathname);
      return response.text();
    },
  };

  async function load(): Promise<LoadedDoc> {
    current = await request<ProjectReply>('/api/project');
    await request('/api/canvas-initial');
    const content = await compileProject(current.manifest, env);
    return { content, rev: current.canvasRev, name: boot.name, path };
  }

  async function save(content: string, opts: { rev: string; force?: boolean }): Promise<{ rev: string }> {
    const pages = splitProject(content, { previousPages: current?.manifest.pages ?? [], defaultSize: boot });
    let result: SaveReply;
    try {
      result = await request<SaveReply>('/api/project', { pages, canvasRev: opts.rev, force: opts.force ?? false });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) throw new ConflictError(error.message);
      throw error;
    }
    current = await request<ProjectReply>('/api/project');
    return { rev: result.canvasRev };
  }

  async function initial(): Promise<InitialDoc> {
    const data = await request<InitialReply>('/api/canvas-initial');
    return { content: await compileProject(data.manifest, env), available: true, reliable: true, source: 'local-open', createdAt: data.createdAt };
  }

  async function preview(html: string, nonce: string): Promise<string> {
    return (await request<{ url: string }>('/api/canvas-preview', { content: html, nonce })).url;
  }

  const fontPalette = (): Promise<FontPalette> => loadPalette(LOCAL_PALETTE_URL, fetchImpl);

  async function fontCSS(roleIds: string[], ctx: { rev: string }): Promise<{ css: Record<string, string>; rev: string }> {
    const installed = await request<SaveReply>('/api/font-install', { roles: roleIds.join(','), resourceOnly: true, canvasRev: ctx.rev });
    const css: Record<string, string> = {};
    for (const roleId of roleIds) {
      const response = await fetchImpl(`/css/${roleId}.css`, { cache: 'no-store' });
      if (!response.ok) throw new Error('字体样式无法读取');
      css[roleId] = await response.text();
    }
    return { css, rev: installed.canvasRev };
  }

  async function uploadImage(file: File, ctx: { rev: string }): Promise<{ image: ProjectImage; rev: string }> {
    const response = await fetchImpl('/api/import-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Popost-Canvas-Rev': ctx.rev },
      body: file,
    });
    const data = (await response.json()) as ServerReply & { asset: { path: string }; width: number; height: number; canvasRev: string };
    if (!response.ok || data.ok === false) throw new HttpError(data.error || `HTTP ${response.status}`, response.status);
    return { image: { src: '/' + data.asset.path, name: file.name, width: data.width, height: data.height }, rev: data.canvasRev };
  }

  async function downloadAll(content: string, ctx: { rev: string }): Promise<{ rev: string }> {
    const saved = await save(content, { rev: ctx.rev, force: true });
    const response = await fetchImpl(EXPORT_ALL_URL, { cache: 'no-store' });
    if (!response.ok) {
      let message: string | undefined;
      try {
        message = ((await response.json()) as ServerReply).error;
      } catch {
        /* body is not JSON */
      }
      throw new Error(message || '下载失败');
    }
    saveBlob(await response.blob(), IMAGES_ZIP_NAME);
    return { rev: saved.rev };
  }

  return { mode: 'local', load, save, initial, preview, fontPalette, fontCSS, uploadImage, downloadAll, ...(boot.cloud ? { cloud: createCloudAdapter(boot.cloud.mode, fetchImpl) } : {}) };
}
