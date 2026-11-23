/** The runtime of the npm CLI: the real disk, the network, a local Chrome, and detached processes for the editor. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism, constants as osConstants, homedir, hostname, platform, setPriority, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countCpuList, cpuBudget, type CpuBudget } from './cpu-budget';
import { applyStoredCredentials, credentialsFile, parseCredentials } from './credentials';
import { deviceLocation, deviceTokenProvider, parseDeviceGrant } from './device-login';
import { launchChromium } from './render/browser';
import { readTerminalSecret } from './node-secret';
import type { FileSystem, LocalPrograms, ProgramOptions, ProgramResult, Runtime } from './runtime';
import { msg } from './i18n';

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

const STDERR_KEPT = 200_000;

/** How much lower than the CLI a heavy child runs: the niceness `nice` adds, BELOW_NORMAL on Windows. */
const LOW_PRIORITY = 10;

const executable = (file: string): boolean => {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `nice` where the platform has one (Linux, macOS); undefined on Windows or where it is missing. */
let niceProgram: string | null | undefined;
const findNice = (): string | undefined => {
  if (niceProgram === undefined) niceProgram = platform() === 'win32' ? null : (['/usr/bin/nice', '/bin/nice'].find(executable) ?? null);
  return niceProgram ?? undefined;
};

/** True when `exe` names a program that can be started (a path, or a name on PATH), as spawn would find it. */
const startable = (exe: string, cwd: string | undefined): boolean =>
  exe.includes('/') ? executable(path.resolve(cwd ?? process.cwd(), exe))
    : (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir !== '' && executable(path.join(dir, exe)));

/**
 * The program and arguments to start. A low-priority child on Linux and macOS is started through `nice`, so that
 * every thread it makes runs lower (lowering a running process afterwards reaches only its first thread on Linux).
 * Only a program that can be found is wrapped: one that cannot fails to start as it would without `nice`.
 */
const commandLine = (exe: string, args: readonly string[], options: ProgramOptions): [string, string[], boolean] => {
  const nice = options.lowPriority ? findNice() : undefined;
  if (nice && startable(exe, options.cwd)) return [nice, ['-n', String(LOW_PRIORITY), exe, ...args], false];
  return [exe, [...args], Boolean(options.lowPriority)];
};

/** Windows, or no `nice`: the started process is lowered (Windows maps 10 to BELOW_NORMAL). Best effort. */
const lower = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    setPriority(pid, platform() === 'win32' ? osConstants.priority.PRIORITY_BELOW_NORMAL : LOW_PRIORITY);
  } catch {
    // a process that ended already, or a platform that refuses: it runs at normal priority
  }
};

const runProgram = (argv: readonly string[], options: ProgramOptions = {}): Promise<ProgramResult> =>
  new Promise((resolve, reject) => {
    const [exe, ...rest] = argv;
    if (!exe) {
      reject(new Error('no program to run'));
      return;
    }
    const [program, args, lowerAfter] = commandLine(exe, rest, options);
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    const child = spawn(program, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    if (lowerAfter) lower(child.pid);
    const out: Buffer[] = [];
    let err = '';
    let inputError: unknown;
    let closed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.onStdout) options.onStdout(chunk);
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
      if (err.length > STDERR_KEPT * 2) err = err.slice(-STDERR_KEPT);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      closed = true;
      if (inputError !== undefined) reject(inputError);
      else resolve({ code: code ?? -1, stdout: new Uint8Array(Buffer.concat(out)), stderr: err.slice(-STDERR_KEPT) });
    });
    child.stdin.on('error', () => undefined); // a program may close its input early; its exit code tells
    const input = options.stdin;
    if (input === undefined) child.stdin.end();
    else if (input instanceof Uint8Array) child.stdin.end(input);
    else
      void (async () => {
        try {
          for await (const chunk of input) {
            if (closed) break;
            // Wait for the program to read, or to end: a program that died never drains. Whichever comes first removes
            // the other listener, or one would be left on the child for every full pipe (a video is hundreds of them).
            if (!child.stdin.write(chunk))
              await new Promise<void>((done) => {
                const go = (): void => {
                  child.stdin.off('drain', go);
                  child.off('close', go);
                  done();
                };
                child.stdin.once('drain', go);
                child.once('close', go);
              });
          }
        } catch (error) {
          inputError = error;
          child.kill();
        } finally {
          child.stdin.end();
        }
      })();
  });

/** A file's text, or undefined when it cannot be read for any reason (the budget's sources are all optional). */
const readQuietly = (file: string): string | undefined => {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The processors in this process's affinity mask. Linux lists them in /proc/self/status. availableParallelism()
 * counts the mask too, but newer releases of libuv also fold in a cgroup v2 quota, rounded down (Node 24 with libuv
 * 1.52 reports 1 under a quota of 1.5), which would hide the quota from cpuBudget's own rounding; elsewhere (macOS,
 * Windows) it is the count the platform reports.
 */
const affinity = (): number => {
  const list = readQuietly('/proc/self/status')?.match(/^Cpus_allowed_list:\s*(\S+)/m)?.[1];
  const n = list ? countCpuList(list) : 0;
  return n > 0 ? n : availableParallelism();
};

let budget: CpuBudget | undefined;
/** This process's CPU budget (cpu-budget.ts), worked out once: its affinity and quota do not change while it runs. */
export const nodeCpuBudget = (): CpuBudget =>
  (budget ??= cpuBudget(process.env.POPOST_CPUS, {
    affinity: affinity(),
    cgroup: readQuietly('/proc/self/cgroup'),
    readCgroupFile: (file) => readQuietly(path.join('/sys/fs/cgroup', file)),
  }));

/** Local programs on the real machine: `popost video` runs ffmpeg and the user's own tools through these. */
export const nodePrograms: LocalPrograms = {
  run: runProgram,
  tempDir: (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix)),
  get parallelism() {
    return nodeCpuBudget().cpus;
  },
  get parallelismSource() {
    return nodeCpuBudget().source;
  },
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
    process.stderr.write(
      msg(
        'Paste the API key, then press Enter and Ctrl-D (Ctrl-Z, Enter on Windows):\n',
        '粘贴 API Key，然后按 Enter 和 Ctrl-D（Windows 上按 Ctrl-Z 再按 Enter）：\n',
      ),
    );
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
    launchBrowser: (browserProfile) => launchChromium(process.env, browserProfile, { rasterThreads: nodeCpuBudget().cpus }),
    programs: nodePrograms,
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
