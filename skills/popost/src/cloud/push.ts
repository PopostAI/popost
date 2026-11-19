/**
 * `popost cloud push`: the project goes to the user's popost.ai account. The project is exported as the editor
 * document in Chromium (`deck/export-deck.ts`), every picture it names under `../assets/` is uploaded once by content
 * hash (purpose `material`), and `POST /projects/sync` creates or updates the web deck. The client needs no base version:
 * the platform remembers what it last synced and answers `DECK_CONFLICT` when the web copy moved on.
 */
import { Project } from '../core/project';
import { sha256 } from '../core/util';
import { exportDeck } from '../deck/export-deck';
import type { DeckSession } from '../deck/types';
import { canvasRevision } from '../editor/canvas-state';
import { sniffImageMime, type PopostClient } from '../providers/api';
import { PopostApiError } from '../providers/errors';
import { isRecord } from '../providers/base';
import { sleep } from '../providers/time';
import { readProjectFile } from '../render/offline';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { CloudError } from './errors';
import { isSynced, readCloudRecord, writeCloudRecord, type CloudRecord } from './state';

export const MAX_HTML_CHARS = 2_000_000;
export const MAX_ASSETS = 100;
export const TITLE_CHARS = 120;
const RATE_RETRIES = 3;
const MAX_WAIT_SEC = 60;
const SYNC_TIMEOUT_SEC = 120;
const PROJECT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The exact URL grammar of the platform's `projectAssetUrls`: `../assets/<file>` not preceded by path characters. */
const START = String.raw`(?<![A-Za-z0-9._~%@+=:/-])`;
const END = String.raw`(?=["')\s&<>,;]|$)`;
const SEGMENT = '[A-Za-z0-9._~%@+=-]+';

/** The `../assets/<file>` URLs of an exported document, as written, each once, in order of appearance. */
export const assetUrlsOf = (html: string): string[] => {
  const pattern = new RegExp(`${START}\\.\\./assets/((?:${SEGMENT}/)*${SEGMENT})${END}`, 'g');
  return [...new Set([...html.matchAll(pattern)].map((match) => match[0]))];
};

/** The project-relative path (`/assets/<file>`) of an asset URL, or `null` when it would leave the folder. */
const assetPath = (url: string): string | null => {
  const segments = url.slice('../assets/'.length).split('/');
  try {
    const decoded = segments.map(decodeURIComponent);
    return decoded.some((s) => s === '' || s === '.' || s === '..' || /[\\/\0]/.test(s)) ? null : `/assets/${decoded.join('/')}`;
  } catch {
    return null;
  }
};

export interface PushOptions {
  readonly dir: string;
  readonly client: PopostClient;
  readonly force?: boolean;
  /** When presenting, scope the saved link to the authenticated account so unchanged local content can reopen it. */
  readonly accountScope?: string;
  readonly locale?: 'en' | 'zh';
  /** Replaces the Chromium-backed converter (tests). */
  readonly session?: DeckSession;
}

export interface PushResult {
  readonly deckId: string;
  readonly webUrl: string;
  readonly version: number;
  readonly changed: boolean;
  readonly created: boolean;
  readonly pages: number;
  readonly assets: { readonly uploaded: number; readonly reused: number };
  readonly record: CloudRecord;
}

interface Picture {
  readonly url: string;
  readonly file: string;
  readonly data: Uint8Array;
  readonly sha: string;
  readonly mime: string;
}

/** Waits out `RATE_LIMITED` (the platform says how long) a few times; every other failure is the caller's. */
const rateAware = async <T>(rt: Runtime, call: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof PopostApiError) || error.code !== 'RATE_LIMITED' || attempt >= RATE_RETRIES) throw error;
      const asked = Number(error.details.retryAfterSeconds);
      const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_WAIT_SEC) : 5;
      await sleep(rt, Math.ceil(seconds * 1000));
    }
  }
};

const readPicture = async (rt: Runtime, project: Project, url: string): Promise<Picture> => {
  const path = assetPath(url);
  const file = path ? await readProjectFile(rt, project.root, path) : null;
  if (!path || !file)
    throw new CloudError('ASSET_MISSING', msg(`a picture the pages use is not in the project's assets folder: ${url}`, `页面用到的一张图片不在工程的 assets 文件夹里：${url}`));
  const mime = sniffImageMime(file.data.subarray(0, 16));
  if (!mime)
    throw new CloudError(
      'ASSET_UNSUPPORTED',
      msg(
        `${path.slice(1)} is not a PNG, JPEG, GIF or WebP picture, which are the only ones the cloud takes`,
        `${path.slice(1)} 不是 PNG、JPEG、GIF 或 WebP 图片，云端只接受这几种格式`,
      ),
    );
  return { url, file: path.slice(1), data: file.data, sha: sha256(file.data), mime };
};

interface Uploads {
  readonly ids: Map<string, string>;
  readonly reused: Set<string>;
  uploaded: number;
}

/** Upload each distinct picture the cache does not hold; `fresh` hashes are uploaded even when cached (a stale id). */
const ensureUploads = async (rt: Runtime, client: PopostClient, pictures: readonly Picture[], cache: Record<string, string>, fresh: ReadonlySet<string>, out: Uploads): Promise<void> => {
  for (const picture of pictures) {
    if (out.ids.has(picture.sha)) continue;
    const cached = cache[picture.sha];
    if (cached && !fresh.has(picture.sha)) {
      out.ids.set(picture.sha, cached);
      out.reused.add(picture.sha);
      continue;
    }
    const name = picture.file.split('/').pop() ?? 'picture';
    const sent = await rateAware(rt, () => client.uploadBytes(picture.data, name, picture.mime, 'material'));
    if (typeof sent.uploadId !== 'string' || !sent.uploadId)
      throw new CloudError('BAD_RESPONSE', msg('POST /uploads answered without an uploadId', 'POST /uploads 的返回里没有 uploadId'));
    out.ids.set(picture.sha, sent.uploadId);
    out.reused.delete(picture.sha);
    cache[picture.sha] = sent.uploadId;
    out.uploaded += 1;
  }
};

/** The asset positions the platform named as stale: `INVALID_REQUEST` with `issues[].path = assets.<i>.uploadId`. */
export const staleAssetIndexes = (error: unknown): number[] => {
  if (!(error instanceof PopostApiError) || error.code !== 'INVALID_REQUEST') return [];
  const issues = Array.isArray(error.details.issues) ? error.details.issues : [];
  const found: number[] = [];
  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : String(issue.path ?? '');
    const match = /^assets\.(\d+)\.uploadId$/.exec(path);
    if (match) found.push(Number(match[1]));
  }
  return found;
};

const isWorkbenchUrl = (value: string, baseUrl: string): boolean => {
  try {
    const url = new URL(value);
    const api = new URL(baseUrl);
    return url.protocol === api.protocol && url.origin === api.origin && !url.username && !url.password;
  } catch {
    return false;
  }
};

const parseReply = (data: unknown, baseUrl: string) => {
  if (!isRecord(data) || typeof data.deckId !== 'string' || typeof data.webUrl !== 'string' || typeof data.version !== 'number')
    throw new CloudError('BAD_RESPONSE', msg('POST /projects/sync answered in an unexpected shape', 'POST /projects/sync 返回的格式不符合预期'));
  if (!isWorkbenchUrl(data.webUrl, baseUrl))
    throw new CloudError(
      'BAD_RESPONSE',
      msg('POST /projects/sync did not return a workbench URL on the Popost API origin', 'POST /projects/sync 没有返回 Popost API 同源的工作台地址'),
    );
  return {
    deckId: data.deckId,
    webUrl: data.webUrl,
    assetsUrl: typeof data.assetsUrl === 'string' ? data.assetsUrl : undefined,
    version: data.version,
    changed: data.changed === true,
    created: data.created === true,
    pages: typeof data.pages === 'number' ? data.pages : 0,
  };
};

const syncBody = (project: Project, html: string, pictures: readonly Picture[], ids: ReadonlyMap<string, string>, options: PushOptions) => {
  const first = project.manifest.pages[0]!;
  const brief = Array.from(String(project.manifest.brief ?? '').replace(/\s+/g, ' ').trim()).slice(0, TITLE_CHARS).join('');
  return {
    projectId: project.manifest.projectId,
    title: brief || 'Popost',
    width: first.width,
    height: first.height,
    platform: typeof project.manifest.platform === 'string' && project.manifest.platform ? project.manifest.platform : null,
    html,
    assets: pictures.map((p) => ({ url: p.url, uploadId: ids.get(p.sha)! })),
    force: options.force === true,
    ...(options.locale ? { locale: options.locale } : {}),
  };
};

/** Export, upload, sync. Throws `PopostApiError` for a platform refusal (`DECK_CONFLICT` among them) and `CloudError` otherwise. */
export const pushProject = async (rt: Runtime, options: PushOptions): Promise<PushResult> => {
  const { client } = options;
  if (!client.hasKey())
    throw new CloudError(
      'NO_API_KEY',
      msg('no popost.ai key is configured, so the project cannot be synced to the cloud (nothing was sent)', '没有配置 popost.ai 的 Key，工程无法同步到云端（未发送任何内容）'),
    );
  const project = await Project.load(rt, options.dir);
  const projectId = project.manifest.projectId;
  if (!PROJECT_ID.test(projectId ?? ''))
    throw new CloudError(
      'NO_PROJECT_ID',
      msg(
        'the project has no stable id; run `popost init` again or copy it with `popost package` / `popost unpack`',
        '工程没有稳定的 id；请重新运行 `popost init`，或用 `popost package` / `popost unpack` 复制工程',
      ),
    );
  const cached = await readCloudRecord(project);
  const previous = cached?.accountScope === options.accountScope ? cached : null;
  const reusableAssets = cached?.accountScope ? previous?.assets : cached?.assets;
  const cache: Record<string, string> = { ...reusableAssets };
  const fingerprint = await canvasRevision(project);
  const exported = await exportDeck(rt, options.dir, { session: options.session });
  if (exported.html.length > MAX_HTML_CHARS)
    throw new CloudError(
      'TOO_LARGE',
      msg(`the exported pages are ${exported.html.length} characters; the cloud takes at most ${MAX_HTML_CHARS}`, `导出的页面共 ${exported.html.length} 个字符；云端最多接受 ${MAX_HTML_CHARS} 个`),
    );
  const urls = assetUrlsOf(exported.html);
  if (urls.length > MAX_ASSETS)
    throw new CloudError(
      'TOO_LARGE',
      msg(`the pages use ${urls.length} pictures; the cloud takes at most ${MAX_ASSETS} per sync`, `页面用到 ${urls.length} 张图片；云端每次同步最多接受 ${MAX_ASSETS} 张`),
    );
  const pictures = await Promise.all(urls.map((url) => readPicture(rt, project, url)));
  const contentHash = sha256(JSON.stringify([exported.html, pictures.map((picture) => picture.sha)]));
  const uploads: Uploads = { ids: new Map(), reused: new Set(), uploaded: 0 };

  let reply: ReturnType<typeof parseReply> | null = null;
  let fresh = new Set<string>();
  for (let attempt = 0; reply === null; attempt++) {
    try {
      await ensureUploads(rt, client, pictures, cache, fresh, uploads);
      const body = syncBody(project, exported.html, pictures, uploads.ids, options);
      reply = parseReply(await rateAware(rt, () => client.request('POST', '/projects/sync', { body, timeoutSec: SYNC_TIMEOUT_SEC })), client.baseUrl);
    } catch (error) {
      const stale = staleAssetIndexes(error).flatMap((i) => (pictures[i] ? [pictures[i]!.sha] : []));
      if (attempt === 0 && stale.length) {
        for (const sha of stale) uploads.ids.delete(sha);
        fresh = new Set(stale);
        continue;
      }
      // A conflict from this authenticated account confirms the project still exists. Keep edits saved in the browser.
      if (
        options.accountScope && error instanceof PopostApiError && error.code === 'DECK_CONFLICT' &&
        isSynced(previous) && previous.contentHash === contentHash && isWorkbenchUrl(previous.webUrl, client.baseUrl)
      ) {
        return {
          deckId: previous.deckId,
          webUrl: previous.webUrl,
          version: Number(error.details.currentVersion) || previous.version || 0,
          changed: false,
          created: false,
          pages: exported.pages,
          assets: { uploaded: uploads.uploaded, reused: uploads.reused.size },
          record: previous,
        };
      }
      if (!cached || previous) {
        await writeCloudRecord(project, { ...previous, projectId, accountScope: options.accountScope, assets: cache });
      }
      throw error;
    }
  }
  const record: CloudRecord = {
    projectId,
    accountScope: options.accountScope,
    deckId: reply.deckId,
    webUrl: reply.webUrl,
    assetsUrl: reply.assetsUrl,
    version: reply.version,
    fingerprint,
    contentHash,
    assets: cache,
    syncedAt: rt.now().toISOString(),
  };
  await writeCloudRecord(project, record);
  return { ...reply, pages: reply.pages || exported.pages, assets: { uploaded: uploads.uploaded, reused: uploads.reused.size }, record };
};
