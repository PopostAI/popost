/**
 * Plain-language text for failures that come from the platform rather than from popost: a file the user named is
 * missing, a host cannot be reached. The messages name the path or the host and say what went wrong, without the
 * `TypeName: …` prefix, Python's `[Errno 2] …` wording or Node's `ENOENT: …` / `fetch failed` text.
 */
import { msg } from '../i18n';
import { pyRepr } from './pyjson';

type Described = { code?: unknown; path?: unknown; message?: unknown; name?: unknown; hostname?: unknown };

const fields = (value: unknown): Described => (typeof value === 'object' && value !== null ? (value as Described) : {});

const codeOf = (error: unknown): string | undefined => {
  const code = fields(error).code;
  return typeof code === 'string' ? code : undefined;
};

/** An operating-system error of a file operation (`ENOENT`, `EISDIR`, …). */
export const isSystemError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && /^E[A-Z]+$/.test(codeOf(error) ?? '');

/** The path of a file-system error: Node's `path` field, else the last quoted path of the message (other hosts). */
const pathOf = (error: unknown): string | undefined => {
  const { path, message } = fields(error);
  if (typeof path === 'string' && path) return path;
  return typeof message === 'string' ? /'([^']*)'\s*$/.exec(message)?.[1] : undefined;
};

/** What a file-system error code means for `path`; `undefined` for codes without a plain wording. */
export const fileErrorText = (code: string, path: string): string | undefined => {
  switch (code) {
    case 'ENOENT':
      return msg(`file not found: ${path}`, `文件不存在：${path}`);
    case 'EISDIR':
      return msg(`${path} is a folder, not a file`, `${path} 是文件夹，不是文件`);
    case 'ENOTDIR':
      return msg(`a part of ${path} is a file, not a folder`, `${path} 路径中有一段是文件而不是文件夹`);
    case 'EACCES':
    case 'EPERM':
      return msg(`permission denied: ${path}`, `没有权限访问：${path}`);
    case 'EEXIST':
      return msg(`already exists: ${path}`, `已存在：${path}`);
    case 'ENOTEMPTY':
      return msg(`the folder is not empty: ${path}`, `文件夹不为空：${path}`);
    case 'ENOSPC':
      return msg(`no space left on the disk for ${path}`, `磁盘空间不足，无法写入 ${path}`);
    default:
      return undefined;
  }
};

/** A file-system error as plain text naming its path; `undefined` when it has no path or no plain wording. */
const systemErrorText = (error: Error & { code: string }): string | undefined => {
  const path = pathOf(error);
  return path === undefined ? undefined : fileErrorText(error.code, path);
};

/**
 * A value as a message quotes it: `'text'` for a string, the JSON of a number, list or object, and "nothing" for a
 * missing one (never Python's `None` / `True`).
 */
export const quoted = (value: unknown): string => {
  if (value === undefined || value === null) return msg('nothing', '空值');
  return typeof value === 'string' ? pyRepr(value) : JSON.stringify(value);
};

/** A value in running text: a string as it is, anything else as `quoted` shows it. */
export const plain = (value: unknown): string => (typeof value === 'string' ? value : quoted(value));

// ---------- network ----------

/** A host that restricts the network (the popost.ai web agent's sandbox) refuses a URL with a `BlockedFetchError`. */
export const isHostBlocked = (error: unknown): boolean => fields(error).name === 'BlockedFetchError';

export const isTimeout = (error: unknown): boolean => ['TimeoutError', 'AbortError'].includes(String(fields(error).name));

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const REFUSED_CODES = new Set(['ECONNREFUSED']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const DROPPED_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNABORTED']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN']);
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
/** The code of the underlying failure of a `fetch` (undici puts it on `cause`, sometimes one level deeper). */
const networkCode = (error: unknown): string | undefined => {
  const cause = codeOf(error) === undefined ? (error as { cause?: unknown } | null)?.cause : error;
  return codeOf(cause) ?? codeOf((cause as { cause?: unknown } | null)?.cause);
};

const hostOf = (url: string | undefined, error: unknown): string => {
  try {
    if (url) return new URL(url).host;
  } catch {
    // fall back to what the error says
  }
  const hostname = fields((error as { cause?: unknown } | null)?.cause).hostname;
  return typeof hostname === 'string' && hostname ? hostname : msg('the server', '服务器');
};

/**
 * Why a request to `url` failed, as a short phrase that names the host: "the DNS lookup for x failed",
 * "x refused the connection", "x did not answer in time", … Never the `TypeError: fetch failed` wrapper.
 */
export const networkReason = (error: unknown, url?: string): string => {
  const host = hostOf(url, error);
  if (isHostBlocked(error))
    return msg(`this environment does not allow connections to ${host}`, `当前运行环境不允许访问 ${host}`);
  const code = networkCode(error) ?? '';
  if (isTimeout(error) || TIMEOUT_CODES.has(code)) return msg(`${host} did not answer in time`, `${host} 响应超时`);
  if (DNS_CODES.has(code)) return msg(`the DNS lookup for ${host} failed`, `域名 ${host} 解析失败（DNS）`);
  if (REFUSED_CODES.has(code)) return msg(`${host} refused the connection`, `${host} 拒绝了连接`);
  if (UNREACHABLE_CODES.has(code)) return msg(`${host} is unreachable from this network`, `当前网络无法到达 ${host}`);
  if (DROPPED_CODES.has(code)) return msg(`the connection to ${host} was dropped`, `与 ${host} 的连接中断`);
  if (TLS_CODES.has(code))
    return msg(`the TLS certificate of ${host} could not be verified (${code})`, `${host} 的 TLS 证书校验失败（${code}）`);
  const detail = code || plainMessage(error);
  return msg(`${host} could not be reached (${detail})`, `无法访问 ${host}（${detail}）`);
};

/** A `fetch` that failed before any answer arrived (undici's `TypeError: fetch failed`, a blocked host, a timeout). */
const isFetchFailure = (error: unknown): boolean =>
  isHostBlocked(error) ||
  (error instanceof TypeError && error.message === 'fetch failed' && networkCode(error) !== undefined);

const plainMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return error.message || error.name;
};

/**
 * What a caught error prints in `{"ok": false, "error": …}`: the message alone (the class name stays on `error.name`),
 * file-system errors as "file not found: <path>", a failed request as the host and why it could not be reached.
 */
export const errorText = (error: unknown): string => {
  const fileText = isSystemError(error) ? systemErrorText(error) : undefined;
  if (fileText) return fileText;
  if (isFetchFailure(error)) return msg(`network error: ${networkReason(error)}`, `网络错误：${networkReason(error)}`);
  return plainMessage(error);
};
