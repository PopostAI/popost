/**
 * The files of the Skill that `install` copies: exactly what `package.json` `files` publishes (one list, kept in
 * package.json), minus what is useless in a skills directory, plus `package.json` itself (the installed version).
 */
import type { Runtime } from '../runtime';

/**
 * Not copied: `dist/` imports the package's npm dependencies (fflate, htmlparser2, playwright-core), which a skills
 * directory has no `node_modules` for, so a copy of it could not run. The command comes from `npm install -g popost`.
 */
const NOT_COPIED = ['dist/'];
const ALWAYS = ['package.json'];
const SKIP_NAMES = new Set(['node_modules', '.git']);

type Pattern = readonly RegExp[];

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

const compile = (pattern: string): Pattern =>
  pattern
    .replace(/\/+$/, '')
    .split('/')
    .map(segmentPattern);

/** `match`: the pattern names this path or one of its parents; `partial`: the path is a parent of what it names. */
const relate = (pattern: Pattern, segments: readonly string[]): 'none' | 'partial' | 'match' => {
  const common = Math.min(pattern.length, segments.length);
  for (let i = 0; i < common; i++) if (!pattern[i]!.test(segments[i]!)) return 'none';
  return segments.length >= pattern.length ? 'match' : 'partial';
};

export interface PackageManifest {
  readonly version: string;
  readonly files: readonly string[];
}

export const readManifest = async (rt: Runtime, root: string): Promise<PackageManifest> => {
  const data = JSON.parse(await rt.fs.readText(rt.path.join(root, 'package.json'))) as { version?: unknown; files?: unknown };
  if (typeof data.version !== 'string' || !Array.isArray(data.files))
    throw new Error(`${rt.path.join(root, 'package.json')} has no version or files list: this is not the popost package`);
  return { version: data.version, files: data.files.filter((f): f is string => typeof f === 'string') };
};

/** Relative paths, with `/` separators, of the files to copy; sorted. */
export const listPayload = async (rt: Runtime, root: string, files: readonly string[]): Promise<string[]> => {
  const include = [...files, ...ALWAYS].map(compile);
  const exclude = NOT_COPIED.map(compile);
  const found: string[] = [];
  const walk = async (segments: readonly string[], inherited: boolean): Promise<void> => {
    const dir = rt.path.join(root, ...segments);
    for (const name of await rt.fs.readdir(dir)) {
      if (SKIP_NAMES.has(name)) continue;
      const child = [...segments, name];
      if (exclude.some((p) => relate(p, child) === 'match')) continue;
      const matched = inherited || include.some((p) => relate(p, child) === 'match');
      if (!matched && !include.some((p) => relate(p, child) === 'partial')) continue;
      const stat = await rt.fs.stat(rt.path.join(root, ...child));
      if (stat?.isDirectory) await walk(child, matched);
      else if (stat?.isFile && matched) found.push(child.join('/'));
    }
  };
  await walk([], false);
  return found.sort();
};
