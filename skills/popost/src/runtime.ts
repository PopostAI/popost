/**
 * Everything the popost CLI needs from the place it runs in. The npm CLI (`popost …` in a terminal or a desktop agent)
 * gets a runtime over the real disk, the network and a local Chrome (`node-runtime.ts`); a host that runs the CLI
 * in-process (the popost.ai web agent's sandbox) passes its own, over the sandbox's virtual disk. Command code never
 * imports `node:fs`, `node:child_process`, `node:http` or reads `process.*`: it only uses what is here, so it behaves the
 * same in both places.
 */
import type { PlatformPath } from 'node:path';
import type { Browser } from 'playwright-core';

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Paths are absolute or relative to `Runtime.cwd`, in the style of `Runtime.path`. */
export interface FileSystem {
  /** Required for filesystems with symbolic links; resolves every path component. */
  realpath?(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /**
   * Writes the whole file, creating missing parent directories. `private` asks for owner-only permissions (file 0600,
   * new directories 0700) where the platform has them; hosts without permissions ignore it.
   */
  writeFile(path: string, data: Uint8Array | string, options?: { private?: boolean }): Promise<void>;
  /** Recursive; no error when the directory exists. */
  mkdir(path: string): Promise<void>;
  /** Entry names (not paths), sorted. Throws when the directory does not exist. */
  readdir(path: string): Promise<string[]>;
  /** `null` when nothing exists at the path. */
  stat(path: string): Promise<FileStat | null>;
  /** Recursive; no error when nothing exists. */
  rm(path: string): Promise<void>;
  /** Replaces the target when it exists. */
  rename(from: string, to: string): Promise<void>;
}

/** Desktop-only abilities: start the local editor server and open it. Hosts that run the CLI in-process omit them. */
export interface LocalProcesses {
  /** Start a detached process that outlives the CLI (the editor server of `present`). */
  spawnDetached(argv: readonly string[], options: { cwd: string; logFile: string }): Promise<{ pid: number }>;
  /** `node:http`'s `createServer`, for `serve`. */
  createServer: typeof import('node:http').createServer;
  /** The command that runs this CLI again (`[process.execPath, cli.js]`), for detached `serve`. */
  selfCommand: readonly string[];
}

/** How a local program ended. */
export interface ProgramResult {
  /** The exit code; -1 when a signal ended the program. */
  readonly code: number;
  /** Everything the program wrote to standard output; empty when `onStdout` took it. */
  readonly stdout: Uint8Array;
  /** The end of standard error (at most its last 200 000 characters). */
  readonly stderr: string;
}

export interface ProgramOptions {
  /** Bytes for standard input. An iterable is written piece by piece, as fast as the program reads. */
  readonly stdin?: Uint8Array | AsyncIterable<Uint8Array>;
  /** Called with each piece of standard output as it arrives, instead of collecting it. */
  readonly onStdout?: (chunk: Uint8Array) => void;
  readonly cwd?: string;
  /** Variables set for the program on top of the CLI's own environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Heavy work (ffmpeg, the user's tools): run it at a lower priority than the CLI, so the machine stays usable.
   * The Node runtime starts it through `nice -n 10` on Linux and macOS and lowers it to BELOW_NORMAL on Windows;
   * a host that cannot lower a program runs it as usual.
   */
  readonly lowPriority?: boolean;
}

/**
 * Desktop-only abilities: run a program installed on this machine (ffmpeg, or a tool the user named in the environment)
 * against the real disk. `popost video` needs them; hosts over a virtual disk omit them and the video commands refuse.
 */
export interface LocalPrograms {
  /**
   * Runs `argv` to its end and resolves whatever the exit code. Rejects when the program cannot be started (the error
   * keeps Node's `code`, `ENOENT` for a program that is not installed) or when the `stdin` iterable throws.
   */
  run(argv: readonly string[], options?: ProgramOptions): Promise<ProgramResult>;
  /** A new empty directory for scratch files, outside every project. The caller removes it. */
  tempDir(prefix: string): Promise<string>;
  /**
   * The CPU budget (cpu-budget.ts): how many processors the work may keep busy at once, whole and at least 1. The
   * engine sizes every thread pool and every side-by-side run from it, never from the machine's processor count.
   */
  readonly parallelism: number;
  /** Where parallelism came from (POPOST_CPUS, the affinity, a cgroup quota), for doctor. */
  readonly parallelismSource?: string;
}

/**
 * What a browser is launched for. `pages`: still pages served by interception, no host name resolves (the default).
 * `frames`: the same, drawn the same on every run, for video frames (no placeholder images, no frame-rate limit).
 * `web`: a page of the public web is loaded (`popost video capture`); the only one with network access.
 */
export type BrowserProfile = 'pages' | 'frames' | 'web';

/**
 * A host that shows the project itself (the popost.ai workbench). `present --host web` hands the project to it instead
 * of starting a local editor server.
 */
export interface EditorHost {
  readonly id: string;
  present(projectDir: string): Promise<Record<string, unknown>>;
}

export interface Runtime {
  readonly fs: FileSystem;
  /** `node:path` of the platform for the real disk, `node:path/posix` for a virtual one. */
  readonly path: PlatformPath;
  /** Absolute working directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute directory (on `fs`) of the Skill package: SKILL.md, references/, templates/, assets/. */
  readonly skillRoot: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** All network access. A host may restrict it to its own API. */
  readonly fetch: typeof globalThis.fetch;
  /** A headless Chromium for rendering; the caller closes it. A host may ignore the profile or refuse one. */
  readonly launchBrowser: (profile?: BrowserProfile) => Promise<Browser>;
  readonly now: () => Date;
  /** Waits `ms` milliseconds. Optional: without it timers are real; tests and hosts with a virtual clock supply their own. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomUUID: () => string;
  readonly signal?: AbortSignal;
  readonly processes?: LocalProcesses;
  readonly programs?: LocalPrograms;
  /**
   * Desktop-only: the user's home directory. Where the stored API key (`auth`) and the agents' skill directories
   * (`install`) live. Hosts that run the CLI in-process omit it: `auth set|clear` and `install` then refuse.
   */
  readonly homeDir?: string;
  readonly deviceName?: string;
  readonly explicitApiKey?: boolean;
  readonly deviceAccess?: (baseUrl: string) => Promise<string>;
  readonly openExternal?: (url: string) => Promise<void>;
  /** Desktop-only: reads all of standard input (`auth set --stdin`). Omitted by hosts without a stdin. */
  readonly stdin?: () => Promise<string>;
  /** Desktop-only, interactive terminal input without echo. Never falls back to visible input. */
  readonly readSecret?: () => Promise<string>;
  readonly editorHost?: EditorHost;
}

/** One CLI command group: parses its own argv, prints JSON to stdout, returns the exit code. */
export type CommandMain = (argv: readonly string[], rt: Runtime) => Promise<number>;
