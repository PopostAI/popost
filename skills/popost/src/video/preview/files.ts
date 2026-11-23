/**
 * Serving files read-only: the project's pictures under /project/ and the reference video, with HTTP Range support
 * so that a video element can seek. A path that resolves outside its root is refused. Files are read whole from
 * rt.fs and a range is cut out of them: the files a preview serves are pictures and short clips.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Runtime } from '../../runtime';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

/** What a scene's page may do (the same policy the renderer sends, render/session.ts SCENE_POLICY): no connection of any kind. */
const SCENE_POLICY = "default-src 'self' data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/** The extension of a file name, with its dot, as node:path's extname gives it ("" for ".hidden"). */
const extensionOf = (file: string): string => {
  const name = file.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};

export const contentType = (file: string): string => CONTENT_TYPES[extensionOf(file).toLowerCase()] ?? 'application/octet-stream';

const inside = (rt: Runtime, root: string, file: string): boolean => {
  const rel = rt.path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + rt.path.sep) && !rt.path.isAbsolute(rel);
};

/**
 * The absolute path of rel inside root, or undefined when it lies outside (by "..", an absolute path, or a symbolic
 * link that points out of root; a file system without realpath has no links). A file that does not exist is returned
 * as is; the caller answers 404.
 */
export const resolveInside = async (rt: Runtime, root: string, rel: string): Promise<string | undefined> => {
  const base = rt.path.resolve(rt.cwd, root);
  const file = rt.path.resolve(base, rel.replace(/^[/\\]+/, ''));
  if (!inside(rt, base, file)) return undefined;
  if (!rt.fs.realpath) return file;
  try {
    return inside(rt, await rt.fs.realpath(base), await rt.fs.realpath(file)) ? file : undefined;
  } catch {
    return file;
  }
};

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | undefined;

/**
 * One range of a "Range: bytes=..." header for a file of size bytes; end is inclusive. undefined: no header, another
 * unit, or several ranges (the whole file is sent then, which every client accepts).
 */
export const parseRange = (header: string | undefined, size: number): ByteRange => {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  const [first, last] = [m[1] ?? '', m[2] ?? ''];
  if (first === '') {
    const suffix = Number(last);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return start < size && start <= end ? { start, end } : 'unsatisfiable';
};

const NO_STORE = { 'cache-control': 'no-store' };

/** Sends a file (GET or HEAD), honouring a single byte range. Answers 404 when it is not a readable file. */
export const sendFile = async (rt: Runtime, req: IncomingMessage, res: ServerResponse, file: string): Promise<void> => {
  const info = await rt.fs.stat(file).catch(() => null);
  if (!info?.isFile) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE }).end('Not found: ' + rt.path.basename(file));
    return;
  }
  const size = info.size;
  const range = parseRange(req.headers.range, size);
  const type = contentType(file);
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', ...NO_STORE, ...(type.startsWith('text/html') ? { 'content-security-policy': SCENE_POLICY } : {}) };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': 'bytes */' + size }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const status = range ? 206 : 200;
  res.writeHead(status, { ...headers, 'content-length': String(Math.max(0, end - start + 1)), ...(range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  let data: Uint8Array;
  try {
    data = await rt.fs.readFile(file);
  } catch {
    res.destroy();
    return;
  }
  res.end(data.subarray(start, end + 1));
};
