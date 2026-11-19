/** File reads for paths the user typed: relative to the working directory; a missing file is an `OsError` naming the path. */
import { msg } from '../i18n';
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

/** A `SyntaxError` naming the file when it is not JSON. */
export const readUserJson = async (rt: Runtime, userPath: string): Promise<unknown> => {
  const text = await readUserText(rt, userPath);
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(msg(`${userPath} is not valid JSON (${detail})`, `${userPath} 不是合法的 JSON（${detail}）`));
  }
};

/** Python `str.splitlines()`: the same line breaks, and no empty last line. */
export const splitLines = (text: string): string[] => {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
