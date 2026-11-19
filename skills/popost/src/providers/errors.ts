/** Error types of the image providers and their CLI (ports of providers/base.py, popost_api.py and provider_cli.py). */

/** A provider's business or local error: bad arguments, a refusal, a missing environment. Never an unknown spend. */
export class ImageProviderError extends Error {
  override name = 'ImageProviderError';
}

/**
 * The POST went out but its outcome is unknown (timeout, no response, an unparsable body, no task id). The caller must
 * write `ledger = ambiguous` and stop: the same POST is never retried automatically.
 */
export class AmbiguousSubmitError extends ImageProviderError {
  override name = 'AmbiguousSubmitError';
}

/** The request exceeds what the chosen model or channel declares (aspect, count, reference images); nothing was sent. */
export class CapabilityError extends ImageProviderError {
  override name = 'CapabilityError';
}

/** The platform refused explicitly, or the local configuration or environment is wrong. Nothing was charged. */
export class PopostApiError extends ImageProviderError {
  override name = 'PopostApiError';
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly details: Record<string, unknown>;
  constructor(message: string, options: { code?: string; status?: number; details?: unknown } = {}) {
    super(message);
    this.code = options.code;
    this.status = options.status;
    const details = options.details;
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
  }
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

/** A refusal of the `provider cli` commands: `code` is the process exit code (1 refused, 2 usage/environment, 3 unconfirmed). */
export class CliReject extends Error {
  override name = 'CliReject';
  constructor(
    readonly code: number,
    message: string,
    /** Fields the refusal carries next to `error`, e.g. the price and balance of a quote the balance does not cover. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Local environment or configuration problems (no request was made): exit 2 instead of 1. */
export const LOCAL_ERROR_CODES: readonly string[] = ['NO_API_KEY', 'BAD_URL', 'BAD_CONFIG'];

export const exitCodeOf = (error: ImageProviderError): number =>
  error instanceof PopostApiError && error.code !== undefined && LOCAL_ERROR_CODES.includes(error.code) ? 2 : 1;
