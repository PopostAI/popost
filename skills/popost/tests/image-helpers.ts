/**
 * Test doubles for the image / provider / inspiration tests (not a test file itself): a fake popost.ai OpenAPI behind
 * `rt.fetch` (port of tests/popost_stub.py), a host-style restricted fetch, and a runtime wired to them.
 */
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { walkFiles } from '../src/core/util';
import { createTestRuntime, mountPackageFiles, runCli, type FetchHandler, type TestRuntime } from '../src/testing/memory';

export const KEY = 'sk-test-DO-NOT-LEAK-7f3a9c';
export const ORIGIN = 'https://stub.popost.test';
export const API = '/api/open/v1';
export const BASE_URL = ORIGIN + API;

/** A valid PNG, built from nothing but zlib. */
/** Parsed JSON as the tests poke at it: shapes are asserted, not declared. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const tinyPng = (rgb: readonly [number, number, number] = [200, 80, 40], size = 2): Uint8Array<ArrayBuffer> => {
  const chunk = (kind: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]));
};

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  json: Record<string, Json> | null;
  raw: Uint8Array;
}

type Reply = readonly [status: number, body: unknown, headers?: Record<string, string>];
type Handler = Reply | ((req: Recorded) => Reply);

export const ok = (data: unknown, status = 200): Reply => [status, { success: true, data, error: null }];
export const err = (status: number, code: string, message = 'stub error', details?: unknown): Reply => [
  status,
  { success: false, data: null, error: { code, message, ...(details === undefined ? {} : { details }) } },
];

interface StubModel {
  id: string;
  name: string;
  kind: string;
  vendor?: string;
  creditsPerImage: number;
  aspectRatios?: string[];
  maxReferenceImages?: number;
  maxImagesPerRequest?: number;
  isDefault?: boolean;
}

/** The public contract of the platform's open API, recording every request. Model ids and prices are neutral placeholders. */
export const headersOf = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/** A web deck as the stub's `POST /projects/sync` keeps it. */
export interface StubDeck {
  readonly deckId: string;
  readonly projectId: string;
  version: number;
  lastSynced: number;
  html: string;
}

const b64urlSha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url');

export class PopostStub {
  readonly requests: Recorded[] = [];
  /** Cloud save: decks by project id, the pictures whose bytes arrived, and the upload credentials a login issued. */
  readonly decks = new Map<string, StubDeck>();
  readonly completed = new Set<string>();
  private readonly logins = new Map<string, { challenge: string; projectId: string; used: boolean }>();
  readonly overrides = new Map<string, Handler>();
  readonly delays = new Map<string, number>();
  readonly uploads = new Map<string, Uint8Array>();
  readonly files = new Map<string, Uint8Array>([
    ['gen-1.png', tinyPng([10, 120, 200])],
    ['gen-2.png', tinyPng([90, 30, 30])],
  ]);
  balance = 500;
  models: StubModel[] = [
    { id: 'stub-model-a', name: 'Stub model A', kind: 'image', vendor: 'SomeUpstreamVendor', creditsPerImage: 12, aspectRatios: ['1:1', '3:4', '9:16'], maxReferenceImages: 3, maxImagesPerRequest: 4, isDefault: true },
    { id: 'stub-model-b', name: 'Stub model B', kind: 'image', creditsPerImage: 20, maxReferenceImages: 0 },
  ];
  inlinePng = tinyPng([0, 160, 90]);

  /** `path` is inside the API (`/images/quote`); the override applies to that method + path. */
  set(method: string, path: string, handler: Handler): void {
    this.overrides.set(`${method} ${API}${path}`, handler);
  }
  clear(method: string, path: string): void {
    this.overrides.delete(`${method} ${API}${path}`);
  }
  calls(method: string, path: string): Recorded[] {
    return this.requests.filter((r) => r.method === method && (r.path === API + path || r.path === path));
  }

  /** A login on the site finished with `code`: only the verifier whose hash is `challenge` can use the credential. */
  expectLogin(code: string, challenge: string, projectId: string): void {
    this.logins.set(code, { challenge, projectId, used: false });
  }
  /** Someone edits the deck on the web: its version moves on without a sync. */
  editOnWeb(projectId: string): void {
    this.decks.get(projectId)!.version += 1;
  }
  /** The platform loses track of the uploaded pictures (they expired). */
  forgetUploads(): void {
    this.completed.clear();
  }

  fetch: FetchHandler = async (request) => {
    const url = new URL(request.url);
    const raw = new Uint8Array(await request.arrayBuffer());
    const isJson = (request.headers.get('content-type') ?? '').startsWith('application/json');
    let json: Record<string, Json> | null = null;
    try {
      json = raw.length && isJson ? JSON.parse(text(raw)) : null;
    } catch {
      json = null;
    }
    const req: Recorded = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: headersOf(request.headers), json, raw };
    this.requests.push(req);
    const delay = this.delays.get(`${req.method} ${req.path}`);
    if (delay) await sleepOrAbort(delay, request.signal);
    const [status, payload, headers = {}] = this.dispatch(req);
    const body = payload instanceof Uint8Array ? payload : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const type = payload instanceof Uint8Array ? (headers['content-type'] ?? 'application/octet-stream') : typeof payload === 'string' ? 'text/plain' : 'application/json';
    return new Response(status === 204 || status === 304 ? null : (body as BodyInit), { status, headers: { 'content-type': type, ...headers } });
  };

  private dispatch(req: Recorded): Reply {
    const refused = this.checkTicket(req);
    if (refused) return refused;
    const override = this.overrides.get(`${req.method} ${req.path}`);
    if (override) return typeof override === 'function' ? override(req) : override;
    const { method: m, path: p } = req;
    if (m === 'GET' && p === `${API}/models`) return ok({ models: this.models });
    if (m === 'POST' && p === `${API}/images/quote`) return this.quote(req.json ?? {});
    if (m === 'POST' && p === `${API}/images/generations`) return this.generate(req.json ?? {});
    if (m === 'POST' && p === `${API}/uploads`) return this.uploadTicket(req.json ?? {});
    if (m === 'POST' && p === `${API}/projects/sync`) return this.syncProject(req);
    if (m === 'PUT' && p.startsWith('/storage/')) {
      this.uploads.set(p.split('/').pop()!, req.raw);
      this.completed.add(p.split('/').pop()!);
      return [200, new Uint8Array(), {}];
    }
    if (m === 'GET' && p.startsWith('/files/')) {
      const file = this.files.get(p.split('/').pop()!);
      return file ? [200, file, { 'content-type': 'image/png' }] : [404, new TextEncoder().encode('missing'), {}];
    }
    if (m === 'POST' && p === `${API}/inspirations`) {
      const { clientId: _clientId, ...body } = req.json ?? {};
      return ok({ inspiration: { ...body, id: 'insp_1', createdAt: '2026-11-01T00:00:00Z' } });
    }
    return err(404, 'NOT_FOUND', 'no route');
  }

  /** `Bearer pat_push_<code>.<verifier>`: one project, `POST /uploads` and `POST /projects/sync` only, until a sync succeeds. */
  private ticketOf(req: Recorded): { code: string; verifier: string } | null {
    const match = /^Bearer pat_push_([^.]+)\.(.+)$/.exec(req.headers.authorization ?? '');
    return match ? { code: match[1]!, verifier: match[2]! } : null;
  }

  private checkTicket(req: Recorded): Reply | null {
    if (!req.path.startsWith(API)) return null;
    const ticket = this.ticketOf(req);
    if (!ticket) return null;
    const login = this.logins.get(ticket.code);
    if (!login || login.used || b64urlSha(ticket.verifier) !== login.challenge) return err(401, 'UNAUTHORIZED', 'ticket expired or used');
    const allowed = (req.method === 'POST' && req.path === `${API}/uploads`) || (req.method === 'POST' && req.path === `${API}/projects/sync`);
    if (!allowed) return err(403, 'FORBIDDEN', 'not allowed for an upload ticket');
    if (req.path === `${API}/projects/sync` && req.json?.projectId !== login.projectId) return err(403, 'FORBIDDEN', 'ticket is for another project');
    return null;
  }

  private syncProject(req: Recorded): Reply {
    const body = req.json ?? {};
    if (typeof body.projectId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.projectId) || typeof body.html !== 'string' || !Array.isArray(body.assets))
      return err(400, 'INVALID_REQUEST', 'bad body', { issues: [{ path: ['projectId'], message: 'invalid' }] });
    const listed = new Set<string>(body.assets.map((a: Json) => a.url));
    const used = [...new Set([...body.html.matchAll(/\.\.\/assets\/[A-Za-z0-9._~%@+=/-]+/g)].map((m) => m[0]))];
    if (used.some((url) => !listed.has(url))) return err(400, 'INVALID_REQUEST', 'unlisted asset', { issues: [{ path: ['assets'], message: 'a URL in the HTML is not listed' }] });
    const stale = body.assets.flatMap((a: Json, i: number) => (this.completed.has(a.uploadId) ? [] : [{ path: ['assets', i, 'uploadId'], message: 'upload not found' }]));
    if (stale.length) return err(400, 'INVALID_REQUEST', 'stale upload', { issues: stale });
    const known = this.decks.get(body.projectId);
    if (known && known.version !== known.lastSynced && !body.force) return err(409, 'DECK_CONFLICT', 'edited on the web', { currentVersion: known.version });
    if (body.html.includes('data-stub-invalid')) return err(422, 'DECK_INVALID', 'invalid deck', { issues: [{ code: 'size_mismatch' }] });
    const deck = known ?? { deckId: `deck-${this.decks.size + 1}`, projectId: body.projectId, version: 0, lastSynced: 0, html: '' };
    const changed = !known || deck.html !== body.html || known.version !== known.lastSynced;
    if (changed) deck.version += 1;
    deck.lastSynced = deck.version;
    deck.html = body.html;
    this.decks.set(body.projectId, deck);
    const ticket = this.ticketOf(req);
    if (ticket) this.logins.get(ticket.code)!.used = true;
    const locale = body.locale === 'zh' ? 'zh' : 'en';
    return ok({
      deckId: deck.deckId,
      version: deck.version,
      changed,
      created: !known,
      pages: (body.html.match(/data-popost-page=/g) ?? []).length,
      webUrl: `${ORIGIN}/${locale}/workspace/projects/${deck.deckId}`,
      assetsUrl: `${ORIGIN}/${locale}/workspace/assets`,
    });
  }

  private modelFor(id: string | undefined): StubModel | undefined {
    return id === undefined ? (this.models.find((m) => m.isDefault) ?? this.models[0]) : this.models.find((m) => m.id === id);
  }

  private quote(body: Record<string, Json>): Reply {
    const model = this.modelFor(body.model);
    if (!model) return err(400, 'INVALID_REQUEST', 'unknown model', { issues: [{ path: ['model'], message: 'unknown' }] });
    const n = Number(body.n || 1);
    const total = model.creditsPerImage * n;
    return ok({ model: model.id, n, creditsPerImage: model.creditsPerImage, totalCredits: total, balance: this.balance, sufficient: this.balance >= total });
  }

  private generate(body: Record<string, Json>): Reply {
    const model = this.modelFor(body.model)!;
    const n = Number(body.n || 1);
    const total = model.creditsPerImage * n;
    if (body.maxCredits !== undefined && body.maxCredits !== null && total > body.maxCredits)
      return err(409, 'CREDIT_LIMIT_EXCEEDED', 'over limit', { required: total, balance: this.balance, maxCredits: body.maxCredits });
    const images = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? { mimeType: 'image/png', width: 2, height: 2, data: b64(this.inlinePng) } : { mimeType: 'image/png', url: `${ORIGIN}/files/gen-1.png` },
    );
    this.balance -= total;
    return ok({ provider: 'SomeUpstreamVendor', model: model.id, images, usage: { credits: total }, balance: this.balance });
  }

  private uploadTicket(body: Record<string, Json>): Reply {
    const uid = `up_${this.calls('POST', '/uploads').length}`;
    return ok({
      uploadId: uid,
      uploadUrl: `${ORIGIN}/storage/${uid}`,
      method: 'PUT',
      headers: { 'Content-Type': body.mimeType, 'x-stub-signature': `sig-${uid}` },
      fileUrl: `${ORIGIN}/files/${uid}`,
      expiresAt: '2026-11-01T01:00:00Z',
    });
  }
}

const sleepOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** A host that only lets the app's open API through, like the web agent sandbox's `rt.fetch`. */
export class BlockedFetchError extends Error {
  override name = 'BlockedFetchError';
}

export const restrictTo = (handler: FetchHandler, allowedPrefixes: readonly string[]): FetchHandler => async (request) => {
  const href = new URL(request.url).href;
  if (!allowedPrefixes.some((prefix) => href.startsWith(prefix)))
    throw new BlockedFetchError(`Network access is limited to ${allowedPrefixes.join(' and ')}; blocked ${new URL(request.url).origin}${new URL(request.url).pathname}`);
  return handler(request);
};

/** `fetch failed` as Node reports an unreachable host. */
export const refused = (): never => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
};

export interface Scene {
  readonly rt: TestRuntime;
  readonly stub: PopostStub;
}

export interface SceneOptions {
  readonly env?: Record<string, string | undefined>;
  readonly files?: Record<string, string | Uint8Array>;
  readonly fetchHandler?: (stub: PopostStub) => FetchHandler;
  readonly mock?: boolean;
}

/** A runtime whose network is a fresh `PopostStub`, with `POPOST_API_KEY` and `POPOST_BASE_URL` set. */
export const newScene = async (options: SceneOptions = {}): Promise<Scene> => {
  const stub = new PopostStub();
  const rt = createTestRuntime({
    fetchHandler: options.fetchHandler ? options.fetchHandler(stub) : stub.fetch,
    env: { POPOST_API_KEY: KEY, POPOST_BASE_URL: BASE_URL, HOME: '/home/u', ...options.env },
    files: options.files,
  });
  await mountPackageFiles(rt.fs, ['assets/mock', 'tests/fixtures']);
  return { rt, stub };
};

export const parseOut = (stdout: string): Json => JSON.parse(stdout);

/** `popost <argv…>`; returns the exit code and the one JSON document printed. */
export const cli = async (rt: TestRuntime, ...argv: string[]): Promise<{ code: number; data: Json; stdout: string; stderr: string }> => {
  const { code, stdout, stderr } = await runCli(rt, argv);
  let data: Json = { _raw: stdout, _err: stderr };
  try {
    data = JSON.parse(stdout);
  } catch {
    // not JSON: keep the raw text for the assertion message
  }
  return { code, data, stdout, stderr };
};

/** Everything printed plus the text of every file in the runtime's file system: the key must be in none of it. */
export const everythingWritten = async (rt: TestRuntime): Promise<string[]> => {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const files = await Promise.all((await walkFiles(rt, '/')).map(async (path) => decoder.decode(await rt.fs.readFile(path))));
  return [...rt.out, ...rt.err, ...files];
};
