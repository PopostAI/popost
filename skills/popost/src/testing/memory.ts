/**
 * Test doubles: an in-memory POSIX file system and a runtime over it that records stdout / stderr and routes `fetch` to a
 * handler. Tests run the real command code against these; nothing touches the disk or the network.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import nodePath from 'node:path';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import type { FileSystem, Runtime } from '../runtime';
import { run } from '../main';

const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

export const createMemoryFileSystem = (initial: Record<string, string | Uint8Array> = {}) => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/']);
  const norm = (p: string) => path.resolve('/', p);
  const addParents = (p: string) => {
    for (let d = path.dirname(p); !dirs.has(d); d = path.dirname(d)) dirs.add(d);
  };
  const bytes = (data: Uint8Array | string) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);
  const fs: FileSystem = {
    readFile: async (p) => {
      const data = files.get(norm(p));
      if (!data) throw enoent(p);
      return data;
    },
    readText: async (p) => new TextDecoder().decode(await fs.readFile(p)),
    writeFile: async (p, data) => {
      const key = norm(p);
      if (dirs.has(key)) throw Object.assign(new Error(`EISDIR: '${p}'`), { code: 'EISDIR' });
      addParents(key);
      files.set(key, bytes(data).slice());
    },
    mkdir: async (p) => {
      const key = norm(p);
      if (files.has(key)) throw Object.assign(new Error(`EEXIST: '${p}'`), { code: 'EEXIST' });
      addParents(key);
      dirs.add(key);
    },
    readdir: async (p) => {
      const key = norm(p);
      if (!dirs.has(key)) throw enoent(p);
      const prefix = key === '/' ? '/' : `${key}/`;
      const names = new Set<string>();
      for (const entry of [...files.keys(), ...dirs])
        if (entry !== key && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0]!);
      return [...names].sort();
    },
    stat: async (p) => {
      const key = norm(p);
      if (dirs.has(key)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
      const data = files.get(key);
      return data ? { isFile: true, isDirectory: false, size: data.byteLength, mtimeMs: 0 } : null;
    },
    rm: async (p) => {
      const key = norm(p);
      for (const entry of [...files.keys()]) if (entry === key || entry.startsWith(`${key}/`)) files.delete(entry);
      for (const entry of [...dirs]) if (entry !== '/' && (entry === key || entry.startsWith(`${key}/`))) dirs.delete(entry);
    },
    rename: async (from, to) => {
      const src = norm(from);
      const dst = norm(to);
      if (dirs.has(src)) {
        if (dirs.has(dst) && [...files.keys(), ...dirs].some((e) => e.startsWith(`${dst}/`))) throw Object.assign(new Error(`ENOTEMPTY: '${to}'`), { code: 'ENOTEMPTY' });
        addParents(dst);
        for (const entry of [...files.keys()]) {
          if (!entry.startsWith(`${src}/`)) continue;
          files.set(dst + entry.slice(src.length), files.get(entry)!);
          files.delete(entry);
        }
        for (const entry of [...dirs]) {
          if (entry !== src && !entry.startsWith(`${src}/`)) continue;
          dirs.delete(entry);
          dirs.add(dst + entry.slice(src.length));
        }
        return;
      }
      const data = files.get(src);
      if (!data) throw enoent(from);
      addParents(dst);
      files.set(dst, data);
      files.delete(src);
    },
  };
  for (const [p, data] of Object.entries(initial)) void fs.writeFile(p, data);
  return { fs, files, dirs };
};

/** The package directory on the real disk (SKILL.md, assets/, templates/, references/). */
export const PACKAGE_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the package is mounted inside test file systems. */
export const SKILL_ROOT = '/skill';

/**
 * Copy package files (paths relative to the package root, files or directories) into a memory file system at
 * `SKILL_ROOT`, so commands can read SKILL.md, templates or assets the way they do from an installed package.
 */
export const mountPackageFiles = async (fs: FileSystem, relPaths: readonly string[]): Promise<void> => {
  const copy = async (rel: string): Promise<void> => {
    const real = nodePath.join(PACKAGE_ROOT, rel);
    if (!existsSync(real)) return;
    const stat = await fsp.stat(real);
    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(real)) await copy(`${rel}/${name}`);
      return;
    }
    await fs.writeFile(path.join(SKILL_ROOT, rel), new Uint8Array(await fsp.readFile(real)));
  };
  for (const rel of relPaths) await copy(rel);
};

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface TestRuntime extends Runtime {
  readonly out: string[];
  readonly err: string[];
  /** stdout joined. */
  readonly stdoutText: () => string;
  /** The last JSON document printed on stdout. */
  readonly json: () => Record<string, unknown>;
}

const parseLastJson = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.startsWith('{')) continue;
      try {
        return JSON.parse(lines.slice(i).join('\n')) as Record<string, unknown>;
      } catch {
        // keep looking further up
      }
    }
    throw new Error(`no JSON on stdout: ${trimmed.slice(0, 500)}`);
  }
};

export const createTestRuntime = (
  overrides: Partial<Runtime> & { fetchHandler?: FetchHandler; files?: Record<string, string | Uint8Array> } = {},
): TestRuntime => {
  const { fetchHandler, files, ...rest } = overrides;
  const out: string[] = [];
  const err: string[] = [];
  let tick = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    if (!fetchHandler) throw new Error('network is disabled in this test');
    return fetchHandler(new Request(input, init));
  };
  const rt: TestRuntime = {
    fs: createMemoryFileSystem(files).fs,
    path,
    cwd: '/work',
    env: {},
    skillRoot: SKILL_ROOT,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    fetch: fetchImpl,
    launchBrowser: async () => {
      throw new Error('no browser in this test');
    },
    now: () => new Date(Date.UTC(2026, 10, 5, 0, 0, tick++)),
    randomUUID,
    ...rest,
    out,
    err,
    stdoutText: () => out.join(''),
    json: () => parseLastJson(out.join('')),
  };
  return rt;
};

/** Run one CLI invocation against a test runtime, clearing its captured output first. */
export const runCli = async (rt: TestRuntime, argv: readonly string[]) => {
  rt.out.length = 0;
  rt.err.length = 0;
  const code = await run(argv, rt);
  return { code, stdout: rt.stdoutText(), stderr: rt.err.join('') };
};
