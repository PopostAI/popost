/**
 * What the video engine needs from the place it runs in, beyond files and a browser: local programs (ffmpeg, and the
 * tools the user names in the environment) and scratch directories on the real disk. A host over a virtual disk has
 * neither, and the video commands say so instead of failing half-way.
 */
import { askedCpus, type CpuBudget } from '../cpu-budget';
import type { LocalPrograms, Runtime } from '../runtime';

/** A video command was run where it cannot work, or a program it needs is missing. The message says what to do. */
export class VideoUnavailableError extends Error {
  override name = 'VideoUnavailableError';
}

export const programsOf = (rt: Runtime): LocalPrograms => {
  if (!rt.programs)
    throw new VideoUnavailableError('Video commands run local programs (ffmpeg) on real files, which this host does not offer. Run popost video on a desktop or in a container.');
  return rt.programs;
};

/**
 * The CPU budget of the video engine: POPOST_CPUS when it is set in the runtime's environment, else what the host
 * reports (the Node runtime: the affinity and the cgroup quota of the process; see cpu-budget.ts). Everything that
 * decides how much runs at once derives from it; nothing in the engine asks the machine for its processor count.
 */
export const cpuBudgetOf = (rt: Runtime): CpuBudget => {
  const asked = askedCpus(rt.env.POPOST_CPUS);
  if (asked !== undefined) return { cpus: asked, source: 'POPOST_CPUS' };
  const p = programsOf(rt);
  return { cpus: Math.max(1, Math.floor(p.parallelism)), source: p.parallelismSource ?? 'the host' };
};

/**
 * Parts that each keep several processors busy (describe's measurement, reader and transcriber) run side by side from
 * this budget up, and one after another below it. Measured on a 30 s clip with both tools: side by side 27 s on four
 * processors; one after another 37 s on two and 53 s on one.
 */
export const SIDE_BY_SIDE_FROM = 4;

export const partsSideBySide = (rt: Runtime): boolean => cpuBudgetOf(rt).cpus >= SIDE_BY_SIDE_FROM;

/**
 * How many heavy jobs of a batch (an ffmpeg each: frames to cut out, pictures to make, files to read) run at once:
 * one per two processors of the budget, at least one. Each job's own threads come from the budget too.
 */
export const heavyJobs = (rt: Runtime): number => Math.max(1, Math.floor(cpuBudgetOf(rt).cpus / 2));

/**
 * `f` over `items` with at most `limit` running at once; the results in the order of the items. After a failure no
 * new item starts, and the first failure is thrown once the running ones have ended.
 */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await f(items[i] as T, i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
};

/** Runs `work` with a new scratch directory and removes the directory afterwards, also when `work` throws. */
export const withTempDir = async <T>(rt: Runtime, prefix: string, work: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await programsOf(rt).tempDir(prefix);
  try {
    return await work(dir);
  } finally {
    await rt.fs.rm(dir).catch(() => undefined);
  }
};

/**
 * A tool the user named in an environment variable (`POPOST_OCR_CMD`, `POPOST_ASR_CMD`, `POPOST_TTS_CMD`,
 * `POPOST_GEN_CMD`): the program and its leading arguments, split on spaces. `undefined` when the variable is unset.
 */
export const toolCommand = (rt: Runtime, variable: string): string[] | undefined => {
  const words = rt.env[variable]?.trim().split(/\s+/).filter(Boolean) ?? [];
  return words.length ? words : undefined;
};
