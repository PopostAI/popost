/** File reads for paths the user typed: relative to the working directory, failing the way Python's `open()` did. */
import type { Runtime } from '../runtime';
import { OsError } from './errors';

export const fromCwd = (rt: Runtime, path: string): string => rt.path.resolve(rt.cwd, path);

const checked = async (rt: Runtime, userPath: string): Promise<string> => {
  const path = fromCwd(rt, userPath);
  const stat = await rt.fs.stat(path);
  if (!stat) throw new OsError('ENOENT', userPath);
  if (stat.isDirectory) throw new OsError('EISDIR', userPath);
  return path;
};

export const readUserBytes = async (rt: Runtime, userPath: string): Promise<Uint8Array> =>
  rt.fs.readFile(await checked(rt, userPath));

export const readUserText = async (rt: Runtime, userPath: string): Promise<string> =>
  rt.fs.readText(await checked(rt, userPath));

export const readUserJson = async (rt: Runtime, userPath: string): Promise<unknown> =>
  JSON.parse(await readUserText(rt, userPath));

/** Python `str.splitlines()`: the same line breaks, and no empty last line. */
export const splitLines = (text: string): string[] => {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
