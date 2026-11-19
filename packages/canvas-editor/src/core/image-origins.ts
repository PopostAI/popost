/**
 * Extra image origins a host may allow in the preview CSP (`imageOrigins` URL parameter, host mode only), for
 * hosts whose picture URLs redirect to object storage. Only a bare `https:` origin is accepted: no wildcard, path,
 * query, credentials or IP literal. The strict host grammar also keeps CSP delimiters (`;`, `'`, `,`) out.
 */
export const MAX_IMAGE_ORIGINS = 4;

const ORIGIN = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

/** The normalized origin (`https://host[:port]`, default port dropped) of a valid entry, else null. */
export function parseImageOrigin(raw: string): string | null {
  const match = ORIGIN.exec(raw.trim());
  if (!match) return null;
  const port = match[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Valid, de-duplicated origins in order, at most `MAX_IMAGE_ORIGINS`; invalid entries are ignored. */
export function sanitizeImageOrigins(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const origin = parseImageOrigin(entry);
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length === MAX_IMAGE_ORIGINS) break;
  }
  return out;
}
