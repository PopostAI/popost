/**
 * From a parsed post to a local PostBundle (`postbundle.v1`, the format `validate`, `import`, `attach-bundle` and
 * `inspiration import` read): the post as the platform returned it is read defensively (`planPost`), its pictures are
 * downloaded in order with the deterministic names `01.jpg`, `02.webp`, ... (`downloadPictures`), and the bundle that
 * points at those files is built (`buildBundle`). The pictures' signed URLs are never stored or put in a message.
 */
import { sniffImage } from '../core/image';
import { sha256 } from '../core/util';
import type { Runtime } from '../runtime';
import { PLATFORMS } from '../workflow/post-bundle';
import { downloadResult, EXTENSIONS, sniffImageMime } from './api';
import { isInt, isRecord, type JsonRecord } from './base';
import { ImageProviderError, PopostApiError } from './errors';
import { authorOf, LIMITS, publishedAt, statsOf } from './inspiration-plan';
import { msg } from '../i18n';
import { errorText } from '../core/error-text';

export interface RemoteImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

export interface PostPlan {
  readonly platform: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly text: string;
  readonly tags: string[];
  readonly author: JsonRecord;
  readonly stats: JsonRecord;
  readonly publishedAt: string | null;
  readonly note: string | null;
  readonly inspirationId: string | null;
  readonly images: RemoteImage[];
}

export interface SavedImage {
  readonly index: number;
  readonly file: string;
  readonly path: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** An answer that cannot be used (nothing is guessed from it). */
export const badResponse = (message: string): PopostApiError => new PopostApiError(message, { code: 'BAD_RESPONSE' });

const tagsOf = (raw: unknown): string[] => {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const tag = typeof item === 'string' ? item.trim().replace(/^#+/, '').trim() : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, LIMITS.tags);
};

const imageOf = (raw: unknown, index: number): RemoteImage => {
  if (!isRecord(raw) || typeof raw.url !== 'string' || !raw.url) throw badResponse(msg(`picture ${index + 1} of the parsed result has no address`, `解析结果的第 ${index + 1} 张图片缺少地址`));
  const size = (key: 'width' | 'height') => (isInt(raw[key]) && (raw[key] as number) > 0 ? { [key]: raw[key] as number } : {});
  return { url: raw.url, ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}), ...size('width'), ...size('height'), ...(text(raw.alt) ? { alt: [...text(raw.alt)].slice(0, 500).join('') } : {}) };
};

const validPublishedAt = (value: unknown): string | null => {
  try {
    return publishedAt(value);
  } catch {
    return null; // an optional field: a value the bundle readers would refuse is dropped
  }
};

/** The post of a succeeded task. `fallbackUrl` (the link the user gave) stands in for a missing `sourceUrl`. */
export const planPost = (post: JsonRecord, fallbackUrl: string | undefined, note: string | undefined): PostPlan => {
  if (!(PLATFORMS as readonly unknown[]).includes(post.platform))
    throw badResponse(msg('the platform of the parsed result is not one of X, Instagram, TikTok, Douyin, Xiaohongshu, YouTube', '解析结果的 platform 不是 X、Instagram、TikTok、抖音、小红书、YouTube 之一'));
  const sourceUrl = [text(post.sourceUrl), fallbackUrl ?? ''].find((u) => /^https?:\/\//.test(u));
  if (!sourceUrl) throw badResponse(msg('the parsed result has no sourceUrl', '解析结果缺少 sourceUrl'));
  const serverNote = text(post.note) || (note ?? '').trim();
  return {
    platform: post.platform as string,
    sourceUrl,
    title: text(post.title),
    text: text(post.text),
    tags: tagsOf(post.tags),
    author: authorOf(post.author),
    stats: statsOf(post.stats),
    publishedAt: validPublishedAt(post.publishedAt),
    note: serverNote || null,
    inspirationId: typeof post.id === 'string' ? post.id : null,
    images: (Array.isArray(post.images) ? post.images : []).map(imageOf),
  };
};

/** The post with its pictures' remote URLs, for `--no-download` (the URLs are short-lived). */
export const remoteView = (plan: PostPlan): JsonRecord => ({
  platform: plan.platform,
  title: plan.title,
  text: plan.text,
  tags: plan.tags,
  sourceUrl: plan.sourceUrl,
  imageCount: plan.images.length,
  images: plan.images.map((image, i) => ({ index: i + 1, ...image })),
});

const COMMON_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4'];

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** `W:H` of a picture size: the nearest common ratio within 2 %, else the reduced fraction. */
const ratioOf = (width: number, height: number): string => {
  const near = COMMON_RATIOS.find((r) => {
    const [w, h] = r.split(':').map(Number) as [number, number];
    return Math.abs(width / height - w / h) / (w / h) <= 0.02;
  });
  const d = gcd(width, height);
  return near ?? `${width / d}:${height / d}`;
};

const fileName = (index: number, mime: string): string => `${String(index).padStart(2, '0')}${EXTENSIONS[mime]}`;

const sizeOf = (raw: Uint8Array): { width?: number; height?: number } => {
  try {
    const { width, height } = sniffImage(raw);
    return { width, height };
  } catch {
    return {}; // the size is an optional field
  }
};

export interface Downloaded {
  readonly saved: SavedImage[];
  /** Why the download stopped before the last picture, or `null`. */
  readonly failure: string | null;
}

const reason = (error: unknown): string =>
  error instanceof ImageProviderError ? error.message : msg(`writing failed (${errorText(error)})`, `写入失败（${errorText(error)}）`);

/**
 * Downloads the pictures in order into `outDir` (no Authorization; each at most `MAX_DOWNLOAD_BYTES`; the type comes
 * from the file header, never from the URL or the server's word). Stops at the first picture that fails and keeps the
 * ones before it. `retry` is what the user is told to do about a failure.
 */
export const downloadPictures = async (rt: Runtime, images: readonly RemoteImage[], outDir: string, retry: string): Promise<Downloaded> => {
  const saved: SavedImage[] = [];
  await rt.fs.mkdir(outDir);
  for (const [i, image] of images.entries()) {
    const index = i + 1;
    const what = msg(`picture ${index}`, `第 ${index} 张图片`);
    const tmp = rt.path.join(outDir, `${String(index).padStart(2, '0')}.download`);
    try {
      const raw = await downloadResult(rt, image.url, tmp, undefined, undefined, { what, retry });
      const mime = sniffImageMime(raw.subarray(0, 16));
      if (!mime) {
        await rt.fs.rm(tmp);
        return { saved, failure: msg(`the download of ${what} is not a PNG/JPEG/WebP/GIF picture; ${retry}`, `${what}下载的内容不是 PNG/JPEG/WebP/GIF 图片；${retry}`) };
      }
      const file = fileName(index, mime);
      const path = rt.path.join(outDir, file);
      await rt.fs.rename(tmp, path);
      saved.push({ index, file, path, mimeType: mime, sha256: sha256(raw), bytes: raw.length, ...sizeOf(raw), ...(image.alt ? { alt: image.alt } : {}) });
    } catch (error) {
      await rt.fs.rm(tmp).catch(() => undefined);
      const message = reason(error);
      // a failed transfer already carries the advice
      return { saved, failure: error instanceof PopostApiError && error.code === 'DOWNLOAD_FAILED' ? message : msg(`${message}; ${retry}`, `${message}；${retry}`) };
    }
  }
  return { saved, failure: null };
};

/** UTC time to the second with a `+00:00` offset, as the pending ticket writes `createdAt`. */
const utcNow = (rt: Runtime): string => `${rt.now().toISOString().slice(0, 19)}+00:00`;

/** The PostBundle for a downloaded post; its resources are the files in `saved`, as paths relative to the bundle file. */
export const buildBundle = (rt: Runtime, plan: PostPlan, saved: readonly SavedImage[]): JsonRecord => {
  const first = saved[0];
  const complete = saved.length > 0;
  return {
    schema: 'postbundle.v1',
    platform: plan.platform,
    sourceURL: plan.sourceUrl,
    title: plan.title,
    body: plan.text,
    tags: plan.tags,
    music: { title: '', url: '' },
    pageOrder: saved.map((s) => s.index),
    ratio: first?.width && first.height ? ratioOf(first.width, first.height) : null,
    resources: saved.map((s) => ({
      id: `img${s.index}`,
      kind: 'image',
      path: s.file,
      mimeType: s.mimeType,
      sha256: s.sha256,
      ...(s.width && s.height ? { width: s.width, height: s.height } : {}),
      ...(s.alt ? { alt: s.alt } : {}),
    })),
    parseStatus: complete ? 'ready' : 'missing_resources',
    auth: {
      required: false,
      authorized: true,
      note: msg('parsed by popost.ai from the public link; no login was needed', '由 popost.ai 从公开链接解析；无需登录'),
    },
    errors: complete ? [] : [msg('the post has no pictures', '帖子里没有图片')],
    missing: complete ? [] : ['resources'],
    ...(Object.keys(plan.author).length ? { author: plan.author } : {}),
    ...(Object.keys(plan.stats).length ? { stats: plan.stats } : {}),
    ...(plan.publishedAt ? { publishedAt: plan.publishedAt } : {}),
    ...(plan.note ? { note: plan.note } : {}),
    createdAt: utcNow(rt),
  };
};
