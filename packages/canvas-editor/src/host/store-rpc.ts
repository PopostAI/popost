import { hasHostWindow, isFromHost, postToHost } from './messaging';

export const STORE_TIMEOUT_MS = 60_000;

export type StoreOp = 'load' | 'save' | 'initial' | 'assets' | 'upload-asset' | 'references' | 'export-options' | 'export';

/** A host-store request that failed; `code` is the host's error code (`conflict` maps to ConflictError on save). */
export class HostStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface Pending {
  id: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

function settle(requestId: string, outcome: { result: unknown } | { error: Error }): void {
  const request = pending.get(requestId);
  if (!request) return;
  pending.delete(requestId);
  clearTimeout(request.timer);
  if (pending.size === 0) window.removeEventListener('message', onResult);
  if ('error' in outcome) request.reject(outcome.error);
  else request.resolve(outcome.result);
}

function hostError(raw: unknown): HostStoreError {
  const error = (raw ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof error.code === 'string' && error.code ? error.code : 'host';
  const message = typeof error.message === 'string' && error.message ? error.message : 'Request failed';
  return new HostStoreError(code, message);
}

/** M7 `store-result`: accepted only from the embedding window for a pending request of the same project. */
function onResult(event: MessageEvent): void {
  if (!isFromHost(event, 'popost-workspace')) return;
  const data = event.data as { type?: unknown; requestId?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
  if (data.type !== 'store-result' || typeof data.requestId !== 'string') return;
  const request = pending.get(data.requestId);
  if (!request || data.id !== request.id) return;
  settle(data.requestId, data.ok === true ? { result: data.result } : { error: hostError(data.error) });
}

/**
 * M6: ask the embedding page to run a store operation for project `id` and wait for its M7 reply.
 * Requests may overlap (each has its own `requestId`); each gives up after `timeoutMs`.
 */
export function requestFromHost<T>(id: string, op: StoreOp, payload: Record<string, unknown> = {}, timeoutMs = STORE_TIMEOUT_MS): Promise<T> {
  if (!id || !hasHostWindow()) return Promise.reject(new HostStoreError('unavailable', 'Open this canvas from the project.'));
  return new Promise<T>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => settle(requestId, { error: new HostStoreError('timeout', 'The project did not respond. Please retry.') }), timeoutMs);
    if (pending.size === 0) window.addEventListener('message', onResult);
    pending.set(requestId, { id, resolve: resolve as (result: unknown) => void, reject, timer });
    try {
      postToHost({ ...payload, source: 'popost-editor', type: 'store', id, requestId, op });
    } catch (error) {
      settle(requestId, { error: error instanceof Error ? error : new Error(String(error)) });
    }
  });
}
