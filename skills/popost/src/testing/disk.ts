/**
 * A test runtime over the real disk: a scratch directory as the working directory, real local programs (ffmpeg) and the
 * installed Chrome. `popost video` works on files ffmpeg reads, so its tests cannot run on the in-memory file system.
 * Output is captured like `createTestRuntime`; the network stays off unless a test passes a fetch handler.
 */
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { nodeFileSystem, nodePrograms } from '../node-runtime';
import { findChromium, launchChromium } from '../render/browser';
import type { Runtime } from '../runtime';
import { createTestRuntime, PACKAGE_ROOT, type FetchHandler, type TestRuntime } from './memory';

export interface DiskRuntime extends TestRuntime {
  /** The scratch directory, also `cwd`. */
  readonly dir: string;
  /** Removes the scratch directory. */
  readonly cleanup: () => Promise<void>;
}

/** Environment variables a test passes on to the programs it finds: where ffmpeg and Chrome are, nothing else. */
const PASSED = ['POPOST_FFMPEG', 'POPOST_CHROME', 'PLAYWRIGHT_CHROMIUM'] as const;

export const createDiskRuntime = async (
  overrides: Partial<Runtime> & { fetchHandler?: FetchHandler } = {},
): Promise<DiskRuntime> => {
  const dir = await fsp.realpath(await fsp.mkdtemp(nodePath.join(tmpdir(), 'popost-test-')));
  const env = Object.fromEntries(PASSED.map((name) => [name, process.env[name]]));
  const { env: extraEnv, ...rest } = overrides;
  const rt = createTestRuntime({
    fs: nodeFileSystem,
    path: nodePath,
    cwd: dir,
    skillRoot: PACKAGE_ROOT,
    programs: nodePrograms,
    launchBrowser: (profile) => launchChromium(process.env, profile, { rasterThreads: nodePrograms.parallelism }),
    ...rest,
    env: { ...env, ...extraEnv },
  });
  return Object.assign(rt, { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) });
};

/** True when a Chrome or Chromium is installed; tests that draw frames skip without one. */
export const hasChrome = (): boolean => findChromium(process.env) !== null;
