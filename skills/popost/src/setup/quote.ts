import { requireSingleProvider } from '../images/batch-jobs';
import { endpointBinding, loadConfig, providerConfig } from '../providers/cli-config';
import { providerName } from '../images/run';
/**
 * The quote step of `popost setup`: prices the image jobs of the spec (free) with `image quote`'s own batch. A job that
 * still holds an open quote keeps it, so running the same spec again changes nothing; a job that was already submitted or
 * completed is left alone, and a job on the host channel has nothing to quote.
 */
import type { Project } from '../core/project';
import { readEntries, DEFAULT_CONCURRENCY, type Entry } from '../images/batch-jobs';
import { quoteBatch } from '../images/batch-quote';
import { jobState } from '../images/jobs';
import { quoteProblem } from '../images/run';
import { decimalOf, type Decimal } from '../providers/decimal';
import { jobIdOf, type QuoteRow, type SetupContext } from './context';
import { StepFailure, projectOf, type StepResult } from './steps';

type Row = Record<string, unknown>;

const sameAccount = async (project: Project, entry: Entry, cfg: Row): Promise<boolean> => {
  const file = project.rt.path.join(project.root, 'production', 'quotes', `${String(entry.job.quoteId)}.json`);
  const record = JSON.parse(await project.rt.fs.readText(file)) as Row;
  const name = providerName(entry.job.provider);
  return record.endpointBinding === endpointBinding(project.rt, name, providerConfig(cfg, name));
};

/** The row of a quote that is still open, read from its quote file. */
const keptRow = async (project: Project, entry: Entry): Promise<QuoteRow> => {
  const quoteId = String(entry.job.quoteId);
  const file = project.rt.path.join(project.root, 'production', 'quotes', `${quoteId}.json`);
  const record = JSON.parse(await project.rt.fs.readText(file)) as Row;
  return { id: entry.id, quoteId, credits: record.totalCredits === null || record.totalCredits === undefined ? null : String(record.totalCredits), billingUnit: typeof (record.pricingSnapshot as Row)?.billingUnit === 'string' ? String((record.pricingSnapshot as Row).billingUnit) : null, model: record.model, aspect: record.aspect, expiresAt: record.expiresAt };
};

const freshRow = (row: Row): QuoteRow => ({
  id: String(row.id),
  quoteId: String(row.quoteId),
  credits: row.credits === null || row.credits === undefined ? null : String(row.credits),
  billingUnit: typeof row.billingUnit === 'string' ? row.billingUnit : null,
  model: row.model,
  aspect: row.aspect,
  expiresAt: row.expiresAt,
});

/** The sum of the credits; `null` when any quote has no known price. */
const total = (rows: readonly QuoteRow[]): string | null => {
  let sum: Decimal | null = null;
  for (const row of rows) {
    const credits = decimalOf(row.credits);
    if (!credits) return null;
    sum = sum ? sum.plus(credits) : credits;
  }
  return sum === null ? '0' : String(sum);
};

interface Sorted {
  readonly open: Entry[];
  readonly toQuote: Entry[];
  readonly left: string[];
}

/** Which jobs hold an open quote, which need one, and which are not for this step (with the reason). */
const sortJobs = async (project: Project, ctx: SetupContext): Promise<Sorted> => {
  const ids = new Set(ctx.spec.images.map(jobIdOf));
  const entries = (await readEntries(project)).filter((entry) => ids.has(entry.id));
  const cfg = await loadConfig(project.rt, ctx.config);
  const sorted: { open: Entry[]; toQuote: Entry[]; left: string[] } = { open: [], toQuote: [], left: [] };
  for (const entry of entries) {
    const state = jobState(entry.job);
    if (entry.job.provider.channel === 'host') ctx.outcome.hostJobs.push(entry.id);
    else if (state === 'completed' || state === 'submitted') sorted.left.push(`${entry.id}: ${state}`);
    else if (state === 'quoted' && entry.job.quoteId && (await quoteProblem(project, entry.job, entry.job.quoteId)) === null && await sameAccount(project, entry, cfg)) sorted.open.push(entry);
    else sorted.toQuote.push(entry);
  }
  return sorted;
};

const failureOf = (document: Row): string => {
  const rows = Array.isArray(document.jobs) ? (document.jobs as Row[]) : [];
  const failed = rows.filter((row) => !row.ok).map((row) => `${String(row.id)}: ${String(row.error)}`);
  return [...failed, ...(typeof document.error === 'string' ? [document.error] : [])].join('; ') || 'quoting failed';
};

export const quoteStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const { open, toQuote, left } = await sortJobs(project, ctx);
  requireSingleProvider([...open, ...toQuote]);
  const fresh: QuoteRow[] = [];
  if (toQuote.length) {
    const call = { config: ctx.config, acceptUnknownCost: ctx.acceptUnknownCost, concurrency: DEFAULT_CONCURRENCY };
    const { document, code } = await quoteBatch(project, ctx.dir, toQuote.map((entry) => entry.id), call);
    if (!document.ok) throw new StepFailure(failureOf(document), code);
    fresh.push(...(document.jobs as Row[]).filter((row) => row.ok).map(freshRow));
    ctx.outcome.balance = typeof document.balance === 'number' ? document.balance : null;
  }
  const kept = await Promise.all(open.map((entry) => keptRow(project, entry)));
  const rows = [...fresh, ...kept];
  const order = ctx.spec.images.map(jobIdOf);
  ctx.outcome.quotes = rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  ctx.outcome.totalAmount = rows.length ? total(rows) : null;
  ctx.outcome.billingUnit = rows[0]?.billingUnit ?? null;
  ctx.outcome.totalCredits = ctx.outcome.billingUnit === 'credits' ? ctx.outcome.totalAmount : null;
  return summary(ctx, fresh, kept, left);
};

const summary = (ctx: SetupContext, fresh: readonly QuoteRow[], kept: readonly QuoteRow[], left: readonly string[]): StepResult => {
  const parts = [
    fresh.length ? `quoted ${fresh.map((row) => row.id).join(', ')}` : '',
    kept.length ? `quotes still open: ${kept.map((row) => `${row.id} (${row.quoteId})`).join(', ')}` : '',
    left.length ? `left alone: ${left.join('; ')}` : '',
    ctx.outcome.hostJobs.length ? `host channel, nothing to quote: ${ctx.outcome.hostJobs.join(', ')}` : '',
  ].filter(Boolean);
  const detail = parts.join('; ') || 'no job to quote';
  return fresh.length ? { status: 'done', detail } : { status: 'skipped', detail };
};
