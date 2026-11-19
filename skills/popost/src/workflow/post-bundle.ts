/**
 * Unified PostBundle for the five platforms, `postbundle.v1` (port of `post_bundle.py`). Pure local, no network:
 * - a pending ticket only records the source URL and platform; nothing is fetched or parsed, and a bundle stays at
 *   `parseStatus=pending` until a real parser fills it in. It is never faked into `ready`;
 * - `validateBundle` checks the structure of a bundle the user supplies;
 * - `evaluateBuildable` decides whether it can be built: missing images, no authorization or a pending parse block it.
 */
import type { Runtime } from '../runtime';
import { plain, quoted } from '../core/error-text';
import { isObject, truthy } from '../core/pyjson';
import { msg } from '../i18n';
import { fromCwd } from './io';
import { ValueError } from './errors';

export const SCHEMA = 'postbundle.v1';
export const PLATFORMS = ['tiktok', 'xiaohongshu', 'instagram', 'douyin', 'x'] as const;
export const PARSE_STATUSES = ['pending', 'ready', 'auth_failed', 'missing_resources', 'error'] as const;
export const RESOURCE_KINDS = ['image', 'video', 'music'] as const;

export type Bundle = Record<string, unknown>;

/** Interface definition of a future parse service: a placeholder, with no client and no call. */
export const serviceConfig = () => ({
  schema: 'parse-service-config.v1',
  status: 'pending', // not connected: nothing may claim to have been parsed
  endpoint: null,
  authEnv: null,
  note: msg(
    'Until a parse service is connected, a user URL only produces a pending ticket; this object is an interface placeholder: no client, no scraping, no API call.',
    '未来解析服务就绪前，用户 URL 只能产生 pending ticket；本对象仅是接口占位，无客户端、无 scrape、无 API 调用。',
  ),
});

export type Platform = (typeof PLATFORMS)[number];
const isPlatform = (value: unknown): value is Platform => typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/** Python's `datetime.now(timezone.utc).isoformat(timespec="seconds")`. */
const utcNow = (rt: Runtime): string => `${rt.now().toISOString().slice(0, 19)}+00:00`;

/** The hosts of each platform's post links, short links included (the same list as popost.ai's link input). */
export const PLATFORM_HOSTS: Readonly<Record<Platform, readonly string[]>> = {
  douyin: ['douyin.com', 'iesdouyin.com'],
  tiktok: ['tiktok.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  instagram: ['instagram.com'],
  x: ['x.com', 'twitter.com'],
};

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The platform a post link belongs to, or `null` for a link of none of them (or no web link at all). */
export const platformOfUrl = (url: string): Platform | null => {
  const host = hostOf(url);
  if (!host) return null;
  const match = PLATFORMS.find((name) => PLATFORM_HOSTS[name].some((domain) => host === domain || host.endsWith(`.${domain}`)));
  return match ?? null;
};

/** Refuses a link that is not a post link of the platform the ticket names. */
const checkTicketUrl = (url: string, platform: Platform): void => {
  if (!hostOf(url)) throw new ValueError(msg(`--url must be a web link (https://…), got ${quoted(url)}`, `--url 必须是网页链接（https://…），收到 ${quoted(url)}`));
  const actual = platformOfUrl(url);
  if (actual === platform) return;
  throw new ValueError(
    actual
      ? msg(`${url} is a ${actual} link, not ${platform}: pass --platform ${actual}`, `${url} 是 ${actual} 链接，不是 ${platform}：请传 --platform ${actual}`)
      : msg(
          `${url} is not a ${platform} link (expected a host under ${PLATFORM_HOSTS[platform].join(' or ')})`,
          `${url} 不是 ${platform} 链接（域名应在 ${PLATFORM_HOSTS[platform].join(' 或 ')} 之下）`,
        ),
  );
};

/** A pending ticket for a URL the user gave. Never fetches anything. */
export const makePendingTicket = (rt: Runtime, url: string, platform: string): Bundle => {
  const sourceUrl = (url ?? '').trim();
  const name = (platform ?? '').trim().toLowerCase();
  if (!sourceUrl) throw new ValueError(msg('sourceURL must not be empty', 'sourceURL 不能为空'));
  if (!isPlatform(name)) throw new ValueError(platformError(name));
  checkTicketUrl(sourceUrl, name);
  return {
    schema: SCHEMA,
    platform: name,
    sourceURL: sourceUrl,
    title: '',
    body: '',
    tags: [],
    music: { title: '', url: '' },
    pageOrder: [1],
    ratio: null,
    resources: [],
    parseStatus: 'pending',
    auth: {
      required: true,
      authorized: false,
      note: msg('future parse service not connected; ticket only, nothing fetched', '解析服务未接入；只生成 ticket，未抓取任何内容'),
    },
    errors: [msg('parse service pending; nothing was fetched', 'parse service pending; 未抓取任何内容')],
    missing: ['title', 'body', 'resources'],
    createdAt: utcNow(rt),
  };
};

const platformError = (value: unknown): string =>
  msg(`platform must be one of ${PLATFORMS.join('/')}, got ${quoted(value)}`, `platform 必须是 ${PLATFORMS.join('/')} 之一，收到 ${quoted(value)}`);

/** `data.get(key, fallback)`: only an absent key falls back, an explicit null stays null. */
const getOr = (data: Bundle, key: string, fallback: unknown): unknown => (data[key] === undefined ? fallback : data[key]);
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateResources = (resources: unknown): string[] => {
  if (!Array.isArray(resources)) return [msg('resources must be an array', 'resources 必须是数组')];
  const errors: string[] = [];
  const seen = new Set<string>();
  resources.forEach((res: unknown, i) => {
    if (!isObject(res)) {
      errors.push(msg(`resources[${i}] must be an object`, `resources[${i}] 必须是 object`));
      return;
    }
    const id = res.id;
    if (typeof id !== 'string' || !id) errors.push(msg(`resources[${i}].id must be a non-empty string`, `resources[${i}].id 必须是非空字符串`));
    else if (seen.has(id)) errors.push(msg(`resources[${i}].id is a duplicate: ${quoted(id)}`, `resources[${i}].id 重复: ${quoted(id)}`));
    else seen.add(id);
    if (!(RESOURCE_KINDS as readonly unknown[]).includes(res.kind))
      errors.push(msg(`resources[${i}].kind must be one of ${RESOURCE_KINDS.join('/')}`, `resources[${i}].kind 必须是 ${RESOURCE_KINDS.join('/')} 之一`));
  });
  return errors;
};

const validateHeader = (data: Bundle): string[] => {
  const errors: string[] = [];
  if (data.schema !== SCHEMA) errors.push(msg(`schema must be ${quoted(SCHEMA)}`, `schema 必须为 ${quoted(SCHEMA)}`));
  if (!isPlatform(data.platform)) errors.push(platformError(data.platform));
  if (typeof data.sourceURL !== 'string' || !data.sourceURL.trim()) errors.push(msg('sourceURL must be a non-empty string', 'sourceURL 必须是非空字符串'));
  if (!(PARSE_STATUSES as readonly unknown[]).includes(data.parseStatus))
    errors.push(msg(`parseStatus must be one of ${PARSE_STATUSES.join('/')}`, `parseStatus 必须是 ${PARSE_STATUSES.join('/')} 之一`));
  for (const field of ['title', 'body'])
    if (typeof getOr(data, field, '') !== 'string') errors.push(msg(`${field} must be a string`, `${field} 必须是字符串`));
  return errors;
};

const validateMeta = (data: Bundle): string[] => {
  const errors: string[] = [];
  if (!isStringList(getOr(data, 'tags', []))) errors.push(msg('tags must be an array of strings', 'tags 必须是字符串数组'));
  const music = getOr(data, 'music', {});
  if (!isObject(music) || !['title', 'url'].every((key) => typeof getOr(music, key, '') === 'string'))
    errors.push(msg('music must be {title:str, url:str}', 'music 必须是 {title:str, url:str}'));
  const order = getOr(data, 'pageOrder', []);
  if (!Array.isArray(order) || !order.every((n) => Number.isInteger(n) && (n as number) >= 1))
    errors.push(msg('pageOrder must be an array of positive integers', 'pageOrder 必须是正整数数组'));
  const ratio = data.ratio;
  if (ratio !== undefined && ratio !== null && typeof ratio !== 'string') errors.push(msg("ratio must be a 'W:H' string or null", "ratio 必须是 'W:H' 字符串或 null"));
  const auth = getOr(data, 'auth', {});
  if (
    !isObject(auth) ||
    typeof getOr(auth, 'required', false) !== 'boolean' ||
    typeof getOr(auth, 'authorized', false) !== 'boolean'
  )
    errors.push(msg('auth must be {required:bool, authorized:bool, note:str}', 'auth 必须是 {required:bool, authorized:bool, note:str}'));
  return errors;
};

/** `[ok, errors]`: structure and types only; whether the bundle can be built is `evaluateBuildable`'s question. */
export const validateBundle = (data: unknown): [boolean, string[]] => {
  if (!isObject(data)) return [false, [msg('the bundle must be a JSON object', 'bundle 必须是 JSON object')]];
  const errors = [...validateHeader(data), ...validateMeta(data), ...validateResources(getOr(data, 'resources', []))];
  if (!isStringList(getOr(data, 'errors', []))) errors.push(msg('errors must be an array of strings', 'errors 必须是字符串数组'));
  if (!isStringList(getOr(data, 'missing', []))) errors.push(msg('missing must be an array of strings', 'missing 必须是字符串数组'));
  return [errors.length === 0, errors];
};

const resourceBlocker = async (rt: Runtime, res: Bundle, baseDir: string | null): Promise<string | null> => {
  const id = plain(getOr(res, 'id', '?'));
  const path = res.path;
  if (truthy(path)) {
    const text = String(path);
    const full = rt.path.isAbsolute(text) || !baseDir ? text : rt.path.join(baseDir, text);
    if ((await rt.fs.stat(fromCwd(rt, full)))?.isFile) return null;
    return msg(`resource ${id} has no picture: the local file ${quoted(path)} does not exist`, `resource ${id} 缺图：本地文件不存在 ${quoted(path)}`);
  }
  if (truthy(res.url))
    return truthy(res.license)
      ? null
      : msg(`resource ${id} has only a url and no license or attribution: authorization is missing`, `resource ${id} 仅给 url 但无 license/署名，缺授权`);
  return msg(`resource ${id} has neither a path nor a url: the picture is missing, which blocks the build`, `resource ${id} 既无 path 也无 url，缺图阻断`);
};

/**
 * `{buildable, blockers}`. Anything but `parseStatus=ready` blocks, so does a required but missing authorization, and
 * every resource needs a usable place: an existing local file (relative to `baseDir`) or an explicit URL with a license.
 */
export const evaluateBuildable = async (rt: Runtime, bundle: Bundle, baseDir: string | null = null) => {
  const blockers: string[] = [];
  if (bundle.parseStatus !== 'ready')
    blockers.push(
      msg(
        `parseStatus=${quoted(bundle.parseStatus)} is not ready (the parse is not finished; a build would be fake)`,
        `parseStatus=${quoted(bundle.parseStatus)} 非 ready（解析服务未就绪，不伪 build）`,
      ),
    );
  const auth = truthy(bundle.auth) ? (bundle.auth as Bundle) : {};
  if (truthy(auth.required) && !truthy(auth.authorized))
    blockers.push(msg('auth.required is set and authorized=false (authorization is missing; do not build)', 'auth.required 且 authorized=false（授权缺失，不得 build）'));
  const resources = Array.isArray(bundle.resources) ? bundle.resources : [];
  for (const res of resources as Bundle[]) {
    const blocker = await resourceBlocker(rt, res, baseDir);
    if (blocker) blockers.push(blocker);
  }
  const missing = Array.isArray(bundle.missing) ? bundle.missing : [];
  for (const item of missing) blockers.push(msg(`the bundle still declares a missing item: ${plain(item)}`, `bundle 仍声明缺项: ${plain(item)}`));
  return { buildable: blockers.length === 0, blockers };
};
