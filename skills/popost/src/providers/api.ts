/**
 * HTTPS client of the popost.ai platform OpenAPI (port of providers/popost_api.py), over `rt.fetch`.
 *
 * - Base URL: config `baseUrl` > env `POPOST_BASE_URL` > `https://popost.ai/api/open/v1`. https only; plain http is
 *   accepted for loopback hosts (`localhost`, 127.0.0.0/8, `::1`) so a developer can point the CLI at a local popost
 *   server or a test stub, where no certificate exists and the traffic never leaves the machine.
 * - The key is read only from the environment variable (default `POPOST_API_KEY`) when a request is actually sent, and
 *   never printed, logged, written to quotes, ledgers, task records, dry-run plans or error messages. The node runtime
 *   fills `POPOST_API_KEY` / `POPOST_BASE_URL` from the file saved by `popost auth set` when the environment leaves
 *   them unset (`credentials.ts`), so this client only ever reads `rt.env`.
 * - Every request carries `Authorization: Bearer`, `x-popost-client: skill`, `x-popost-client-version` (the server
 *   refuses clients that are too old by these) and a User-Agent; a body adds `content-type: application/json`. A request
 *   made in a project (`rt.project`) adds the project's task (`x-popost-task`, `-title`, `x-popost-agent-session`;
 *   task.ts), so that its charges are grouped on the account page.
 * - Answers are an envelope `{success, data, error, meta}`; `error.code` (not the HTTP status) decides.
 * - A POST that may charge (`ambiguous: true`) whose outcome is unknown (timeout, dropped connection, unparsable body,
 *   non-envelope 5xx, TIMEOUT / INTERNAL_ERROR) throws `AmbiguousSubmitError`; the caller records it and never retries.
 */
import { createHash } from 'node:crypto';
import { isHostBlocked, isTimeout, networkReason } from '../core/error-text';
import { BASE_URL_ENV, keyGuidance, keyPageUrl } from '../credentials';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { VERSION } from '../version';
import { DEFAULT_KEY_ENV, DEFAULT_KEY_PAGE, describeError, num } from './api-errors';
import { isRecord } from './base';
import { AmbiguousSubmitError, ImageProviderError, PopostApiError } from './errors';
import { taskHeaders } from './task';
import { timeoutSignal } from './time';

export { DEFAULT_KEY_ENV } from './api-errors';
export const DEFAULT_BASE_URL = 'https://popost.ai/api/open/v1';
export { BASE_URL_ENV };
export const CLIENT_NAME = 'skill';
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024; // a generation answer may inline several base64 images
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const UPLOAD_PURPOSES = ['inspiration', 'material', 'reference'] as const;
/** Generation answers with these codes leave it unknown whether the platform charged. */
const AMBIGUOUS_CODES = ['TIMEOUT', 'INTERNAL_ERROR'];

export const EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export const userAgent = (): string => `popost-skill/${VERSION} (typescript; +https://popost.ai)`;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => bytes[i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** The image type the platform accepts, by file header (the extension is never trusted); `null` when unknown. */
export const sniffImageMime = (head: Uint8Array): string | null => {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(head, 0, 6))) return 'image/gif';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const isLoopback = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
};

/** https for real services; http only for loopback. */
export const checkUrl = (url: string, what: string): string => {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url || '');
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.hostname) throw new PopostApiError(msg(`${what} is not a valid address`, `${what} 不是合法地址`), { code: 'BAD_URL' });
  if (parsed.protocol === 'https:') return url;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return url;
  throw new PopostApiError(msg(`${what} must be an https address (http is allowed only for loopback tests)`, `${what} 必须是 https 地址（http 仅允许本机回环测试）`), { code: 'BAD_URL' });
};

class TooLarge extends Error {}

/** Reads a body but stops (and cancels the stream) once it exceeds `limit` bytes. */
export const readCapped = async (response: Response, limit: number): Promise<Uint8Array> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const CONNECT_REFUSED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

const causeOf = (error: unknown): { code?: string; message?: string; name?: string } => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return isRecord(cause) ? (cause as { code?: string; message?: string; name?: string }) : {};
};

/** Refused connections, unresolvable hosts and certificate failures: the request never reached the server. */
export const isNotDelivered = (error: unknown): boolean => CONNECT_REFUSED_CODES.has(causeOf(error).code ?? '');

/**
 * A host that restricts the network (the popost.ai web agent's sandbox) refuses a URL before anything is sent; its error
 * is named `BlockedFetchError`. Nothing reached any server, so such a failure is never "outcome unknown".
 */
export { isHostBlocked, isTimeout };

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const keyEnvName = (name: string | undefined): string => {
  const keyEnv = name || DEFAULT_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(keyEnv))
    throw new PopostApiError(msg('auth.envVar must be the name of an environment variable (not the key itself)', 'auth.envVar 必须是环境变量名（不是密钥本身）'), { code: 'BAD_CONFIG' });
  return keyEnv;
};

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string>;
  timeoutSec?: number;
  ambiguous?: boolean;
  hint?: string;
}

/** The popost.ai OpenAPI client. Construction does not touch the network or read the key. */
export class PopostClient {
  readonly baseUrl: string;
  readonly keyEnv: string;
  readonly timeoutSec: number;
  lastMeta: unknown = null;
  /** An explicit credential (the cloud-save upload ticket) that is used instead of the environment key. */
  private readonly bearer: string;

  constructor(
    private readonly rt: Runtime,
    options: { baseUrl?: string | null; keyEnv?: string | null; timeoutSec?: number; bearer?: string | null } = {},
  ) {
    this.bearer = (options.bearer ?? '').trim();
    const raw = (options.baseUrl || this.rt.env[BASE_URL_ENV] || DEFAULT_BASE_URL).trim();
    this.baseUrl = checkUrl(raw.replace(/\/+$/, ''), 'popost baseUrl');
    this.keyEnv = keyEnvName(options.keyEnv ?? undefined);
    this.timeoutSec = Number(options.timeoutSec ?? 60);
  }

  // ---------- credentials ----------
  hasKey = (): boolean => Boolean(this.bearer) || (this.keyEnv === DEFAULT_KEY_ENV && Boolean(this.rt.deviceAccess)) || Boolean((this.rt.env[this.keyEnv] ?? '').trim());

  private key(): string {
    if (this.bearer) return this.bearer;
    const key = (this.rt.env[this.keyEnv] ?? '').trim();
    if (!key)
      throw new PopostApiError(
        msg(
          `No popost.ai account is connected: nothing was sent and nothing was charged. ${keyGuidance(this.keyPage(), this.keyEnv)}`,
          `尚未连接 popost.ai 账户，本次未发出请求、未扣费。${keyGuidance(this.keyPage(), this.keyEnv)}`,
        ),
        { code: 'NO_API_KEY' },
      );
    return key;
  }

  /** Where the user creates a key: on the origin of this client's API. */
  keyPage = (): string => keyPageUrl(this.baseUrl);

  private redact(text: string): string {
    const key = (this.rt.env[this.keyEnv] ?? '').trim();
    const redacted = key ? text.split(key).join('[REDACTED]') : text;
    return this.bearer ? redacted.split(this.bearer).join('[REDACTED]') : redacted;
  }

  // ---------- request building ----------
  url(path: string, query?: Record<string, string>): string {
    const base = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    return query && Object.keys(query).length ? `${base}?${new URLSearchParams(query).toString()}` : base;
  }

  headers(withBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': userAgent(), 'x-popost-client': CLIENT_NAME, 'x-popost-client-version': VERSION };
    if (withBody) headers['content-type'] = 'application/json';
    return headers;
  }

  /** Dry-run plan: nothing is sent, the key is not read, Authorization shows the variable name only. */
  describeRequest(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const headers = this.headers(body !== undefined);
    headers.Authorization = `Bearer $${this.keyEnv}`;
    return { method, url: this.url(path, query), headers, body: body ?? null };
  }

  // ---------- sending ----------
  /** Returns the envelope's `data`. See the file header for what throws `AmbiguousSubmitError`. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const { body, query, ambiguous = false, hint = '' } = options;
    const device = !this.bearer && this.keyEnv === DEFAULT_KEY_ENV && this.rt.deviceAccess;
    const key = device ? await device(this.baseUrl) : this.key();
    const wait = Number(options.timeoutSec || this.timeoutSec);
    const headers = { ...this.headers(body !== undefined), ...(await taskHeaders(this.rt)) };
    headers.Authorization = `Bearer ${key}`;
    const signal = timeoutSignal(this.rt, wait * 1000);
    const url = this.url(path, query);
    try {
      const response = await this.rt.fetch(url, { method, headers, ...(device ? {redirect:'error' as const} : {}), body: body === undefined ? undefined : JSON.stringify(body), signal });
      const raw = await this.readBody(response, ambiguous, hint);
      return this.parse(response.status, raw, ambiguous, hint, this.retryAfter(response.headers.get('retry-after')));
    } catch (error) {
      if (error instanceof ImageProviderError) throw error;
      return this.failed(error, url, wait, ambiguous, hint);
    }
  }

  /** The body of any answer; an unreadable body is an empty one for an error status and "unknown" for a success. */
  private async readBody(response: Response, ambiguous: boolean, hint: string): Promise<Uint8Array> {
    try {
      return await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (!response.ok) return new Uint8Array();
      if (error instanceof TooLarge) {
        const limit = MAX_RESPONSE_BYTES / 1048576;
        return this.uncertain(ambiguous, msg(`the answer is larger than the ${limit} MiB limit`, `响应超过 ${limit} MiB 上限`), hint);
      }
      throw error;
    }
  }

  /** A request that got no answer: the host and why (DNS, refused, timeout, …), never the fetch error's own text. */
  private failed(error: unknown, url: string, wait: number, ambiguous: boolean, hint: string): never {
    if (isHostBlocked(error)) {
      const host = hostOf(url);
      throw new PopostApiError(
        msg(`This environment does not allow connections to ${host}: the request was not sent and nothing was charged`, `当前运行环境不允许访问该地址（${host}）：请求未发出，未产生费用`),
        { code: 'NETWORK' },
      );
    }
    const reason = this.redact(networkReason(error, url)).slice(0, 200);
    if (isNotDelivered(error))
      throw new PopostApiError(
        msg(`Could not reach popost.ai: ${reason}. The request was not delivered and nothing was charged`, `无法连接 popost.ai（${reason}）：请求未送达，未产生费用`),
        { code: 'NETWORK' },
      );
    if (isTimeout(error)) return this.uncertain(ambiguous, msg(`no answer within ${num(wait)}s`, `等待响应超过 ${num(wait)}s`), hint);
    return this.uncertain(ambiguous, msg(`network error: ${reason}`, `网络错误：${reason}`), hint);
  }

  private uncertain(ambiguous: boolean, what: string, hint: string): never {
    if (ambiguous)
      throw new AmbiguousSubmitError(
        msg(`The popost.ai request was sent but its outcome is unknown (${what}); it may have been charged. ${hint}`, `popost.ai 请求已发出但结果不确定（${what}），可能已扣费。${hint}`).trimEnd(),
      );
    throw new PopostApiError(msg(`The popost.ai request failed (${what}). ${hint || 'Try again later.'}`, `popost.ai 请求失败（${what}）。${hint || '请稍后重试'}`), { code: 'NETWORK' });
  }

  /** Seconds a `Retry-After` header asks for (a number of seconds or an HTTP date); undefined without one. */
  private retryAfter(header: string | null): number | undefined {
    const text = (header ?? '').trim();
    if (!text) return undefined;
    const seconds = /^\d+$/.test(text) ? Number(text) : (Date.parse(text) - this.rt.now().getTime()) / 1000;
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
  }

  private parse(status: number, raw: Uint8Array, ambiguous: boolean, hint: string, retryAfter?: number): unknown {
    let envelope: unknown = null;
    try {
      envelope = raw.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) : null;
    } catch {
      envelope = null;
    }
    if (isRecord(envelope) && typeof envelope.success === 'boolean') {
      if (envelope.success) return this.successData(envelope, status, ambiguous, hint);
      return this.refusal(envelope, status, ambiguous, hint, retryAfter);
    }
    // Not an envelope: an unparsable 2xx or a gateway 5xx means the request may have been processed.
    if (ambiguous && (status === 0 || (status >= 200 && status < 300) || status >= 500))
      throw new AmbiguousSubmitError(
        msg(`The popost.ai answer could not be read (HTTP ${status}); the outcome is unknown and it may have been charged. ${hint}`, `popost.ai 响应无法解析（HTTP ${status}），结果不确定，可能已扣费。${hint}`).trimEnd(),
      );
    throw new PopostApiError(msg(`popost.ai gave an unexpected answer (HTTP ${status}): check the baseUrl or try again later`, `popost.ai 返回非标准响应（HTTP ${status}）：请检查 baseUrl 或稍后重试`), { code: 'BAD_RESPONSE', status });
  }

  private successData(envelope: Record<string, unknown>, status: number, ambiguous: boolean, hint: string): unknown {
    if (!('data' in envelope)) {
      if (ambiguous)
        throw new AmbiguousSubmitError(
          msg(`The popost.ai answer has no data; the outcome is unknown and it may have been charged. ${hint}`, `popost.ai 响应缺少 data，结果不确定，可能已扣费。${hint}`).trimEnd(),
        );
      throw new PopostApiError(msg(`The popost.ai answer has no data (HTTP ${status})`, `popost.ai 响应缺少 data（HTTP ${status}）`), { code: 'BAD_RESPONSE', status });
    }
    this.lastMeta = envelope.meta;
    return envelope.data;
  }

  private refusal(envelope: Record<string, unknown>, status: number, ambiguous: boolean, hint: string, retryAfter?: number): never {
    const given = isRecord(envelope.error) ? envelope.error : {};
    // A rate limit's wait: the details say it, else the Retry-After header does.
    const err = retryAfter !== undefined && given.code === 'RATE_LIMITED' && !(isRecord(given.details) && given.details.retryAfterSeconds !== undefined)
      ? { ...given, details: { ...(isRecord(given.details) ? given.details : {}), retryAfterSeconds: retryAfter } } : given;
    const code = String(err.code || 'UNKNOWN').slice(0, 64);
    const text = this.redact(describeError(code, err.message, err.details, this.keyEnv)).replace(DEFAULT_KEY_PAGE, this.keyPage());
    if (ambiguous && AMBIGUOUS_CODES.includes(code))
      throw new AmbiguousSubmitError(msg(`${text}; whether the platform charged cannot be determined. ${hint}`, `${text}；平台是否已扣费无法确定。${hint}`).trimEnd());
    throw new PopostApiError(text, { code, status, details: err.details });
  }

  // ---------- uploads ----------
  /**
   * `POST /uploads` for a ticket, then the bytes go to the returned URL as the ticket says (method, URL, headers) and
   * without Authorization or the platform headers. Returns `{uploadId, fileUrl, ...}`.
   */
  async uploadBytes(raw: Uint8Array, fileName: string, mimeType: string, purpose: string) {
    if (!(UPLOAD_PURPOSES as readonly string[]).includes(purpose))
      throw new PopostApiError(msg(`purpose must be one of ${UPLOAD_PURPOSES.join('/')}`, `purpose 必须是 ${UPLOAD_PURPOSES.join('/')} 之一`), { code: 'BAD_ARGS' });
    if (raw.length > MAX_UPLOAD_BYTES)
      throw new PopostApiError(msg(`${fileName} is larger than the 30 MiB upload limit`, `文件 ${fileName} 超过 30 MiB 上传上限`), { code: 'TOO_LARGE' });
    const sha = createHash('sha256').update(raw).digest('hex');
    const ticket = await this.request('POST', '/uploads', { body: { fileName, mimeType, bytes: raw.length, purpose, sha256: sha } });
    if (!isRecord(ticket)) throw new PopostApiError(msg('the POST /uploads answer has an unexpected format', 'POST /uploads 响应格式不符'), { code: 'BAD_RESPONSE' });
    const method = String(ticket.method || 'PUT').toUpperCase();
    const ticketHeaders = ticket.headers ?? {};
    if (!['PUT', 'POST'].includes(method) || !isRecord(ticketHeaders) || typeof ticket.uploadUrl !== 'string' || typeof ticket.fileUrl !== 'string')
      throw new PopostApiError(msg('the POST /uploads answer lacks the upload address, method or file address', 'POST /uploads 响应缺少上传地址/方法/文件地址'), { code: 'BAD_RESPONSE' });
    const uploadUrl = checkUrl(ticket.uploadUrl, 'uploadUrl');
    const fileUrl = checkUrl(ticket.fileUrl, 'fileUrl');
    const headers = Object.fromEntries(Object.entries(ticketHeaders).map(([k, v]) => [String(k), String(v)]));
    // A declared mimeType keeps the signature and the type consistent when the ticket names no content-type.
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = mimeType;
    await this.putBytes(uploadUrl, method, headers, raw, fileName);
    return { uploadId: ticket.uploadId, fileUrl, sha256: sha, bytes: raw.length, mimeType, fileName };
  }

  /**
   * PUTs bytes to an address the platform signed for one upload (the `uploadUrl` of a new voice or a transcription),
   * with only `Content-Type`: no Authorization and no platform headers. `retry` says what the user can do after a failure.
   */
  async putSigned(url: string, raw: Uint8Array, contentType: string, fileName: string, retry: string): Promise<void> {
    await this.putBytes(checkUrl(url, 'uploadUrl'), 'PUT', { 'Content-Type': contentType }, raw, fileName, retry);
  }

  private async putBytes(url: string, method: string, headers: Record<string, string>, raw: Uint8Array, fileName: string, retry = msg('try the import again', '请重试导入')): Promise<void> {
    const signal = timeoutSignal(this.rt, Math.max(this.timeoutSec, 120) * 1000);
    let response: Response;
    try {
      // `raw` is a plain byte array, never a shared buffer, so it is a valid fetch body.
      response = await this.rt.fetch(url, { method, headers, body: raw as Uint8Array<ArrayBuffer>, signal });
    } catch (error) {
      const reason = networkReason(error, url);
      throw new PopostApiError(msg(`Uploading ${fileName} failed (${reason}); ${retry}`, `上传 ${fileName} 失败（${reason}），${retry}`), { code: 'UPLOAD_FAILED' });
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      throw new PopostApiError(
        msg(`The storage service refused the upload of ${fileName} (HTTP ${response.status}); ${retry}`, `上传 ${fileName} 被存储服务拒绝（HTTP ${response.status}），${retry}`),
        { code: 'UPLOAD_FAILED', status: response.status },
      );
  }
}

/** How a failed download is worded: what was fetched ("the result image"), and what the user can do next. */
export interface DownloadLabels {
  readonly what?: string;
  readonly retry?: string;
}

/** Downloads a picture the platform returned (https, no Authorization) and writes it to `dest`. */
export const downloadResult = async (rt: Runtime, url: string, dest: string, maxBytes = MAX_DOWNLOAD_BYTES, timeoutSec = 120, labels: DownloadLabels = {}): Promise<Uint8Array> => {
  const { what = msg('the result image', '结果图'), retry = msg('the task record is kept; run download again later', '任务记录仍在，可稍后重试 download') } = labels;
  checkUrl(url, msg(`the address of ${what}`, `${what}地址`));
  let data: Uint8Array;
  try {
    const response = await rt.fetch(url, { headers: { 'User-Agent': userAgent() }, signal: timeoutSignal(rt, timeoutSec * 1000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PopostApiError(msg(`Downloading ${what} failed (HTTP ${response.status}); ${retry}`, `${what}下载失败（HTTP ${response.status}）；${retry}`), { code: 'DOWNLOAD_FAILED', status: response.status });
    }
    data = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof PopostApiError) throw error;
    const limit = maxBytes / 1048576;
    if (error instanceof TooLarge) throw new PopostApiError(msg(`${what} is larger than the ${limit} MiB download limit`, `${what}超过 ${limit} MiB 下载上限`), { code: 'TOO_LARGE' });
    const reason = networkReason(error, url);
    throw new PopostApiError(msg(`Downloading ${what} failed (${reason}); ${retry}`, `${what}下载失败（${reason}）；${retry}`), { code: 'DOWNLOAD_FAILED' });
  }
  await rt.fs.writeFile(dest, data);
  return data;
};
