import { requireSingleProvider } from './batch-jobs';
/**
 * `image quote` for several jobs (`--id a,b,c`, or `--all`): one free quote per job, taken side by side, then one list with
 * every quote id and the total the user is asked to authorize. A failed quote stays that job's own; the others keep theirs.
 */
import type { Project } from '../core/project';
import { normalizePrompt } from '../providers/cli-config';
import { Decimal, decimalOf } from '../providers/decimal';
import { failureOf, readEntries, runPool, worstCode, type BatchCall, type BatchResult, type Entry } from './batch-jobs';
import { JOB_ID, JobError, jobState, type Job } from './jobs';
import { quoteOrRun, type JobCall } from './run';

/** Why `--all` leaves a job out; `null` for a job that is quoted. */
const skipReason = (job: Job): string | null => {
  if (job.provider.channel === 'host') return 'host channel: generate it with the host image tool, then image complete';
  const state = jobState(job);
  if (state === 'completed') return 'complete';
  if (job.status === 'generated') return 'already generated';
  if (state === 'submitted') return 'already submitted (outcome unknown or charged); retry only by naming it with --id';
  return null;
};

const selectAll = (entries: readonly Entry[]): { chosen: Entry[]; skipped: { id: string; reason: string }[] } => {
  const chosen: Entry[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of entries) {
    const reason = skipReason(entry.job);
    if (reason) skipped.push({ id: entry.id, reason });
    else chosen.push(entry);
  }
  return { chosen, skipped };
};

const selectNamed = (entries: readonly Entry[], ids: readonly string[]): Entry[] =>
  ids.map((id) => {
    if (!JOB_ID.test(id)) throw new JobError(`invalid job id: ${id}`);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new JobError(`no job '${id}' to quote (prepared jobs: ${entries.map((e) => e.id).join(', ') || 'none'})`);
    return entry;
  });

/** Two jobs that ask for the same picture would get one quote id between them; one of them is a mistake. */
const refuseTwins = (project: Project, chosen: readonly Entry[]): void => {
  const { rt } = project;
  const seen = new Map<string, string>();
  for (const { id, job } of chosen) {
    const refs = job.refs.map((file) => job.refHashes[rt.path.resolve(rt.cwd, file)] ?? file);
    const key = JSON.stringify([normalizePrompt(job.prompt), job.aspect, job.provider.model ?? null, refs]);
    const twin = seen.get(key);
    if (twin) throw new JobError(`jobs '${twin}' and '${id}' ask for the same picture (same prompt, aspect and references); keep one, or change the prompt of the other`);
    seen.set(key, id);
  }
};

type Row = { id: string } & Record<string, unknown>;

interface Quoted {
  readonly row: Row;
  /** The account balance this quote saw, in credits, when the platform said. */
  readonly balance: number | null;
}

const quotedRow = (id: string, code: number, result: Record<string, unknown>): Quoted => {
  if (code !== 0) return { row: { id, ok: false, code, error: result.error }, balance: null };
  const quote = result.quote as Record<string, unknown>;
  const billing = result.billing as Record<string, unknown>;
  const row = { id, ok: true, quoteId: quote.quoteId, model: quote.model, aspect: quote.aspect, credits: billing.totalCredits ?? null, expiresAt: quote.expiresAt, quoteFile: result.quoteFile, billingUnit: billing.unit ?? null, provider: quote.provider };
  return { row, balance: typeof billing.balance === 'number' ? billing.balance : null };
};

const quoteOne = async (project: Project, entry: Entry, call: JobCall): Promise<Quoted> => {
  try {
    const outcome = await quoteOrRun(project, entry.job, entry.path, 'quote', call);
    return quotedRow(entry.id, outcome.code, outcome.result);
  } catch (error) {
    const { code, message } = failureOf(error);
    return { row: { id: entry.id, ok: false, code, error: message }, balance: null };
  }
};

/** The sum of the quoted credits; `null` when any quote has no known price. */
const sumCredits = (rows: readonly Row[]): Decimal | null => {
  let total = Decimal.parse('0')!;
  for (const row of rows) {
    const credits = decimalOf(row.credits);
    if (!credits) return null;
    total = total.plus(credits);
  }
  return total;
};

const SHORT = 'not enough credits for all of these quotes at once';

/** The batch's answer: every quote, the total to authorize, and whether the balance covers all of them together. */
const summary = (dir: string, quoted: readonly Quoted[], skipped: readonly { id: string; reason: string }[], concurrency: number): BatchResult => {
  const rows = quoted.map((q) => q.row);
  const good = rows.filter((row) => row.ok);
  const total = sumCredits(good);
  const balances = quoted.map((q) => q.balance).filter((balance): balance is number => balance !== null);
  const balance = balances.length ? Math.min(...balances) : null;
  const short = total !== null && balance !== null && total.compare(Decimal.parse(String(balance))!) > 0;
  const code = worstCode([...rows.filter((row) => !row.ok).map((row) => Number(row.code)), ...(short ? [1] : [])]);
  const document: Record<string, unknown> = {
    ok: code === 0,
    action: 'quote',
    quoted: good.length,
    failed: rows.length - good.length,
    totalCredits: good.every(row => row.billingUnit === 'credits') && total !== null ? String(total) : null,
    totalAmount: total === null ? null : String(total),
    billingUnit: good[0]?.billingUnit ?? null,
    balance,
    concurrency,
    quoteIds: good.map((row) => row.quoteId),
    jobs: rows,
    ...(short ? { error: `${SHORT}: they total ${String(total)} credits and the balance is ${String(balance)}; run fewer of them (image run --quote-id with some of quoteIds) or top up first` } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(good.length && !short ? { next: `image run --dir ${dir} --quote-id ${good.map((row) => String(row.quoteId)).join(',')} --confirm` } : {}),
  };
  return { document, code };
};

const select = async (project: Project, target: readonly string[] | 'all'): Promise<{ chosen: Entry[]; skipped: { id: string; reason: string }[] }> => {
  const entries = await readEntries(project);
  const { chosen, skipped } = target === 'all' ? selectAll(entries) : { chosen: selectNamed(entries, target), skipped: [] };
  if (!chosen.length) throw new JobError(`no job to quote${skipped.length ? ` (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ')})` : '; prepare jobs first with image prepare'}`);
  return { chosen, skipped };
};

export const quoteBatch = async (project: Project, dir: string, target: readonly string[] | 'all', call: BatchCall): Promise<BatchResult> => {
  const { chosen, skipped } = await select(project, target);
  requireSingleProvider(chosen);
  refuseTwins(project, chosen);
  const jobCall: JobCall = { config: call.config, confirm: false, acceptUnknownCost: call.acceptUnknownCost };
  const quoted = await runPool(
    project.rt,
    chosen,
    call.concurrency,
    (entry) => quoteOne(project, entry, jobCall),
    (entry): Quoted => ({ row: { id: entry.id, ok: false, code: 1, error: 'cancelled before this job was quoted; nothing was sent' }, balance: null }),
  );
  return summary(dir, quoted, skipped, call.concurrency);
};
