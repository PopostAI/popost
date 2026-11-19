/**
 * `image quote`, `image run` and `image complete` (the delegating half of image_jobs.py). Quote and run call the provider
 * CLI in this process; the job file binds one quote id, one confirmed run and the reference hashes together.
 */
import { sniffImage } from '../core/image';
import type { Project } from '../core/project';
import { sha256File } from '../core/util';
import { executeCli, type CliCommand, type CliInvocation, type CliOutcome } from '../providers/cli';
import { OFFICIAL_PROVIDER } from '../providers';
import * as ledger from '../providers/ledger';
import { JobError, saveJob, type Job, type JobProvider } from './jobs';
import { adoptLegacyAttempt, ledgerPathOf, recordRun, refusedUncharged, submissionKey } from './retry';

type Rt = Project['rt'];

export interface JobCall {
  readonly config?: string;
  readonly quoteId?: string;
  /** Only for the retry of an ambiguous attempt, and then it must be that attempt's key (see retry.ts). */
  readonly idempotencyKey?: string;
  readonly confirm: boolean;
  readonly acceptUnknownCost: boolean;
}

const ASPECT = /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/;

export const providerName = (provider: JobProvider): string => (provider.channel === 'official' ? OFFICIAL_PROVIDER : 'custom');

/** A reference file that changed since `prepare` would make the old quote describe another request. */
const checkRefsUnchanged = async (rt: Rt, job: Job): Promise<void> => {
  for (const [file, digest] of Object.entries(job.refHashes ?? {}))
    if ((await sha256File(rt, file)) !== digest) throw new JobError('reference changed; do not consume the old quote');
};

/** The provider CLI call for a job's channel; the job's own folders hold its quotes and ledger. */
export const invocation = (project: Project, provider: JobProvider, call: Pick<JobCall, 'config' | 'acceptUnknownCost'>, command: CliCommand): CliInvocation => ({
  provider: providerName(provider),
  config: call.config,
  globals: {
    mock: false,
    dryRun: false,
    quoteDir: project.rt.path.join(project.root, 'production', 'quotes'),
    ledger: project.rt.path.join(project.root, 'production', 'ledger.jsonl'),
    acceptUnknownCost: call.acceptUnknownCost,
  },
  command,
});

/** Anything the CLI did not answer with a JSON refusal is an environment failure of the job (the Python subprocess crashed). */
const delegate = async (project: Project, inv: CliInvocation): Promise<CliOutcome> => {
  try {
    return await executeCli(project.rt, inv);
  } catch (error) {
    throw new JobError(error instanceof Error ? error.message : String(error));
  }
};

const quoteCommand = (job: Job): CliCommand => {
  if (!ASPECT.test(job.aspect)) throw new JobError('画幅须为 W:H，例如 1:1、3:4、9:16');
  return { name: 'quote', args: { prompt: job.prompt, aspectRatio: job.aspect, model: job.provider.model || undefined, ref: job.refs, refUrl: [], count: 1, validSec: 600 } };
};

const generateCommand = (project: Project, job: Job, call: JobCall, idempotencyKey: string | undefined): CliCommand => {
  if (job.status !== 'quoted' || !call.quoteId || call.quoteId !== job.quoteId) throw new JobError('quote this job first; run must use its bound quote id');
  if (!call.confirm) throw new JobError('explicit fee authorization required');
  const outDir = project.rt.path.join(project.root, 'production', 'results', job.id);
  return { name: 'generate', args: { quoteId: call.quoteId, confirm: true, ref: [], refUrl: [], outDir, ...(idempotencyKey ? { idempotencyKey } : {}) } };
};

/** Marks that a submission is about to go out, before it does, so that a crash in between still counts as attempted. */
const markAttempted = async (project: Project, job: Job, path: string): Promise<void> => {
  job.runAttempted = true;
  await saveJob(project.rt, path, job);
};

/** A refusal in the CLI's own shape, for a run stopped before the CLI was called. */
const refusal = (error: string): CliOutcome => ({ code: 1, result: { ok: false, code: 1, error } });

/**
 * Why the quote a run names cannot be submitted (already submitted, gone, unreadable, not open, expired), or `null` when it can.
 * The CLI refuses all of these too, in its own words; saying it here names the job and the command that fixes it.
 */
export const quoteProblem = async (project: Project, job: Job, quoteId: string): Promise<string | null> => {
  const { rt } = project;
  const again = `quote the job again (image quote --dir ${project.root} --id ${job.id}), then run the new quote id`;
  const spent = await ledger.attempt(rt, ledgerPathOf(project), quoteId);
  if (spent) return `quote ${quoteId} was already submitted${refusedUncharged(spent) ? ' and refused without a charge' : ''}; ${again}`;
  const file = rt.path.join(project.root, 'production', 'quotes', `${quoteId}.json`);
  if (!(await rt.fs.stat(file))?.isFile) return `quote ${quoteId} has no quote file; ${again}`;
  let record: { status?: unknown; expiresAt?: unknown };
  try {
    record = JSON.parse(await rt.fs.readText(file)) as typeof record;
  } catch {
    return `quote ${quoteId} cannot be read; ${again}`;
  }
  if (record.status !== 'quoted') return `quote ${quoteId} is ${String(record.status)}, not open; ${again}`;
  const expires = Date.parse(String(record.expiresAt));
  if (Number.isNaN(expires) || rt.now().getTime() > expires) return `quote ${quoteId} expired at ${String(record.expiresAt)}; ${again}`;
  return null;
};

const quoteJob = async (project: Project, job: Job, path: string, call: JobCall): Promise<CliOutcome> => {
  const command = quoteCommand(job);
  adoptLegacyAttempt(job);
  const outcome = await delegate(project, invocation(project, job.provider, call, command));
  if (outcome.code === 0) {
    Object.assign(job, { status: 'quoted', quoteId: (outcome.result.quote as { quoteId: string }).quoteId });
    await saveJob(project.rt, path, job);
  }
  return outcome;
};

const runJob = async (project: Project, job: Job, path: string, call: JobCall): Promise<CliOutcome> => {
  const command = generateCommand(project, job, call, await submissionKey(project, job, call));
  const problem = call.quoteId ? await quoteProblem(project, job, call.quoteId) : null;
  if (problem) return refusal(problem); // nothing was sent, and the job is not marked
  const wasAttempted = job.runAttempted;
  await markAttempted(project, job, path);
  const outcome = await delegate(project, invocation(project, job.provider, call, command));
  if (outcome.code === 0) {
    Object.assign(job, { status: 'generated', result: outcome.result.materials });
    await saveJob(project.rt, path, job);
  } else await recordRun(project, job, path, call.quoteId, wasAttempted);
  return outcome;
};

/**
 * `quote` or `run` of a job. Returns the CLI's own JSON answer and exit code; the job file records the quote id after a
 * quote and, before a run goes out, that a submission was attempted. A run that then did not deliver keeps that mark only
 * if it was charged or its outcome is unknown (retry.ts): one refused before it reached the provider, or refused by the
 * platform without a charge, leaves the job as it was, to be quoted and run again. A second run after a charge or an
 * unknown outcome is refused until the ledger has been read; the one exception is the retry of an ambiguous attempt, which
 * takes that attempt's idempotency key.
 */
export const quoteOrRun = async (project: Project, job: Job, path: string, action: 'quote' | 'run', call: JobCall): Promise<CliOutcome> => {
  await checkRefsUnchanged(project.rt, job);
  if (job.status === 'completed') throw new JobError('job is complete; reuse its asset');
  if (job.provider.channel === 'host') throw new JobError('host: call the actual available image tool with this job prompt, count=1, then complete with its real file');
  return action === 'quote' ? quoteJob(project, job, path, call) : runJob(project, job, path, call);
};

export interface CompleteCall {
  readonly file?: string;
  readonly tool?: string;
  readonly note?: string;
}

/** Registers a real image with the project: the composition reference, or a named material asset. */
export const completeJob = async (project: Project, job: Job, path: string, call: CompleteCall): Promise<void> => {
  const { rt } = project;
  if (job.status === 'completed') throw new JobError('already complete');
  if (!call.file || !call.note) throw new JobError('real image file and inspection note required');
  if (job.provider.channel === 'host' && !call.tool) throw new JobError('name the host tool actually called');
  const data = await rt.fs.readFile(rt.path.resolve(rt.cwd, call.file));
  try {
    sniffImage(data);
  } catch {
    throw new JobError(`cannot identify image file '${call.file}'`);
  }
  const asset =
    job.purpose === 'composition'
      ? await project.importReference(call.file, 'style', null, true)
      : await project.addAssetBytes(data, job.id + rt.path.extname(call.file).toLowerCase());
  Object.assign(job, { status: 'completed', asset, inspection: call.note, tool: call.tool ?? null });
  await saveJob(rt, path, job);
};

