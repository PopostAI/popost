/**
 * Which job a single-job `image` action (quote, run, complete, status) means: the one `--id` names; for a run without
 * `--id`, the job that holds the quote (a quote names its job, so the material jobs of a project that has no composition
 * job run by their quote alone); otherwise the composition job, which is only the default for the composition job. A job
 * that is not there is answered with the jobs that are, never with a raw "no such file".
 */
import type { Project } from '../core/project';
import { isDir } from '../core/util';
import { boundQuotes, readEntries } from './batch-jobs';
import { JOB_ID, JobError, jobFile, loadJob, type Job } from './jobs';

export interface JobRef {
  readonly id: string;
  readonly path: string;
  readonly job: Job;
}

export interface JobTarget {
  readonly action: string;
  readonly id?: string;
  readonly quoteId?: string;
}

const COMPOSITION = 'composition';

/** The ids of the job files of the project, read from the file names alone so that an unreadable job cannot hide the others. */
const jobIds = async (project: Project): Promise<string[]> => {
  const { rt } = project;
  const dir = rt.path.join(project.root, 'production', 'jobs');
  if (!(await isDir(rt, dir))) return [];
  return (await rt.fs.readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
};

const missingJob = async (project: Project, id: string, byDefault: boolean): Promise<JobError> => {
  const ids = await jobIds(project);
  const have = ids.length ? `existing jobs: ${ids.join(', ')}; pass --id <job>` : 'this project has no jobs yet; create one with image prepare';
  return new JobError(byDefault ? `no composition job in this project, and no --id was given; ${have}` : `no job '${id}' in this project; ${have}`);
};

/**
 * The one job whose bound quote is `quoteId`, or else the one whose newest submission used it (a quote that was run and
 * then replaced still names its job, and the run says that it was already submitted). No job, or several, is refused
 * with the way to name the right one.
 */
const holderOf = async (project: Project, quoteId: string): Promise<JobRef> => {
  const entries = await readEntries(project);
  const bound = entries.filter((entry) => entry.job.quoteId === quoteId);
  const holders = bound.length ? bound : entries.filter((entry) => entry.job.attemptedQuoteId === quoteId);
  if (holders.length > 1) throw new JobError(`quote ${quoteId} is bound to several jobs (${holders.map((entry) => entry.id).join(', ')}); pass --id <job> to say which one to run`);
  if (!holders.length) throw new JobError(`no job is bound to quote ${quoteId}; quote the job first (image quote --id <job>), and run the quote id it printed (jobs and their quotes: ${boundQuotes(entries)})`);
  return holders[0]!;
};

export const resolveJob = async (project: Project, target: JobTarget): Promise<JobRef> => {
  if (target.action === 'run' && target.id === undefined && target.quoteId !== undefined) return holderOf(project, target.quoteId);
  const id = target.id ?? COMPOSITION;
  if (!JOB_ID.test(id)) throw new JobError('invalid job id');
  const path = jobFile(project, id);
  if (!(await project.rt.fs.stat(path))) throw await missingJob(project, id, target.id === undefined);
  return { id, path, job: await loadJob(project.rt, path) };
};
