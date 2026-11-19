/**
 * The local half of the "Save to Cloud" login: a random `state` the callback must echo, a PKCE-like verifier whose hash
 * (`challenge`) goes to the site and whose plain value never leaves this process except inside the upload credential, and
 * the authorize URL. The redirect target is always `http://127.0.0.1:<port>/api/cloud/callback`, built by the server from
 * an integer port: nothing in a URL or a request chooses the host or path.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { CloudError } from './errors';

export const AUTH_VERSION = 1;
/** How long a started login may wait for the callback. */
export const PENDING_TTL_MS = 10 * 60_000;
/** The upload credential lives 15 minutes on the server; the local copy is dropped at the same time. */
export const TICKET_TTL_MS = 15 * 60_000;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const TITLE_MAX = 80;

export type RandomBytes = (size: number) => Uint8Array;

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** 32 random bytes as 43 base64url characters. */
export const newSecret = (random: RandomBytes = nodeRandomBytes): string => b64url(random(32));

export const challengeOf = (verifier: string): string => b64url(createHash('sha256').update(verifier, 'utf8').digest());

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The bearer the platform accepts for one project's upload: `pat_push_<code>.<verifier>`. */
export const ticketBearer = (code: string, verifier: string): string => `pat_push_${code}.${verifier}`;

export const authorizeTitle = (brief: string): string => Array.from(brief.replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX).join('');

export interface AuthorizeInput {
  /** The site's origin, e.g. `https://popost.ai`. */
  readonly site: string;
  readonly lang: 'en' | 'zh';
  readonly port: number;
  readonly state: string;
  readonly challenge: string;
  readonly projectId: string;
  readonly title: string;
  readonly pages: number;
}

export const buildAuthorizeUrl = (input: AuthorizeInput): string => {
  if (!Number.isInteger(input.port) || input.port < MIN_PORT || input.port > MAX_PORT)
    throw new CloudError('BAD_PORT', `the editor service port ${input.port} cannot be used for the cloud login`);
  const query = new URLSearchParams({
    v: String(AUTH_VERSION),
    port: String(input.port),
    state: input.state,
    challenge: input.challenge,
    project: input.projectId,
    title: authorizeTitle(input.title),
    pages: String(input.pages),
  });
  return `${input.site}/${input.lang}/workspace/cloud-save?${query.toString()}`;
};
