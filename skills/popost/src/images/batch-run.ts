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
import { msg } from '../i18n';

type Row = { id: string } & Record<string, unknown>;

/** A bound quote id for each job; an id no job holds, or one job named twice, refuses the whole batch before anything is sent. */
const entriesForQuotes = (entries: readonly Entry[], quoteIds: readonly string[]): { entry: Entry; quoteId: string }[] => {
  const picked = quoteIds.map((quoteId) => {
    const holders = entries.filter((entry) => entry.job.quoteId === quoteId);
    if (holders.length !== 1) {
      const what = holders.length
        ? msg(`quote ${quoteId} is bound to several jobs`, `报价 ${quoteId} 绑定了多个任务`)
        : msg(`no job is bound to quote ${quoteId}`, `没有任务绑定报价 ${quoteId}`);
      throw new JobError(
        msg(
          `${what}; quote the job first, and run the quote id it printed (jobs and their quotes: ${boundQuotes(entries)})`,
          `${what}；请先给任务报价，再运行它输出的报价 id（任务及其报价：${boundQuotes(entries)}）`,
        ),
      );
    }
    return { entry: holders[0]!, quoteId };
  });
  const twice = picked.find((p, i) => picked.findIndex((q) => q.entry.id === p.entry.id) !== i);
  if (twice)
    throw new JobError(msg(`two quote ids belong to job '${twice.entry.id}'; run one quote per job`, `任务 '${twice.entry.id}' 对应了两个报价 id；每个任务只运行一个报价`));
  return picked;
};

/** Why `--all-quoted` leaves a job out: what a run of its bound quote would be refused for anyway. */
const notReady = async (project: Project, entry: Entry): Promise<string | null> => {
  const { job } = entry;
  const quoteId = job.quoteId;
  if (job.provider.channel === 'host')
    return msg('host channel: generate it with the host image tool, then image complete', 'host 通道：用宿主的图片工具生成，再运行 image complete');
  if (job.status === 'completed') return msg('complete', '已完成');
  if (job.status === 'generated') return msg('already generated', '已生成');
  if (job.status !== 'quoted' || !quoteId) return msg('not quoted yet', '还没报价');
  if (await ledger.get(project.rt, ledgerPathOf(project), quoteId)) return msg(`quote ${quoteId} was already run`, `报价 ${quoteId} 已经运行过`);
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
  if (!picked.length) {
    const why = skipped.map((s) => `${s.id}: ${s.reason}`).join('; ');
    throw new JobError(
      msg(
        `no quoted job is ready to run${why ? ` (${why})` : ''}; quote first with image quote --all`,
        `没有可以运行的已报价任务${why ? `（${why}）` : ''}；请先运行 image quote --all 报价`,
      ),
    );
  }
  return { picked, skipped };
};

/**
 * A quote that already made its picture is named as such, with where the picture is, instead of the "quote this job
 * first" a generated job would answer. Every other quote that cannot be run is refused by the run itself (run.ts) with
 * the command that fixes it, and the job stays open.
 */
const alreadyRun = async (project: Project, entry: Entry, quoteId: string): Promise<string | null> =>
  (await ledger.get(project.rt, ledgerPathOf(project), quoteId))?.state === 'consumed'
    ? msg(
        `quote ${quoteId} was already run and made its picture (production/results/${entry.id}); register it with image complete, it is not run again`,
        `报价 ${quoteId} 已经运行过并生成了图片（production/results/${entry.id}）；请用 image complete 登记，不会再次运行`,
      )
    : null;

/** What to do about runs whose outcome is unknown: check first, re-quote only if needed; the key is reused. */
const ambiguousNext = (dir: string, ids: readonly string[]): string =>
  msg(
    `outcome unknown for ${ids.join(', ')}: check the account, then only if needed image quote --dir ${dir} --id ${ids.join(',')} and image run --quote-id <the new quotes> --confirm; the original key is reused, the platform charges once`,
    `${ids.join(', ')} 的结果不明：先查看账号，确有需要再运行 image quote --dir ${dir} --id ${ids.join(',')} 和 image run --quote-id <新报价> --confirm；沿用原来的幂等键，平台只扣一次费`,
  );

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
    ({ entry, quoteId }): Row => ({ id: entry.id, quoteId, outcome: 'failed', charged: false, ok: false, code: 1, error: msg('cancelled before this job was submitted; nothing was sent or charged', '这个任务提交前已取消；未发送任何内容，也未扣费') }),
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
    ...(ambiguous.length ? { next: ambiguousNext(dir, ambiguous.map((row) => row.id)) } : {}),
  };
  return { document, code };
};
