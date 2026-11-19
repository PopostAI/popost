/**
 * Parse-link tasks of the popost.ai platform (`POST /links/parse`, `GET /links/parse?id=`): reading a task out of an
 * answer defensively, and waiting for it. Nothing here writes files or decides what to print.
 */
import type { Runtime } from '../runtime';
import type { PopostClient } from './api';
import { isInt, isRecord, type JsonRecord } from './base';
import { PopostApiError } from './errors';
import { sleep } from './time';

export const POLL_INTERVAL_MS = 2000;
/** Consecutive failed polls (network, 5xx) after which waiting stops; the task may still finish on the platform. */
export const MAX_POLL_FAILURES = 5;
/** A rate-limited poll waits as long as the platform says (this much when it does not say), at most the maximum. */
export const RATE_LIMIT_WAIT_MS = 10_000;
export const RATE_LIMIT_WAIT_MAX_MS = 60_000;
export const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

const STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type LinkStatus = (typeof STATUSES)[number];

export interface LinkTask {
  readonly id: string;
  readonly status: LinkStatus;
  /** `false`: the link was already in the library and was reused; `null`: the answer did not say. */
  readonly created: boolean | null;
  /** Net credits charged right now (0 after a refund or when reused); `null`: the answer did not say. */
  readonly chargedCredits: number | null;
  readonly post: JsonRecord | null;
  readonly error: { readonly code: string | null; readonly message: string | null } | null;
}

/** The `task` of an answer's `data`, or `null` when it has no usable id or status. Other fields are read only if well-formed. */
export const taskOf = (data: unknown): LinkTask | null => {
  const raw = isRecord(data) ? data.task : null;
  if (!isRecord(raw) || typeof raw.id !== 'string' || !TASK_ID.test(raw.id)) return null;
  const status = (STATUSES as readonly unknown[]).find((s) => s === raw.status) as LinkStatus | undefined;
  if (!status) return null;
  const err = isRecord(raw.error) ? raw.error : null;
  return {
    id: raw.id,
    status,
    created: typeof raw.created === 'boolean' ? raw.created : null,
    chargedCredits: isInt(raw.chargedCredits) && raw.chargedCredits >= 0 ? raw.chargedCredits : null,
    post: isRecord(raw.post) ? raw.post : null,
    error: err ? { code: typeof err.code === 'string' ? err.code.slice(0, 64) : null, message: typeof err.message === 'string' ? err.message : null } : null,
  };
};

const isTerminal = (task: LinkTask): boolean => task.status === 'succeeded' || task.status === 'failed';

const TRANSIENT_CODES = new Set(['NETWORK', 'RATE_LIMITED', 'TIMEOUT', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'UPSTREAM_ERROR']);

/** A poll that failed for a reason that may pass by itself; everything else (auth, not found, old client) is final. */
const isTransient = (error: unknown): error is PopostApiError =>
  error instanceof PopostApiError && ((error.code !== undefined && TRANSIENT_CODES.has(error.code)) || (error.status ?? 0) >= 500);

/**
 * How long a rate-limited poll waits before the next one (`details.retryAfterSeconds`), or `null` for any other failure.
 * The platform is up and has said when to come back, so this is not a failed poll: only `--timeout` ends such a wait.
 */
const rateLimitWaitMs = (error: PopostApiError): number | null => {
  if (error.code !== 'RATE_LIMITED') return null;
  const seconds = Number(error.details.retryAfterSeconds);
  return Math.min(RATE_LIMIT_WAIT_MAX_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_WAIT_MS);
};

/** `GET /links/parse?id=`; the task of the answer must be the one asked for. */
export const fetchTask = async (client: PopostClient, id: string, timeoutSec?: number): Promise<LinkTask> => {
  const task = taskOf(await client.request('GET', '/links/parse', { query: { id }, timeoutSec }));
  if (!task || task.id !== id) throw new PopostApiError('GET /links/parse 响应格式不符（缺少 task 或 id 不一致）', { code: 'BAD_RESPONSE' });
  return task;
};

export type WaitResult =
  | { readonly kind: 'done'; readonly task: LinkTask }
  | { readonly kind: 'timeout'; readonly task: LinkTask | null }
  | { readonly kind: 'gave-up'; readonly task: LinkTask | null; readonly error: PopostApiError };

/**
 * Polls until the task succeeded or failed, `timeoutSec` has passed, or too many polls in a row failed. `first` is the
 * task the POST returned: it is checked before anything is polled and the first poll comes one interval later; without
 * it (`link status`) the first poll is at once. A rate-limited poll backs off for as long as the platform asks and does
 * not count as a failure. The clock and the waiting come from the runtime. A final answer that is not transient (bad
 * key, unknown id, ...) is thrown to the caller.
 */
export const waitForTask = async (rt: Runtime, client: PopostClient, id: string, first: LinkTask | null, timeoutSec: number): Promise<WaitResult> => {
  const timeoutMs = timeoutSec * 1000;
  const started = rt.now().getTime();
  let last = first;
  let failures = 0;
  let pauseMs = first !== null ? POLL_INTERVAL_MS : 0;
  for (;;) {
    if (last && isTerminal(last)) return { kind: 'done', task: last };
    const elapsed = rt.now().getTime() - started;
    if (elapsed >= timeoutMs) return { kind: 'timeout', task: last };
    if (pauseMs) await sleep(rt, Math.min(pauseMs, timeoutMs - elapsed));
    pauseMs = POLL_INTERVAL_MS;
    try {
      last = await fetchTask(client, id, Math.min(client.timeoutSec, Math.max(5, (timeoutMs - (rt.now().getTime() - started)) / 1000)));
      failures = 0;
    } catch (error) {
      if (!isTransient(error)) throw error;
      const wait = rateLimitWaitMs(error);
      if (wait !== null) {
        pauseMs = wait;
        continue;
      }
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) return { kind: 'gave-up', task: last, error };
    }
  }
};
