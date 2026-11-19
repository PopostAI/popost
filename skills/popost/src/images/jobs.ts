/**
 * Image jobs (port of image_jobs.py): one composition job per project, distinct material jobs, real provider delegation.
 * A job is `production/jobs/<id>.json`; its state goes `prepared` -> `quoted` -> `generated`, or `completed` when an image
 * (made by a host tool, or generated and then imported) is registered with the project. `prepare` is in prepare.ts.
 */
import { writeAtomic } from '../core/util';
import type { Project } from '../core/project';
import type { Runtime } from '../runtime';

/** Input the user can fix (Python `ValueError`): printed as `{"ok": false, "error": …}`, exit 2. */
export class JobError extends Error {
  override name = 'ValueError';
}

export const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface JobProvider {
  channel: string;
  model?: string | null;
  [key: string]: unknown;
}

export interface Job {
  id: string;
  purpose: string;
  count: number;
  provider: JobProvider;
  prompt: string;
  refs: string[];
  status: string;
  aspect: string;
  refHashes: Record<string, string>;
  quoteId?: string;
  /** A run went out, or may have, and was charged or left its outcome unknown. A run refused before it reached the provider, or refused by the platform without a charge, does not set it. */
  runAttempted?: boolean;
  /** The quote id of the newest run that was charged or whose outcome is unknown: its ledger record says whether a retry is allowed (see retry.ts). */
  attemptedQuoteId?: string;
  result?: unknown;
  asset?: unknown;
  inspection?: string;
  tool?: string | null;
  [key: string]: unknown;
}

/** An operating-system error (Python `OSError`): a missing or unreadable file. */
export const isOsError = (error: unknown): error is Error & { code: string } => {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
};

export const jobFile = (project: Project, id: string): string => project.rt.path.join(project.root, 'production', 'jobs', `${id}.json`);

export const saveJob = (rt: Runtime, path: string, job: Job): Promise<void> => writeAtomic(rt, path, JSON.stringify(job, null, 2));

export const loadJob = async (rt: Runtime, path: string): Promise<Job> => JSON.parse(await rt.fs.readText(path)) as Job;

/**
 * Where a job stands, for the commands that must not touch a job that already cost something:
 * `prepared` (nothing asked of the platform), `quoted` (priced, never charged: a run refused before it reached the
 * platform, or refused by it without a charge, leaves the job here), `submitted` (a run went out and was charged, or its
 * outcome is unknown), `completed` (its picture is registered with the project).
 */
export type JobState = 'prepared' | 'quoted' | 'submitted' | 'completed';

export const jobState = (job: Job): JobState => {
  if (job.status === 'completed') return 'completed';
  if (job.runAttempted || job.attemptedQuoteId || job.status === 'generated') return 'submitted';
  return job.status === 'quoted' || job.quoteId ? 'quoted' : 'prepared';
};
