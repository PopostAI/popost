/**
 * Unified PostBundle for the five platforms, `postbundle.v1` (port of `post_bundle.py`). Pure local, no network:
 * - a pending ticket only records the source URL and platform; nothing is fetched or parsed, and a bundle stays at
 *   `parseStatus=pending` until a real parser fills it in. It is never faked into `ready`;
 * - `validateBundle` checks the structure of a bundle the user supplies;
 * - `evaluateBuildable` decides whether it can be built: missing images, no authorization or a pending parse block it.
 */
import type { Runtime } from '../runtime';
import { isObject, pyRepr, pyStr, truthy } from '../core/pyjson';
import { fromCwd } from './io';
import { ValueError } from './errors';

export const SCHEMA = 'postbundle.v1';
export const PLATFORMS = ['tiktok', 'xiaohongshu', 'instagram', 'douyin', 'x'] as const;
export const PARSE_STATUSES = ['pending', 'ready', 'auth_failed', 'missing_resources', 'error'] as const;
export const RESOURCE_KINDS = ['image', 'video', 'music'] as const;

export type Bundle = Record<string, unknown>;

/** Interface definition of a future parse service: a placeholder, with no client and no call. */
export const SERVICE_CONFIG = {
  schema: 'parse-service-config.v1',
  status: 'pending', // not connected: nothing may claim to have been parsed
  endpoint: null,
  authEnv: null,
  note: '未来解析服务就绪前，用户 URL 只能产生 pending ticket；本对象仅是接口占位，无客户端、无 scrape、无 API 调用。',
};

const isPlatform = (value: unknown): boolean => typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/** Python's `datetime.now(timezone.utc).isoformat(timespec="seconds")`. */
const utcNow = (rt: Runtime): string => `${rt.now().toISOString().slice(0, 19)}+00:00`;

/** A pending ticket for a URL the user gave. Never fetches anything. */
export const makePendingTicket = (rt: Runtime, url: string, platform: string): Bundle => {
  const sourceUrl = (url ?? '').trim();
  const name = (platform ?? '').trim().toLowerCase();
  if (!sourceUrl) throw new ValueError('sourceURL 不能为空');
  if (!isPlatform(name)) throw new ValueError(`platform 必须是 ${PLATFORMS.join('/')} 之一，收到 ${pyRepr(name)}`);
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
      note: 'future parse service not connected; ticket only, nothing fetched',
    },
    errors: ['parse service pending; 未抓取任何内容'],
    missing: ['title', 'body', 'resources'],
    createdAt: utcNow(rt),
  };
};

/** `data.get(key, fallback)`: only an absent key falls back, an explicit null stays null. */
const getOr = (data: Bundle, key: string, fallback: unknown): unknown => (data[key] === undefined ? fallback : data[key]);
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateResources = (resources: unknown): string[] => {
  if (!Array.isArray(resources)) return ['resources 必须是数组'];
  const errors: string[] = [];
  const seen = new Set<string>();
  resources.forEach((res: unknown, i) => {
    if (!isObject(res)) {
      errors.push(`resources[${i}] 必须是 object`);
      return;
    }
    const id = res.id;
    if (typeof id !== 'string' || !id) errors.push(`resources[${i}].id 必须是非空字符串`);
    else if (seen.has(id)) errors.push(`resources[${i}].id 重复: ${pyRepr(id)}`);
    else seen.add(id);
    if (!(RESOURCE_KINDS as readonly unknown[]).includes(res.kind))
      errors.push(`resources[${i}].kind 必须是 ${RESOURCE_KINDS.join('/')} 之一`);
  });
  return errors;
};

const validateHeader = (data: Bundle): string[] => {
  const errors: string[] = [];
  if (data.schema !== SCHEMA) errors.push(`schema 必须为 ${pyRepr(SCHEMA)}`);
  if (!isPlatform(data.platform))
    errors.push(`platform 必须是 ${PLATFORMS.join('/')} 之一，收到 ${pyRepr(data.platform)}`);
  if (typeof data.sourceURL !== 'string' || !data.sourceURL.trim()) errors.push('sourceURL 必须是非空字符串');
  if (!(PARSE_STATUSES as readonly unknown[]).includes(data.parseStatus))
    errors.push(`parseStatus 必须是 ${PARSE_STATUSES.join('/')} 之一`);
  for (const field of ['title', 'body'])
    if (typeof getOr(data, field, '') !== 'string') errors.push(`${field} 必须是字符串`);
  return errors;
};

const validateMeta = (data: Bundle): string[] => {
  const errors: string[] = [];
  if (!isStringList(getOr(data, 'tags', []))) errors.push('tags 必须是字符串数组');
  const music = getOr(data, 'music', {});
  if (!isObject(music) || !['title', 'url'].every((key) => typeof getOr(music, key, '') === 'string'))
    errors.push('music 必须是 {title:str, url:str}');
  const order = getOr(data, 'pageOrder', []);
  if (!Array.isArray(order) || !order.every((n) => Number.isInteger(n) && (n as number) >= 1))
    errors.push('pageOrder 必须是正整数数组');
  const ratio = data.ratio;
  if (ratio !== undefined && ratio !== null && typeof ratio !== 'string') errors.push("ratio 必须是 'W:H' 字符串或 null");
  const auth = getOr(data, 'auth', {});
  if (
    !isObject(auth) ||
    typeof getOr(auth, 'required', false) !== 'boolean' ||
    typeof getOr(auth, 'authorized', false) !== 'boolean'
  )
    errors.push('auth 必须是 {required:bool, authorized:bool, note:str}');
  return errors;
};

/** `[ok, errors]`: structure and types only; whether the bundle can be built is `evaluateBuildable`'s question. */
export const validateBundle = (data: unknown): [boolean, string[]] => {
  if (!isObject(data)) return [false, ['bundle 必须是 JSON object']];
  const errors = [...validateHeader(data), ...validateMeta(data), ...validateResources(getOr(data, 'resources', []))];
  if (!isStringList(getOr(data, 'errors', []))) errors.push('errors 必须是字符串数组');
  if (!isStringList(getOr(data, 'missing', []))) errors.push('missing 必须是字符串数组');
  return [errors.length === 0, errors];
};

const resourceBlocker = async (rt: Runtime, res: Bundle, baseDir: string | null): Promise<string | null> => {
  const id = pyStr(getOr(res, 'id', '?'));
  const path = res.path;
  if (truthy(path)) {
    const text = String(path);
    const full = rt.path.isAbsolute(text) || !baseDir ? text : rt.path.join(baseDir, text);
    return (await rt.fs.stat(fromCwd(rt, full)))?.isFile ? null : `resource ${id} 缺图：本地文件不存在 ${pyRepr(path)}`;
  }
  if (truthy(res.url)) return truthy(res.license) ? null : `resource ${id} 仅给 url 但无 license/署名，缺授权`;
  return `resource ${id} 既无 path 也无 url，缺图阻断`;
};

/**
 * `{buildable, blockers}`. Anything but `parseStatus=ready` blocks, so does a required but missing authorization, and
 * every resource needs a usable place: an existing local file (relative to `baseDir`) or an explicit URL with a license.
 */
export const evaluateBuildable = async (rt: Runtime, bundle: Bundle, baseDir: string | null = null) => {
  const blockers: string[] = [];
  if (bundle.parseStatus !== 'ready')
    blockers.push(`parseStatus=${pyRepr(bundle.parseStatus)} 非 ready（解析服务未就绪，不伪 build）`);
  const auth = truthy(bundle.auth) ? (bundle.auth as Bundle) : {};
  if (truthy(auth.required) && !truthy(auth.authorized)) blockers.push('auth.required 且 authorized=false（授权缺失，不得 build）');
  const resources = Array.isArray(bundle.resources) ? bundle.resources : [];
  for (const res of resources as Bundle[]) {
    const blocker = await resourceBlocker(rt, res, baseDir);
    if (blocker) blockers.push(blocker);
  }
  const missing = Array.isArray(bundle.missing) ? bundle.missing : [];
  for (const item of missing) blockers.push(`bundle 仍声明缺项: ${pyStr(item)}`);
  return { buildable: blockers.length === 0, blockers };
};
