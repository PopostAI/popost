/**
 * Which image jobs may be run again, and the safe retry of a job whose submission left its outcome unknown (the ledger
 * says `ambiguous`).
 *
 * A job is closed to another run only by an attempt whose outcome is not settled in its favour: one that was charged, or
 * whose outcome is unknown. A run that was refused before anything reached the provider (an expired quote, a price that
 * moved, too few credits) left no record in the ledger, and one the platform refused outright is recorded `charged:
 * false`; neither costs anything, so the job is quoted and run again as if the attempt never happened.
 *
 * The platform charges one idempotency key once: running a job whose attempt is unknown with the key of that attempt
 * either returns the picture that was made, or makes it, but never pays twice. A new key could. So such a job may be run
 * again only with that key, and only on purpose: a fresh quote, an explicit `--confirm`, and nothing here ever submits
 * by itself. Every other attempted job stays refused until its quote and ledger have been read.
 */
import { resolvePath } from '../providers/paths';
import * as ledger from '../providers/ledger';
import type { Project } from '../core/project';
import { JobError, saveJob, type Job } from './jobs';

/** What `image run` was given that decides whether this run may be a retry. */
export interface RetryCall {
  readonly quoteId?: string;
  readonly idempotencyKey?: string;
}

/** The ledger the job's quotes and runs use (`image` passes it to the provider CLI as `--ledger`). */
export const ledgerPathOf = (project: Project): string => resolvePath(project.rt, project.rt.path.join(project.root, 'production', 'ledger.jsonl'));

const REFUSED = 'submission already attempted; query its quote/ledger before any retry';

/** The platform said no and nothing was charged: the ledger records it `ambiguous` all the same, with `charged: false`. */
export const refusedUncharged = (attempt: ledger.Attempt): boolean => attempt.state === 'ambiguous' && attempt.charged === false;

/**
 * The idempotency key a run of `job` must carry, or `undefined` for a run that takes none: a first run, or the run of a
 * job whose last attempt never reached the ledger or was refused without a charge. Throws `JobError` for a run that is
 * not allowed: a job whose attempt was charged or is unknown and has no recorded key, an attempt's own quote id, or a
 * key that is not the attempt's.
 */
export const submissionKey = async (project: Project, job: Job, call: RetryCall): Promise<string | undefined> => {
  const prior = await heldBy(project, job);
  if (!prior) {
    if (call.idempotencyKey) throw new JobError('--idempotency-key only applies to a retry of an ambiguous attempt; this job has none (it was not submitted, or its last attempt was refused without a charge)');
    return undefined;
  }
  if (prior.state !== 'ambiguous' || !prior.idempotencyKey) throw new JobError(REFUSED);
  if (call.quoteId === job.attemptedQuoteId) throw new JobError('this quote was already submitted; quote the job again, then run it with the new quote id');
  if (call.idempotencyKey && call.idempotencyKey !== prior.idempotencyKey)
    throw new JobError(`this job's ambiguous attempt went out with idempotency key ${prior.idempotencyKey}; a retry must use it (or leave --idempotency-key out and it is used)`);
  return prior.idempotencyKey;
};

/**
 * The attempt that keeps `job` closed to a fresh run, or `null` when none does. A job marked attempted whose attempt the
 * job does not name (written before `attemptedQuoteId`, or the run was cut off) is refused until it is quoted again.
 */
const heldBy = async (project: Project, job: Job): Promise<ledger.Attempt | null> => {
  if (!job.runAttempted) return null;
  if (!job.attemptedQuoteId) throw new JobError(REFUSED);
  const prior = await ledger.attempt(project.rt, ledgerPathOf(project), job.attemptedQuoteId);
  return prior && !refusedUncharged(prior) ? prior : null;
};

/** Jobs written before `attemptedQuoteId` existed: when one is quoted again after a run, the quote it was bound to is the attempt's. */
export const adoptLegacyAttempt = (job: Job): void => {
  if (job.runAttempted && !job.attemptedQuoteId && job.quoteId) job.attemptedQuoteId = job.quoteId;
};

/**
 * What the job remembers of a run that did not deliver. `wasAttempted` is the job's mark before this run set it. The run
 * counts only when it left a ledger record that is not an uncharged refusal: that quote becomes the job's attempt. A run
 * refused before anything was sent has no record, and one the platform refused is `charged: false`; both put the job back
 * as it was, so an earlier ambiguous attempt that a retry still needs is neither hidden nor replaced by them.
 */
export const recordRun = async (project: Project, job: Job, path: string, quoteId: string | undefined, wasAttempted: boolean | undefined): Promise<void> => {
  const attempt = quoteId ? await ledger.attempt(project.rt, ledgerPathOf(project), quoteId) : null;
  if (quoteId && attempt && !refusedUncharged(attempt)) job.attemptedQuoteId = quoteId;
  else if (wasAttempted) job.runAttempted = true;
  else delete job.runAttempted;
  await saveJob(project.rt, path, job);
};
