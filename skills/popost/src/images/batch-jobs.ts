/**
 * What `image quote` and `image run` share when they take several jobs at once: reading the job files, the bounded
 * pool that runs them side by side, and how a failure of one job is reported without touching the others.
 */
import type { Project } from '../core/project';
import { isDir } from '../core/util';
import type { Runtime } from '../runtime';
import { isOsError, JobError, loadJob, type Job } from './jobs';

/**
 * How many jobs go out at once unless told otherwise, and the most that may. The platform lets a user have four generations
 * in flight (a fifth is refused outright, or made to wait, depending on the caller), so a larger pool would only turn
 * jobs into refusals.
 */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 4;

/** What a batch command takes besides the jobs themselves. */
export interface BatchCall {
  readonly config?: string;
  readonly acceptUnknownCost: boolean;
  readonly concurrency: number;
}

/** The one JSON document a batch prints, and its exit code. */
export interface BatchResult {
  readonly document: Record<string, unknown>;
  readonly code: number;
}

export interface Entry {
  readonly id: string;
  readonly path: string;
  readonly job: Job;
}

/** Every job file of the project, by id. */
export const readEntries = async (project: Project): Promise<Entry[]> => {
  const { rt } = project;
  const dir = rt.path.join(project.root, 'production', 'jobs');
  if (!(await isDir(rt, dir))) return [];
  const entries: Entry[] = [];
  for (const name of (await rt.fs.readdir(dir)).filter((file) => file.endsWith('.json'))) {
    const path = rt.path.join(dir, name);
    try {
      entries.push({ id: name.slice(0, -'.json'.length), path, job: await loadJob(rt, path) });
    } catch (error) {
      throw new JobError(`job file ${path} cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return entries;
};

/** `a=quote, b=quote` for the jobs that hold a quote, for the messages that tell the caller which quote ids exist. */
export const boundQuotes = (entries: readonly Entry[]): string => entries.filter((entry) => entry.job.quoteId).map((entry) => `${entry.id}=${String(entry.job.quoteId)}`).join(', ') || 'none';

/** `a,b,c` as a list of distinct ids; anything else about them is the caller's to check. */
export const splitList = (value: string, what: string): string[] => {
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => !item)) throw new JobError(`${what} has an empty entry; separate several with single commas`);
  const duplicate = items.find((item, index) => items.indexOf(item) !== index);
  if (duplicate) throw new JobError(`${what} names ${duplicate} twice`);
  return items;
};

/** The exit code and message of a job that failed with `error`: an input the caller can fix is 2, a bug is 1. */
export const failureOf = (error: unknown): { code: number; message: string } => {
  const message = error instanceof Error ? error.message : String(error);
  return { code: error instanceof JobError || isOsError(error) ? 2 : 1, message };
};

/**
 * Runs `work` for every item, at most `limit` at a time, and returns the results in the order of the items. `work` must
 * not throw (it reports a failure as its result), so one job can never cancel another. After the host cancelled, no
 * further item is started and `cancelled` stands in for its result.
 */
export const runPool = async <T, R>(rt: Runtime, items: readonly T[], limit: number, work: (item: T) => Promise<R>, cancelled: (item: T) => R): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index]!;
      results[index] = rt.signal?.aborted ? cancelled(item) : await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** The worst exit code of the failures (1 refused, 2 environment or input), or 0 when there are none. */
export const worstCode = (codes: readonly number[]): number => codes.reduce((worst, code) => Math.max(worst, code), 0);


/** A batch has one billing service. Quote/run other services separately instead of adding their units. */
export const requireSingleProvider = (entries: readonly Entry[]): void => {
  if (new Set(entries.map(entry => entry.job.provider.channel)).size > 1)
    throw new JobError('A batch must use one billing service. Quote and run official, custom and host jobs separately; their costs and accounts cannot be combined.');
};
