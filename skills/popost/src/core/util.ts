/** Small helpers shared by every command: JSON output, hashing, timestamps, atomic writes, directory walks. */
import { createHash } from 'node:crypto';
import type { Runtime } from '../runtime';
import { compareCodePoints } from './pyjson';

export { errorText } from './error-text';

/** One JSON document on stdout, like the Python Skill's `print(json.dumps(..., ensure_ascii=False))`. */
export const printJson = (rt: Runtime, value: unknown, pretty = false): void =>
  rt.stdout(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');

/** `{"ok": false, "error": …}` on stdout and the exit code (2 unless given). */
export const fail = (rt: Runtime, error: string, code = 2, extra: Record<string, unknown> = {}): number => {
  printJson(rt, { ok: false, error, ...extra });
  return code;
};

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export const sha256File = async (rt: Runtime, path: string): Promise<string> => sha256(await rt.fs.readFile(path));

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time with its UTC offset, to the second: `2026-11-05T12:00:00+08:00` (Python `isoformat(timespec="seconds")`). */
export const isoNow = (rt: Runtime): string => {
  const now = rt.now();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

/** Write through a temporary file and rename, so a reader never sees half a file. */
export const writeAtomic = async (rt: Runtime, path: string, data: Uint8Array | string): Promise<void> => {
  const tmp = `${path}.tmp`;
  await rt.fs.writeFile(tmp, data);
  await rt.fs.rename(tmp, path);
};

export const readJson = async <T = unknown>(rt: Runtime, path: string): Promise<T> =>
  JSON.parse(await rt.fs.readText(path)) as T;

export const writeJson = (rt: Runtime, path: string, value: unknown): Promise<void> =>
  writeAtomic(rt, path, JSON.stringify(value, null, 2));

export const isFile = async (rt: Runtime, path: string): Promise<boolean> => (await rt.fs.stat(path))?.isFile ?? false;
export const isDir = async (rt: Runtime, path: string): Promise<boolean> =>
  (await rt.fs.stat(path))?.isDirectory ?? false;

/**
 * Every file under `dir` (absolute paths); empty when `dir` does not exist. The order is Python's
 * `sorted(Path.rglob('*'))`: path component by component, so `a/b` comes before `a-b` (a plain string sort would not
 * do that). The render fingerprint hashes files in this order.
 */
export const walkFiles = async (rt: Runtime, dir: string): Promise<string[]> => {
  if (!(await isDir(rt, dir))) return [];
  const out: string[] = [];
  for (const name of (await rt.fs.readdir(dir)).sort(compareCodePoints)) {
    const full = rt.path.join(dir, name);
    const stat = await rt.fs.stat(full);
    if (stat?.isDirectory) out.push(...(await walkFiles(rt, full)));
    else if (stat?.isFile) out.push(full);
  }
  return out;
};

/** POSIX relative path from `root` to `path` (manifests always store forward slashes). */
export const relPosix = (rt: Runtime, root: string, path: string): string =>
  rt.path.relative(root, path).split(rt.path.sep).join('/');

/** True when `path` is `root` or inside it, after resolving `..`. */
export const isInside = (rt: Runtime, root: string, path: string): boolean => {
  const rel = rt.path.relative(rt.path.resolve(root), rt.path.resolve(root, path));
  return rel === '' || (!rel.startsWith('..') && !rt.path.isAbsolute(rel));
};

/** Python `html.escape(text, quote=True)`. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
