/**
 * Where a font library file comes from: the Skill's own `assets/fonts/` when it is there (a checkout, the web host), else
 * the download cache, else the public font bucket `<base>/<version>/<path>` (and then into the cache). A custom host
 * base uses its same-origin proxy's `@<version>` route. Downloads are
 * verified against the hashes in `palette.json` before anything is kept.
 */
import { networkReason } from '../core/error-text';
import { isFile, sha256, writeAtomic } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { FontError, type FontLibrary } from './palette';

export const DEFAULT_FONT_BASE_URL = 'https://static.popost.ai/fonts/popost';

const cacheRoot = (rt: Runtime): string | null => {
  if (rt.env.POPOST_CACHE_DIR) return rt.env.POPOST_CACHE_DIR;
  const home = rt.env.HOME || rt.env.USERPROFILE;
  return home ? rt.path.join(home, '.cache', 'popost') : null;
};

const segments = (relPath: string): string[] => relPath.split('/');

const download = async (rt: Runtime, lib: FontLibrary, relPath: string): Promise<Uint8Array> => {
  const base = (rt.env.POPOST_FONT_BASE_URL || DEFAULT_FONT_BASE_URL).replace(/\/+$/, '');
  // The public bucket stores version directories without the @ used by the web host's same-origin proxy.
  const version = base === DEFAULT_FONT_BASE_URL ? lib.digest : `@${lib.digest}`;
  const url = `${base}/${version}/${relPath}`;
  let response: Response;
  try {
    response = await rt.fetch(url);
  } catch (error) {
    const reason = networkReason(error, url);
    throw new FontError(msg(`cannot download font file ${relPath} (${url}): ${reason}`, `无法下载字体文件 ${relPath}（${url}）：${reason}`));
  }
  if (!response.ok)
    throw new FontError(msg(`cannot download font file ${relPath} (HTTP ${response.status}): ${url}`, `无法下载字体文件 ${relPath}（HTTP ${response.status}）：${url}`));
  return new Uint8Array(await response.arrayBuffer());
};

/** The bytes of `relPath` (relative to the font library root, forward slashes); `hash` is checked when given. */
export const readFontAsset = async (
  rt: Runtime,
  lib: FontLibrary,
  relPath: string,
  hash?: string,
): Promise<Uint8Array> => {
  const local = rt.path.join(lib.dir, ...segments(relPath));
  if (await isFile(rt, local)) return rt.fs.readFile(local);
  const root = cacheRoot(rt);
  const cached = root ? rt.path.join(root, 'fonts', lib.digest, ...segments(relPath)) : null;
  if (cached && (await isFile(rt, cached))) {
    const data = await rt.fs.readFile(cached);
    if (!hash || sha256(data) === hash) return data;
  }
  const data = await download(rt, lib, relPath);
  if (hash && sha256(data) !== hash) throw new FontError(msg(`font file ${relPath} does not match the library hash`, `字体文件 ${relPath} 与字库记录的哈希不一致`));
  if (cached) await writeAtomic(rt, cached, data).catch(() => undefined);
  return data;
};

/** `fn` over `items` with at most `limit` running at once; results keep the order of `items`. */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
