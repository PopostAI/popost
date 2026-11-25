/**
 * The cloud-save state of one running editor service. It owns what a request cannot: the login flows that were started
 * and are waiting for their callback, the upload credential a finished login produced (memory only, until it is used up
 * or expires), the phase the editor button shows, and the debounced, serialized pushes after local saves.
 *
 * - keyed (a popost key is configured): saves are synced in the background, 3 s after the last save, and once at start.
 * - anonymous (no key): nothing is sent until the user logs in on popost.ai; the login ends in `/api/cloud/callback`, which
 *   trades the one-time code for an upload credential and pushes this project once. A later local save only marks the
 *   project as having local changes.
 * - off (`--cloud off`): no button, no routes that do anything.
 *
 * Nothing here ever fails or delays a local save.
 */
import { Project } from '../core/project';
import { errorText } from '../core/util';
import type { DeckSession } from '../deck/types';
import { canvasRevision } from '../editor/canvas-state';
import { PopostClient } from '../providers/api';
import { PopostApiError } from '../providers/errors';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import {
  authorizeTitle,
  buildAuthorizeUrl,
  challengeOf,
  newSecret,
  PENDING_TTL_MS,
  safeEqual,
  SECRET_PATTERN,
  TICKET_TTL_MS,
  ticketBearer,
  type RandomBytes,
} from './auth-flow';
import { CloudError } from './errors';
import { pushProject } from './push';
import type { CloudRecord } from './state';
import { isSynced, readCloudRecord } from './state';

export type CloudMode = 'keyed' | 'anonymous' | 'off';
export type CloudPhase = 'idle' | 'waiting' | 'uploading' | 'saved' | 'failed' | 'conflict';
export type CloudLang = 'en' | 'zh';

export interface CloudStatus {
  readonly ok: boolean;
  readonly mode: CloudMode;
  readonly state: CloudPhase;
  readonly dirty: boolean;
  readonly deckId?: string;
  readonly webUrl?: string;
  readonly syncedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface CloudProjectAdapter {
  info(): Promise<{ projectId: string; title: string; pages: number }>;
  record(): Promise<CloudRecord | null>;
  revision(): Promise<string>;
  push(client: PopostClient, force: boolean, lang: CloudLang): Promise<void>;
}
export interface CloudOptions {
  readonly project?: CloudProjectAdapter;
  /** `--cloud off` passes false. */
  readonly enabled?: boolean;
  /** Allow browser login only, even when the CLI has a key. */
  readonly loginOnly?: boolean;
  readonly session?: DeckSession;
  readonly randomBytes?: RandomBytes;
  /** Quiet time after the last local save before a keyed push. */
  readonly debounceMs?: number;
}

export const AUTO_PUSH_DELAY_MS = 3000;
const MAX_PENDING = 4;
const LOGIN_REQUIRED = 'LOGIN_REQUIRED';
const loginRequired = () => ({
  code: LOGIN_REQUIRED,
  message: msg('log in on popost.ai to save this project to the cloud', '请先在 popost.ai 登录，才能把这个工程保存到云端'),
});

interface Pending {
  readonly verifier: string;
  readonly expiresAt: number;
  readonly lang: CloudLang;
}

interface Ticket {
  readonly bearer: string;
  readonly expiresAt: number;
  readonly lang: CloudLang;
}

export type CallbackResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The mode a runtime is in: keyed when a popost key is configured, anonymous otherwise, off when disabled or unusable. */
export const resolveCloudMode = (rt: Runtime, enabled = true, loginOnly = false): CloudMode => {
  if (!enabled) return 'off';
  try {
    return new PopostClient(rt).hasKey() && !loginOnly ? 'keyed' : 'anonymous';
  } catch {
    return 'off'; // an unusable POPOST_BASE_URL: nothing could be sent anyway
  }
};

const failureOf = (error: unknown): { code: string; message: string } => {
  if (error instanceof PopostApiError) return { code: error.code ?? 'ERROR', message: error.message };
  if (error instanceof CloudError) return { code: error.code, message: error.message };
  const named = (error as { code?: unknown } | null)?.code;
  return { code: typeof named === 'string' ? named : error instanceof Error ? error.name : 'ERROR', message: errorText(error) };
};

export class CloudService {
  /** The project last served; read lazily, the state that owns `rootOf` is still being built when this is constructed. */
  private known: string | undefined;
  private phase: CloudPhase = 'idle';
  private error: { code: string; message: string } | undefined;
  private readonly pending = new Map<string, Pending>();
  private ticket: Ticket | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lang: CloudLang = 'en';

  constructor(
    private readonly rt: Runtime,
    private readonly rootOf: () => string,
    private readonly options: CloudOptions = {},
  ) {}

  private get root(): string {
    return this.known ?? this.rootOf();
  }

  mode = (): CloudMode => resolveCloudMode(this.rt, this.options.enabled !== false, this.options.loginOnly);

  /** A different project is being served (`import-project`): nothing of the old one carries over. */
  private sync(): void {
    const root = this.rootOf();
    const before = this.known;
    this.known = root;
    if (before === undefined || root === before) return;
    this.phase = 'idle';
    this.error = undefined;
    this.pending.clear();
    this.ticket = undefined;
    clearTimeout(this.timer);
  }

  private now = (): number => this.rt.now().getTime();

  private liveTicket(): Ticket | undefined {
    if (this.ticket && this.ticket.expiresAt <= this.now()) this.ticket = undefined;
    return this.ticket;
  }

  private purgePending(): void {
    for (const [state, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(state);
  }

  // ---------- status ----------
  async status(): Promise<CloudStatus> {
    this.sync();
    this.purgePending();
    const mode = this.mode();
    if (this.phase === 'waiting' && this.pending.size === 0) this.phase = 'idle';
    const project = this.options.project ? undefined : await Project.load(this.rt, this.root);
    const record = this.options.project ? await this.options.project.record() : await readCloudRecord(project!);
    const synced = mode !== 'off' && isSynced(record) && (mode === 'keyed' || !record.accountScope);
    const dirty = !synced || !record.fingerprint || record.fingerprint !== (this.options.project ? await this.options.project.revision() : await canvasRevision(project!));
    let state = this.phase;
    if (state === 'idle' || state === 'saved') state = synced && !dirty ? 'saved' : 'idle';
    return {
      ok: true,
      mode,
      state,
      dirty,
      ...(synced ? { deckId: record.deckId, webUrl: record.webUrl, ...(record.syncedAt ? { syncedAt: record.syncedAt } : {}) } : {}),
      ...(state === 'failed' || state === 'conflict' ? { error: this.error } : {}),
    };
  }

  // ---------- login ----------
  /** Begin the browser login on the service's `port`; returns the URL to open on popost.ai. */
  async start(lang: CloudLang, port: number): Promise<{ authorizeUrl: string; expiresAt: string }> {
    this.sync();
    const client = new PopostClient(this.rt);
    const metadata = this.options.project ? await this.options.project.info() : await Project.load(this.rt, this.root).then(p => ({ projectId: p.manifest.projectId, title: String(p.manifest.brief ?? '') || 'Popost', pages: p.manifest.pages.length }));
    const projectId = metadata.projectId;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(projectId ?? ''))
      throw new CloudError('NO_PROJECT_ID', msg('the project has no stable id, so it cannot be saved to the cloud', '工程没有稳定的 id，无法保存到云端'));
    const state = newSecret(this.options.randomBytes);
    const verifier = newSecret(this.options.randomBytes);
    const authorizeUrl = buildAuthorizeUrl({
      site: new URL(client.baseUrl).origin,
      lang,
      port,
      state,
      challenge: challengeOf(verifier),
      projectId,
      title: authorizeTitle(metadata.title),
      pages: metadata.pages,
    });
    this.purgePending();
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const expiresAt = this.now() + PENDING_TTL_MS;
    this.pending.set(state, { verifier, expiresAt, lang });
    this.phase = 'waiting';
    this.error = undefined;
    return { authorizeUrl, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * The site sends the browser back here with a one-time code. The state must be one this service started, unexpired and
   * unused; the code must have the issued shape. Then the credential is formed and this project is pushed in the background.
   */
  callback(code: string | null, state: string | null): CallbackResult {
    this.sync();
    this.purgePending();
    if (!code || !state || !SECRET_PATTERN.test(code) || !SECRET_PATTERN.test(state)) return { ok: false, error: msg('bad callback', '回调参数无效') };
    const key = [...this.pending.keys()].find((known) => safeEqual(known, state));
    const entry = key === undefined ? undefined : this.pending.get(key);
    if (key === undefined || !entry) return { ok: false, error: msg('unknown or expired login', '登录未知或已过期') };
    this.pending.delete(key);
    this.ticket = { bearer: ticketBearer(code, entry.verifier), expiresAt: this.now() + TICKET_TTL_MS, lang: entry.lang };
    this.lang = entry.lang;
    this.phase = 'uploading';
    this.error = undefined;
    void this.enqueue(() => this.runPush(false));
    return { ok: true };
  }

  // ---------- pushing ----------
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private clientFor(mode: CloudMode): PopostClient | null {
    if (mode === 'keyed') return new PopostClient(this.rt);
    const ticket = this.liveTicket();
    return ticket ? new PopostClient(this.rt, { bearer: ticket.bearer }) : null;
  }

  private async runPush(force: boolean): Promise<void> {
    const mode = this.mode();
    const client = this.clientFor(mode);
    if (!client) {
      this.phase = 'failed';
      this.error = loginRequired();
      return;
    }
    this.phase = 'uploading';
    this.error = undefined;
    try {
      if (this.options.project) await this.options.project.push(client, force, this.lang);
      else await pushProject(this.rt, { dir: this.root, client, force, locale: this.lang, session: this.options.session });
      this.phase = 'saved';
      if (mode === 'anonymous') this.ticket = undefined; // the platform revokes it on success
    } catch (error) {
      const failure = failureOf(error);
      this.phase = failure.code === 'DECK_CONFLICT' ? 'conflict' : 'failed';
      this.error = failure;
      if (failure.code === 'UNAUTHORIZED') this.ticket = undefined;
    }
  }

  /** Push now and wait for the outcome. Anonymous mode needs a live upload credential: without one the login must run first. */
  async push(options: { force?: boolean; lang?: CloudLang }): Promise<CloudStatus> {
    this.sync();
    if (options.lang) this.lang = options.lang;
    if (this.mode() === 'anonymous' && !this.liveTicket()) {
      return { ...(await this.status()), ok: false, error: loginRequired() };
    }
    clearTimeout(this.timer);
    this.phase = 'uploading';
    // The platform refuses `force` under an upload credential: only a key may overwrite edits made on the web.
    await this.enqueue(() => this.runPush(options.force === true && this.mode() === 'keyed'));
    return this.status();
  }

  // ---------- background ----------
  /** After a local save (keyed only): push once the project has been quiet for a moment. Never throws, never waits. */
  scheduleAutoPush(): void {
    this.sync();
    if (this.mode() !== 'keyed' || this.phase === 'conflict') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.enqueue(() => this.autoPush()), this.options.debounceMs ?? AUTO_PUSH_DELAY_MS);
    this.timer.unref?.();
  }

  /** Once at service start (keyed only): bring the web copy up to date when the project changed since the last sync. */
  autoStart(): void {
    if (this.mode() !== 'keyed') return;
    void this.enqueue(() => this.autoPush());
  }

  private async autoPush(): Promise<void> {
    try {
      if (this.mode() !== 'keyed' || this.phase === 'conflict') return;
      const status = await this.status();
      if (!status.dirty) return;
      await this.runPush(false);
    } catch (error) {
      this.phase = 'failed';
      this.error = failureOf(error);
    }
  }

  /** Stops the pending debounce (the service is closing). */
  dispose(): void {
    clearTimeout(this.timer);
  }
}
