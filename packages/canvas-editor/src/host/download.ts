import { hasHostWindow, isFromHost, postToHost } from './messaging';

export const DOWNLOAD_TIMEOUT_MS = 120_000;

export type DownloadFailure = 'unavailable' | 'busy' | 'timeout' | 'host';

/** Failure of the M4/M5 relay; `reason` lets the UI pick a localized message. */
export class DownloadError extends Error {
  constructor(readonly reason: DownloadFailure, message: string) {
    super(message);
  }
}

interface PendingRequest {
  requestId: string;
  id: string;
  finish: (error?: Error) => void;
}

let current: PendingRequest | null = null;

function onResult(event: MessageEvent): void {
  const pending = current;
  if (!pending || !isFromHost(event, 'popost-workspace')) return;
  const data = event.data as { type?: unknown; requestId?: unknown; id?: unknown; error?: unknown };
  if (data.type !== 'download-images-result') return;
  if (data.requestId !== pending.requestId || data.id !== pending.id) return;
  const error = typeof data.error === 'string' && data.error ? new DownloadError('host', data.error) : undefined;
  pending.finish(error);
}

/**
 * M4: ask the web app to export `html` as images and wait for M5. One request at a time; gives up after
 * `timeoutMs` (120 s). Rejects with a DownloadError.
 */
export function requestImageDownload(id: string, html: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<void> {
  if (current) return Promise.reject(new DownloadError('busy', 'Download in progress'));
  if (!id || !hasHostWindow()) return Promise.reject(new DownloadError('unavailable', 'Open this canvas from the project.'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => pending.finish(new DownloadError('timeout', 'Download timed out. Please retry.')), timeoutMs);
    const pending: PendingRequest = {
      requestId,
      id,
      finish: (error) => {
        clearTimeout(timer);
        window.removeEventListener('message', onResult);
        current = null;
        if (error) reject(error);
        else resolve();
      },
    };
    current = pending;
    window.addEventListener('message', onResult);
    try {
      postToHost({ source: 'popost-editor', type: 'download-images', id, requestId, html });
    } catch (error) {
      pending.finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
