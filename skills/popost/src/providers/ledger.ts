/**
 * The consumption ledger that prevents double charging (port of providers/ledger.py): an append-only JSONL file.
 * States: `reserved` (before the POST) then `consumed` (done) or `ambiguous` (unknown). A quote id that has any record
 * is refused by every later generate; the newest record of a quote id wins.
 *
 * The Python version held a POSIX file lock. The runtime has no file locks, so calls are serialized per file inside
 * this process. Two separate processes racing on the same quote are not excluded here; the official channel is still
 * safe because its idempotency key is derived from the quote, so the platform charges that generation once.
 */
import type { Runtime } from '../runtime';
import { writeAtomic } from '../core/util';
import { stampWithOffset } from './time';
import { LedgerError } from './errors';
import { canonicalJson } from './canonical';
import { isRecord, type JsonRecord } from './base';

export type LedgerRow = JsonRecord & { quoteId?: string; state?: string };

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same ledger file, whether those succeeded or not. */
const exclusive = <T>(path: string, task: () => Promise<T>): Promise<T> => {
  const next = (queues.get(path) ?? Promise.resolve()).then(task, task);
  queues.set(path, next.then(() => undefined, () => undefined));
  return next;
};

const load = async (rt: Runtime, path: string): Promise<{ rows: LedgerRow[]; text: string }> => {
  if (!(await rt.fs.stat(path))?.isFile) return { rows: [], text: '' };
  const text = await rt.fs.readText(path);
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerRow);
  return { rows, text };
};

export const latest = (rows: readonly LedgerRow[], quoteId: string): LedgerRow | null => {
  let hit: LedgerRow | null = null;
  for (const row of rows) if (row.quoteId === quoteId) hit = row;
  return hit;
};

const append = async (rt: Runtime, path: string, text: string, record: LedgerRow): Promise<void> => {
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  await writeAtomic(rt, path, `${text}${lead}${canonicalJson(record, false, false)}\n`);
};

/** Read-only lookup; a missing file yields `null` and is not created. */
export const get = (rt: Runtime, ledgerPath: string, quoteId: string): Promise<LedgerRow | null> =>
  exclusive(ledgerPath, async () => latest((await load(rt, ledgerPath)).rows, quoteId));

/** What the ledger knows about one submission of a quote id. */
export interface Attempt {
  /** The newest state: `reserved`, `consumed` or `ambiguous`. */
  readonly state: string;
  /** `false`: the platform refused it explicitly (recorded `ambiguous` all the same). `undefined`: nobody knows. */
  readonly charged: boolean | undefined;
  /** The idempotency key the request went out with. Only the `reserved` record holds it; a settle record carries its own meta. */
  readonly idempotencyKey: string | null;
}

const metaOf = (row: LedgerRow | undefined): JsonRecord => (row && isRecord(row.meta) ? row.meta : {});

/** Read-only: the newest state of a quote id and the idempotency key it was reserved with; `null` when it has no record. */
export const attempt = (rt: Runtime, ledgerPath: string, quoteId: string): Promise<Attempt | null> =>
  exclusive(ledgerPath, async () => {
    const rows = (await load(rt, ledgerPath)).rows.filter((row) => row.quoteId === quoteId);
    const last = rows.at(-1);
    if (!last) return null;
    const { charged } = metaOf(last);
    const { idempotencyKey } = metaOf(rows.find((row) => row.state === 'reserved'));
    return { state: String(last.state), charged: typeof charged === 'boolean' ? charged : undefined, idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null };
  });

/** Claims the quote before the POST; refuses when the quote already has a record. */
export const reserve = (rt: Runtime, ledgerPath: string, quoteId: string, requestHash: string, provider: string, meta: JsonRecord = {}): Promise<LedgerRow> =>
  exclusive(ledgerPath, async () => {
    const { rows, text } = await load(rt, ledgerPath);
    const existing = latest(rows, quoteId);
    if (existing) throw new LedgerError(`quote ${quoteId} 已处于 ${String(existing.state)}，禁止重复调用`);
    const record: LedgerRow = { quoteId, state: 'reserved', requestHash, provider, reservedAt: stampWithOffset(rt.now()), meta };
    await append(rt, ledgerPath, text, record);
    return record;
  });

/** reserved -> consumed | ambiguous (appends the final record). */
export const settle = (rt: Runtime, ledgerPath: string, quoteId: string, state: 'consumed' | 'ambiguous', extra: JsonRecord = {}): Promise<LedgerRow> =>
  exclusive(ledgerPath, async () => {
    const { rows, text } = await load(rt, ledgerPath);
    const existing = latest(rows, quoteId);
    if (!existing || existing.state !== 'reserved') throw new LedgerError(`quote ${quoteId} 无 reserved 记录，无法 settle`);
    const record: LedgerRow = { quoteId, state, requestHash: existing.requestHash, provider: existing.provider, settledAt: stampWithOffset(rt.now()), meta: extra };
    await append(rt, ledgerPath, text, record);
    return record;
  });
