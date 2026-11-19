/**
 * PostBundle -> import plan for the popost.ai inspiration library (the pure, local half of inspiration_cli.py): the post
 * as the platform's `ParsedPostInput`, the images to upload or reference, what was skipped, and an idempotency id derived
 * from the content. Nothing here touches the network.
 */
import { createHash } from 'node:crypto';
import { sniffImage } from '../core/image';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { PLATFORMS, validateBundle } from '../workflow/post-bundle';
import { EXTENSIONS, MAX_UPLOAD_BYTES, sniffImageMime } from './api';
import { isInt, isRecord, type JsonRecord } from './base';
import { canonicalJson } from './canonical';

export const LIMITS = { title: 500, text: 20000, tags: 50, images: 30, note: 5000, clientId: 64 } as const;
const AUTHOR_FIELDS = ['name', 'handle', 'profileUrl', 'avatarUrl'];
const STAT_FIELDS = ['likes', 'comments', 'shares', 'saves', 'views'];

/** A PostBundle or option problem: nothing has been sent. */
export class InputError extends Error {
  override name = 'InputError';
}

export interface PlanImage extends JsonRecord {
  kind: 'local' | 'remote';
  resourceId: unknown;
  alt?: string;
  path?: string;
  url?: string;
  bytes?: number;
  mimeType?: string;
  sha256?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface ImportPlan {
  post: JsonRecord;
  images: PlanImage[];
  skipped: JsonRecord[];
  clientId: string;
}

export interface PlanOptions {
  note?: string;
  clientId?: string;
  allowIncomplete?: boolean;
}

const length = (text: string): number => [...text].length; // Python `len`: code points

const checkLen = (field: string, value: string | undefined, limit: number): void => {
  if (value !== undefined && length(value) > limit)
    throw new InputError(
      msg(`${field} is longer than the limit of ${limit} (it has ${length(value)}); shorten it and import again`, `${field} 超过上限 ${limit}（当前 ${length(value)}）；请精简后再导入`),
    );
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

export const publishedAt = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new InputError(msg('publishedAt must be an ISO time string with a time zone', 'publishedAt 必须是带时区的 ISO 时间字符串'));
  const m = ISO.exec(value);
  const valid = m !== null && !Number.isNaN(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))) && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && Number(m[4] ?? 0) < 24 && Number(m[5] ?? 0) < 60;
  if (!valid) throw new InputError(msg(`publishedAt is not an ISO time: ${JSON.stringify(value)}`, `publishedAt 不是 ISO 时间：${JSON.stringify(value)}`));
  if (m[7] === undefined)
    throw new InputError(msg('publishedAt needs a time zone offset, for example 2026-05-01T12:00:00+08:00', 'publishedAt 需要时区偏移，例如 2026-05-01T12:00:00+08:00'));
  return value;
};

const tagsOf = (raw: unknown): string[] => {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const tag = String(item).trim().replace(/^#+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  if (out.length > LIMITS.tags) throw new InputError(msg(`more than ${LIMITS.tags} tags`, `tags 超过 ${LIMITS.tags} 个`));
  return out;
};

/** `pageOrder` sorts the images when it is exactly a permutation of 1..n; otherwise the resource order stays. */
const orderedImages = (bundle: JsonRecord, images: PlanImage[]): PlanImage[] => {
  const order = Array.isArray(bundle.pageOrder) ? (bundle.pageOrder as number[]) : [];
  const sorted = [...order].sort((a, b) => a - b);
  if (images.length > 1 && sorted.length === images.length && sorted.every((n, i) => n === i + 1)) return order.map((n) => images[n - 1]!);
  return images;
};

const imageSize = (raw: Uint8Array): { width: number; height: number } | null => {
  try {
    const { width, height } = sniffImage(raw);
    return { width, height };
  } catch {
    return null; // the size is an optional field
  }
};

const localImage = async (rt: Runtime, rid: unknown, path: string, baseDir: string, entry: PlanImage): Promise<PlanImage> => {
  const full = rt.path.isAbsolute(path) ? path : rt.path.join(baseDir, path);
  const stat = await rt.fs.stat(full);
  if (!stat?.isFile) throw new InputError(msg(`resource ${String(rid)}: the local picture does not exist: ${path}`, `resource ${String(rid)} 本地图片不存在：${path}`));
  if (stat.size > MAX_UPLOAD_BYTES) throw new InputError(msg(`resource ${String(rid)} is larger than the 30 MiB upload limit`, `resource ${String(rid)} 超过 30 MiB 上传上限`));
  const raw = await rt.fs.readFile(full);
  const mime = sniffImageMime(raw.subarray(0, 16));
  if (!mime) throw new InputError(msg(`resource ${String(rid)} is not a PNG/JPEG/WebP/GIF picture: ${path}`, `resource ${String(rid)} 不是 PNG/JPEG/WebP/GIF 图片：${path}`));
  const stem = rt.path.basename(full).replace(/\.[^.]*$/, '');
  Object.assign(entry, { kind: 'local', path: rt.path.resolve(full), bytes: stat.size, mimeType: mime, sha256: createHash('sha256').update(raw).digest('hex'), fileName: stem + EXTENSIONS[mime] });
  return Object.assign(entry, imageSize(raw) ?? {});
};

/** Image resources become uploads (local files) or direct references (https urls); other kinds are skipped. */
const collectImages = async (rt: Runtime, bundle: JsonRecord, baseDir: string): Promise<{ images: PlanImage[]; skipped: JsonRecord[] }> => {
  const images: PlanImage[] = [];
  const skipped: JsonRecord[] = [];
  for (const res of (Array.isArray(bundle.resources) ? bundle.resources : []) as JsonRecord[]) {
    const rid = res.id;
    if (res.kind !== 'image') {
      skipped.push({
        resourceId: rid,
        kind: res.kind,
        reason: msg(`the inspiration library keeps pictures only; the ${String(res.kind)} was not imported`, `灵感库只收录图片，${String(res.kind)} 未导入`),
      });
      continue;
    }
    const entry: PlanImage = { kind: 'remote', resourceId: rid };
    if (typeof res.alt === 'string' && res.alt.trim()) entry.alt = [...res.alt.trim()].slice(0, 500).join('');
    if (res.path) images.push(await localImage(rt, rid, String(res.path), baseDir, entry));
    else if (typeof res.url === 'string' && res.url.startsWith('https://')) {
      Object.assign(entry, { kind: 'remote', url: res.url });
      for (const key of ['width', 'height'] as const) if (isInt(res[key]) && (res[key] as number) > 0) entry[key] = res[key] as number;
      images.push(entry);
    } else if (res.url) throw new InputError(msg(`the url of resource ${String(rid)} must be https: ${String(res.url)}`, `resource ${String(rid)} 的 url 必须是 https：${String(res.url)}`));
    else skipped.push({ resourceId: rid, kind: 'image', reason: msg('it has neither a local path nor an https url', '既无本地 path 也无 https url') });
  }
  const ordered = orderedImages(bundle, images);
  if (ordered.length > LIMITS.images)
    throw new InputError(
      msg(`${ordered.length} pictures, more than the ${LIMITS.images} one inspiration can hold`, `图片 ${ordered.length} 张，超过灵感库单条 ${LIMITS.images} 张上限`),
    );
  return { images: ordered, skipped };
};

export const authorOf = (raw: unknown): JsonRecord => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(AUTHOR_FIELDS.filter((k) => typeof raw[k] === 'string' && (raw[k] as string).trim()).map((k) => [k, (raw[k] as string).trim()]));
};

export const statsOf = (raw: unknown): JsonRecord => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(STAT_FIELDS.filter((k) => isInt(raw[k]) && (raw[k] as number) >= 0).map((k) => [k, raw[k]]));
};

const postOf = (bundle: JsonRecord, options: PlanOptions): JsonRecord => {
  const post: JsonRecord = {};
  if ((PLATFORMS as readonly string[]).includes(bundle.platform as string)) post.platform = bundle.platform;
  const source = String(bundle.sourceURL ?? '').trim();
  if (source.startsWith('https://') || source.startsWith('http://')) post.sourceUrl = source;
  const title = String(bundle.title ?? '').trim();
  const text = String(bundle.body ?? '').trim();
  checkLen('title', title, LIMITS.title);
  checkLen(msg('text (body)', 'text（body）'), text, LIMITS.text);
  if (title) post.title = title;
  if (text) post.text = text;
  const tags = tagsOf(bundle.tags);
  if (tags.length) post.tags = tags;
  const author = authorOf(bundle.author);
  if (Object.keys(author).length) post.author = author;
  const stats = statsOf(bundle.stats);
  if (Object.keys(stats).length) post.stats = stats;
  const published = publishedAt(bundle.publishedAt);
  if (published) post.publishedAt = published;
  const note = options.note !== undefined ? options.note : bundle.note;
  if (typeof note === 'string' && note.trim()) {
    checkLen('note', note.trim(), LIMITS.note);
    post.note = note.trim();
  }
  return post;
};

/** The id the platform de-duplicates on: from the content (not the note), so re-running one command saves one inspiration. */
const clientIdOf = (post: JsonRecord, images: readonly PlanImage[], given: string | undefined): string => {
  if (given) {
    if (length(given) > LIMITS.clientId) throw new InputError(msg('--client-id is longer than 64 characters', '--client-id 超过 64 字符'));
    return given;
  }
  const { note: _note, ...content } = post;
  const fingerprint = { post: content, images: images.map((i) => i.sha256 ?? i.url) };
  return `pb-${createHash('sha256').update(canonicalJson(fingerprint), 'utf8').digest('hex').slice(0, 40)}`;
};

/** Validates the bundle and maps it to a plan; local images are read, hashed and size-checked here. */
export const planImport = async (rt: Runtime, bundle: unknown, baseDir: string, options: PlanOptions = {}): Promise<ImportPlan> => {
  const [ok, errors] = validateBundle(bundle);
  if (!ok) throw new InputError(msg(`the PostBundle is not valid: ${errors.join('; ')}`, `PostBundle 校验失败：${errors.join('；')}`));
  const b = bundle as JsonRecord;
  if (b.parseStatus !== 'ready' && !options.allowIncomplete) {
    const errorsOf = (b.errors as string[] | undefined) ?? [];
    const missing = ((b.missing as string[] | undefined) ?? []).map((m) => msg(`missing ${m}`, `缺 ${m}`));
    const detail = [...errorsOf, ...missing].join(msg('; ', '；')) || msg('no reason given', '未说明');
    throw new InputError(
      msg(
        `PostBundle parseStatus=${String(b.parseStatus)}: the content is incomplete (${detail}). Complete it from local screenshots or text and mark it ready first, or, to save only what is there, add --allow-incomplete`,
        `PostBundle parseStatus=${String(b.parseStatus)}，内容不完整（${detail}）。先用本地截图/文字补全并标 ready，或确认只保存现有内容时加 --allow-incomplete`,
      ),
    );
  }
  const { images, skipped } = await collectImages(rt, b, baseDir);
  const post = postOf(b, options);
  if (!images.length && !post.title && !post.text && !('sourceUrl' in post))
    throw new InputError(msg('the PostBundle has nothing to save (no pictures, title, text or source link)', 'PostBundle 没有可保存的内容（无图片、标题、正文或来源链接）'));
  return { post, images, skipped, clientId: clientIdOf(post, images, options.clientId) };
};
