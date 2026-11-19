/** The runtime of the npm CLI: the real disk, the network, a local Chrome, and detached processes for the editor. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStoredCredentials, credentialsFile, parseCredentials } from './credentials';
import { deviceLocation, deviceTokenProvider, parseDeviceGrant } from './device-login';
import { launchChromium } from './render/browser';
import { readTerminalSecret } from './node-secret';
import type { FileSystem, Runtime } from './runtime';

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export const nodeFileSystem: FileSystem = {
  realpath: (p) => fsp.realpath(p),
  readFile: async (p) => new Uint8Array(await fsp.readFile(p)),
  readText: (p) => fsp.readFile(p, 'utf8'),
  writeFile: async (p, data, options) => {
    if (!options?.private) {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, data);
      return;
    }
    await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fsp.writeFile(p, data, { mode: 0o600 });
    await fsp.chmod(p, 0o600).catch(() => undefined); // an existing file keeps its old mode; Windows has no modes
  },
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
  readdir: async (p) => (await fsp.readdir(p)).sort(),
  stat: async (p) => {
    try {
      const s = await fsp.stat(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
  rename: (from, to) => fsp.rename(from, to),
};

/** The package directory: `dist/cli.js` (built) and `src/*.ts` (tests) both sit one level below it. */
const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The user's home directory; `undefined` when the OS cannot tell (a service account without one). */
const userHome = (): string | undefined => {
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
};

/** `process.stdin` to the end; with a terminal on stdin it says what to type, since nothing else would. */
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY)
    process.stderr.write('Paste the API key, then press Enter and Ctrl-D (Ctrl-Z, Enter on Windows):\n');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * `process.env` plus the key (and base URL) saved by `popost auth set`, for the variables the environment leaves unset.
 * A missing, unreadable or corrupt file is ignored here: commands that need no key must not break; `auth status` reports it.
 */
const readOptional = (file: string | undefined) => {
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

const openExternal = async (url: string) => {
  const os = platform();
  const command = os === 'darwin' ? 'open' : os === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = os === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // The printed verification URL also works on remote hosts.
  child.unref();
};

export const createNodeRuntime = (profile?: string): Runtime => {
  const cliPath = fileURLToPath(import.meta.url);
  const cwd = process.cwd();
  const homeDir = userHome();
  const distribution = readOptional(path.join(packageRoot(), 'dist', 'distribution.json'));
  const site = distribution ? String(JSON.parse(distribution).origin) : undefined;
  const raw: Record<string, string | undefined> = {
    ...process.env,
    ...(profile ? { POPOST_AGENT_PROFILE: profile } : {}),
    POPOST_DISTRIBUTION_SITE: site,
  };
  const location = { cwd, homeDir, path, env: raw };
  let grant = null;
  if (!raw.POPOST_API_KEY?.trim()) {
    try {
      const contents = readOptional(deviceLocation(location));
      if (contents) grant = parseDeviceGrant(contents);
    } catch {
      // A damaged local grant can be replaced by signing in again.
    }
  }
  let manual = null;
  try {
    const contents = readOptional(credentialsFile(location));
    manual = contents ? parseCredentials(contents) : null;
  } catch {
    /* auth status reports unreadable manual files. */
  }
  let manualSite = 'https://popost.ai';
  if (manual?.baseUrl) {
    try {
      manualSite = new URL(manual.baseUrl).origin;
    } catch {
      manualSite = '';
    }
  }
  const matchingManual = !site || site === manualSite;
  const env = { ...applyStoredCredentials(raw, grant || !matchingManual ? null : manual) };
  env.POPOST_BASE_URL ||= grant?.baseUrl || (site && site + '/api/open/v1');
  return {
    fs: nodeFileSystem,
    path,
    cwd,
    env,
    deviceName: hostname()
      .replace(/[^\p{L}\p{N}._-]/gu, '-')
      .slice(0, 38),
    explicitApiKey: Boolean(raw.POPOST_API_KEY?.trim()),
    deviceAccess: grant ? deviceTokenProvider(grant, globalThis.fetch) : undefined,
    openExternal,
    homeDir,
    stdin: readStdin,
    readSecret: () => readTerminalSecret(process.stdin, (text) => void process.stderr.write(text)),
    skillRoot: packageRoot(),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    fetch: globalThis.fetch,
    launchBrowser: () => launchChromium(process.env),
    now: () => new Date(),
    randomUUID,
    processes: {
      spawnDetached: async (argv, options) => {
        await fsp.mkdir(path.dirname(options.logFile), { recursive: true });
        const log = openSync(options.logFile, 'a');
        try {
          const child = spawn(argv[0]!, argv.slice(1), {
            cwd: options.cwd,
            detached: true,
            stdio: ['ignore', log, log],
            env: process.env,
          });
          child.unref();
          return { pid: child.pid ?? 0 };
        } finally {
          closeSync(log); // the child holds its own copy
        }
      },
      createServer,
      selfCommand: [process.execPath, cliPath, ...(profile ? ['--profile', profile] : [])],
    },
  };
};
