/**
 * The stored API key: `<home>/.popost/credentials.json` (the directory can be moved with `POPOST_HOME`), written by
 * `popost auth set`, owner-only where the OS supports it. It is a user-level file outside every project, so a key never
 * ends up in a project, a ZIP or a commit.
 *
 * Resolution order: the environment variables `POPOST_API_KEY` / `POPOST_BASE_URL` first, then this file. The node
 * runtime applies the file once, when it builds `env` (`applyStoredCredentials`), so everything that reads the key
 * (`PopostClient`, the secret scrubber) keeps reading `rt.env`. A host that runs the CLI in-process and passes its own
 * `env` and no `homeDir` never touches the file.
 */
import type { Runtime } from './runtime';
import { DEFAULT_KEY_ENV } from './providers/api-errors';

export const BASE_URL_ENV = 'POPOST_BASE_URL';
export const HOME_ENV = 'POPOST_HOME';
export const CREDENTIALS_DIR = '.popost';
export const CREDENTIALS_FILE = 'credentials.json';
const DEFAULT_ORIGIN = 'https://popost.ai';

export interface StoredCredentials {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** The parts of a runtime needed to locate the file (the node runtime asks before its own `Runtime` exists). */
export type CredentialsLocation = Pick<Runtime, 'homeDir' | 'env' | 'path' | 'cwd'>;

export type StoredState =
  | { readonly status: 'unsupported' }
  | { readonly status: 'absent'; readonly file: string }
  | { readonly status: 'ok'; readonly file: string; readonly credentials: StoredCredentials }
  | { readonly status: 'corrupt'; readonly file: string; readonly reason: string };

/** The directory of the credentials file; `undefined` when the host has no home directory. */
export const credentialsDir = (rt: CredentialsLocation): string | undefined => {
  if (rt.homeDir === undefined) return undefined;
  const override = (rt.env[HOME_ENV] ?? '').trim();
  return override ? rt.path.resolve(rt.cwd, override) : rt.path.join(rt.homeDir, CREDENTIALS_DIR);
};

export const credentialsFile = (rt: CredentialsLocation): string | undefined => {
  const dir = credentialsDir(rt);
  return dir === undefined ? undefined : rt.path.join(dir, CREDENTIALS_FILE);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's content; `null` when it is not a JSON object with string fields. Empty strings count as absent. */
export const parseCredentials = (text: string): StoredCredentials | null => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  const read = (name: string): string | undefined | null => {
    const value = data[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return null;
    return value.trim() || undefined;
  };
  const apiKey = read('apiKey');
  const baseUrl = read('baseUrl');
  if (apiKey === null || baseUrl === null) return null;
  return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
};

/** `env` plus the stored values for the variables that are unset or blank; the environment always wins. */
export const applyStoredCredentials = (
  env: Readonly<Record<string, string | undefined>>,
  stored: StoredCredentials | null | undefined,
): Readonly<Record<string, string | undefined>> => {
  if (!stored) return env;
  const out: Record<string, string | undefined> = { ...env };
  if (stored.apiKey && !(env[DEFAULT_KEY_ENV] ?? '').trim()) out[DEFAULT_KEY_ENV] = stored.apiKey;
  if (stored.baseUrl && !(env[BASE_URL_ENV] ?? '').trim()) out[BASE_URL_ENV] = stored.baseUrl;
  return out;
};

/** Reads the file through the runtime; never throws (an unreadable file is reported as `corrupt`). */
export const readStoredCredentials = async (rt: Runtime): Promise<StoredState> => {
  const file = credentialsFile(rt);
  if (file === undefined) return { status: 'unsupported' };
  try {
    if (!(await rt.fs.stat(file))) return { status: 'absent', file };
    const credentials = parseCredentials(await rt.fs.readText(file));
    return credentials
      ? { status: 'ok', file, credentials }
      : { status: 'corrupt', file, reason: 'not a JSON object with an apiKey string' };
  } catch (error) {
    return { status: 'corrupt', file, reason: error instanceof Error ? error.message : String(error) };
  }
};

/** Replaces the whole file, owner-only; the temporary file is renamed over it so a crash never leaves half a key. */
export const writeStoredCredentials = async (rt: Runtime, file: string, credentials: StoredCredentials): Promise<void> => {
  const tmp = `${file}.${rt.randomUUID()}.tmp`;
  const body = `${JSON.stringify({ apiKey: credentials.apiKey, ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}) }, null, 2)}\n`;
  try {
    await rt.fs.writeFile(tmp, body, { private: true });
    await rt.fs.rename(tmp, file);
  } finally {
    await rt.fs.rm(tmp);
  }
};

export const clearStoredCredentials = (rt: Runtime, file: string): Promise<void> => rt.fs.rm(file);

/** First characters of a key and dots; never more than half of a short key. */
export const maskKey = (key: string): string => `${key.slice(0, Math.min(8, Math.floor(key.length / 2)))}....`;

/** The page where the user creates a key: on the origin of the API in use (default https://popost.ai). */
export const keyPageUrl = (baseUrl?: string): string => {
  let origin = DEFAULT_ORIGIN;
  try {
    if (baseUrl) origin = new URL(baseUrl).origin;
  } catch {
    // an unparsable address: the default page is still the right place to get a key
  }
  return `${origin}/account/api-keys`;
};

/** The one-line next step shown wherever a key is missing; `keyEnv` is the variable the channel reads. */
export const keyGuidance = (page: string, keyEnv: string): string =>
  `运行 popost auth login，把验证链接和设备码发给用户。连接后用 popost account 核对账户。管理连接：${page}。开发者也可通过宿主设置 ${keyEnv}，或在自己的终端使用 popost auth set --prompt`;
