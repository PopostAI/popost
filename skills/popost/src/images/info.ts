/**
 * `image info --file a.png b.jpg`: format, pixel size, transparency and byte size of picture files, so that nobody probes
 * for `identify`, `file` or a one-liner to learn them. A file that cannot be read or is not a picture is reported on its
 * own entry and does not stop the others.
 */
import { describePicture, type PictureInfo } from '../core/image-info';
import { isFile } from '../core/util';
import type { Runtime } from '../runtime';
import { failureText, isExpectedFailure } from '../workflow/errors';
import { readUserBytes } from '../workflow/io';

export type PictureEntry = { file: string; bytes: number } & PictureInfo | { file: string; ok: false; error: string };

/**
 * The file as typed, from the working directory; when it is not there and `dir` is given, a relative path is looked up
 * inside that project directory too (the way `image prepare --ref` finds project files).
 */
const locate = async (rt: Runtime, file: string, dir: string | undefined): Promise<string> => {
  if (dir === undefined || rt.path.isAbsolute(file) || (await isFile(rt, rt.path.resolve(rt.cwd, file)))) return file;
  const inProject = rt.path.resolve(rt.cwd, dir, file);
  return (await isFile(rt, inProject)) ? inProject : file;
};

export const describeFile = async (rt: Runtime, file: string, dir?: string): Promise<PictureEntry> => {
  try {
    const bytes = await readUserBytes(rt, await locate(rt, file, dir));
    return { file, ...describePicture(bytes, file), bytes: bytes.byteLength };
  } catch (error) {
    if (!isExpectedFailure(error)) throw error;
    return { file, ok: false, error: failureText(error) };
  }
};
