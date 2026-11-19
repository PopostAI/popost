import { requireSingleProvider } from './batch-jobs';
/**
 * `image run` for several quoted jobs (`--quote-id q1,q2,q3`, or `--all-quoted`), side by side. Each job is exactly the
 * single run it would have been: its own quote, idempotency key, ledger entry and job file, and an unknown outcome is
 * never resubmitted. The pool only starts them together and collects one result per job; a job that fails neither
 * cancels nor retries the others.
 */
import type { Project } from '../core/project';
import * as ledger from '../providers/ledger';
import { boundQuotes, failureOf, readEntries, runPool, worstCode, type BatchCall, type BatchResult, type Entry } from './batch-jobs';
import { JobError } from './jobs';
import { ledgerPathOf, submissionKey } from './retry';
import { quoteOrRun } from './run';

type Row = { id: string } & Record<string, unknown>;

/** A bound quote id for each job; an id no job holds, or one job named twice, refuses the whole batch before anything is sent. */
const entriesForQuotes = (entries: readonly Entry[], quoteIds: readonly string[]): { entry: Entry; quoteId: string }[] => {
  const picked = quoteIds.map((quoteId) => {
    const holders = entries.filter((entry) => entry.job.quoteId === quoteId);
    if (holders.length !== 1) throw new JobError(`${holders.length ? `quote ${quoteId} is bound to several jobs` : `no job is bound to quote ${quoteId}`}; quote the job first, and run the quote id it printed (jobs and their quotes: ${boundQuotes(entries)})`);
    return { entry: holders[0]!, quoteId };
  });
  const twice = picked.find((p, i) => picked.findIndex((q) => q.entry.id === p.entry.id) !== i);
  if (twice) throw new JobError(`two quote ids belong to job '${twice.entry.id}'; run one quote per job`);
  return picked;
};

/** Why `--all-quoted` leaves a job out: what a run of its bound quote would be refused for anyway. */
const notReady = async (project: Project, entry: Entry): Promise<string | null> => {
  const { job } = entry;
  const quoteId = job.quoteId;
  if (job.provider.channel === 'host') return 'host channel: generate it with the host image tool, then image complete';
  if (job.status === 'completed') return 'complete';
  if (job.status === 'generated') return 'already generated';
  if (job.status !== 'quoted' || !quoteId) return 'not quoted yet';
  if (await ledger.get(project.rt, ledgerPathOf(project), quoteId)) return `quote ${quoteId} was already run`;
  try {
    await submissionKey(project, job, { quoteId });
  } catch (error) {
    if (error instanceof JobError) return error.message;
    throw error;
  }
  return null;
};

const quotedJobs = async (project: Project): Promise<{ picked: { entry: Entry; quoteId: string }[]; skipped: { id: string; reason: string }[] }> => {
  const picked: { entry: Entry; quoteId: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of await readEntries(project)) {
    const reason = await notReady(project, entry);
    if (reason) skipped.push({ id: entry.id, reason });
    else picked.push({ entry, quoteId: String(entry.job.quoteId) });
  }
  if (!picked.length) throw new JobError(`no quoted job is ready to run${skipped.length ? ` (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')})` : ''}; quote first with image quote --all`);
  return { picked, skipped };
};

/**
 * A quote that already made its picture is named as such, with where the picture is, instead of the "quote this job
 * first" a generated job would answer. Every other quote that cannot be run is refused by the run itself (run.ts) with
 * the command that fixes it, and the job stays open.
 */
const alreadyRun = async (project: Project, entry: Entry, quoteId: string): Promise<string | null> =>
  (await ledger.get(project.rt, ledgerPathOf(project), quoteId))?.state === 'consumed'
    ? `quote ${quoteId} was already run and made its picture (production/results/${entry.id}); register it with image complete, it is not run again`
    : null;

/** What this run left behind in the ledger, which is what tells a refusal from an unknown outcome. */
const standing = async (project: Project, quoteId: string): Promise<Pick<Row, 'outcome' | 'charged'>> => {
  const attempt = await ledger.attempt(project.rt, ledgerPathOf(project), quoteId).catch(() => null);
  if (attempt?.state === 'consumed') return { outcome: 'failed', charged: true }; // made and paid for, but not saved: download it again
  if (attempt && attempt.charged !== false) return { outcome: 'ambiguous', charged: 'unknown' };
  return { outcome: 'failed', charged: false };
};

const failedRow = async (project: Project, entry: Entry, quoteId: string, code: number, error: unknown): Promise<Row> => ({
  id: entry.id,
  quoteId,
  ...(await standing(project, quoteId)),
  ok: false,
  code,
  error,
});

const runOne = async (project: Project, entry: Entry, quoteId: string, call: BatchCall): Promise<Row> => {
  const done = await alreadyRun(project, entry, quoteId);
  if (done) return failedRow(project, entry, quoteId, 1, done);
  try {
    const outcome = await quoteOrRun(project, entry.job, entry.path, 'run', { config: call.config, quoteId, confirm: true, acceptUnknownCost: call.acceptUnknownCost });
    if (outcome.code === 0) return { id: entry.id, outcome: 'ok', ...outcome.result };
    return await failedRow(project, entry, quoteId, outcome.code, outcome.result.error);
  } catch (error) {
    const { code, message } = failureOf(error);
    return failedRow(project, entry, quoteId, code, message);
  }
};

const count = (rows: readonly Row[], outcome: string): number => rows.filter((row) => row.outcome === outcome).length;

export const runBatch = async (project: Project, dir: string, target: readonly string[] | 'all-quoted', call: BatchCall): Promise<BatchResult> => {
  const { picked, skipped } = target === 'all-quoted' ? await quotedJobs(project) : { picked: entriesForQuotes(await readEntries(project), target), skipped: [] };
  requireSingleProvider(picked.map(item => item.entry));
  const rows = await runPool(
    project.rt,
    picked,
    call.concurrency,
    ({ entry, quoteId }) => runOne(project, entry, quoteId, call),
    ({ entry, quoteId }): Row => ({ id: entry.id, quoteId, outcome: 'failed', charged: false, ok: false, code: 1, error: 'cancelled before this job was submitted; nothing was sent or charged' }),
  );
  const code = worstCode(rows.map((row) => (row.ok ? 0 : Math.max(1, Number(row.code)))));
  const ambiguous = rows.filter((row) => row.outcome === 'ambiguous');
  const document: Record<string, unknown> = {
    ok: code === 0,
    action: 'run',
    total: rows.length,
    succeeded: count(rows, 'ok'),
    failed: count(rows, 'failed'),
    ambiguous: ambiguous.length,
    concurrency: call.concurrency,
    jobs: rows,
    ...(skipped.length ? { skipped } : {}),
    ...(ambiguous.length ? { next: `outcome unknown for ${ambiguous.map((row) => row.id).join(', ')}: check the account, then only if needed image quote --dir ${dir} --id ${ambiguous.map((row) => row.id).join(',')} and image run --quote-id <the new quotes> --confirm; the original key is reused, the platform charges once` } : {}),
  };
  return { document, code };
};
