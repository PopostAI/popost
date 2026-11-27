/**
 * The video endpoints of the popost.ai Open API as agreed, in memory, on the image tests' stub: models, uploads, quotes,
 * generations (a task is done at its readyAfter-th poll; a quote binds the body of the generation; one idempotency key
 * is one task, charged once; a failed one is refunded), and the usage of a task (GET /usage/tasks/{id}) from a ledger
 * of what was charged under each x-popost-task. Shared by the tests of the built-in generator and of materials on it.
 */
import { err, headersOf, newScene, ok, ORIGIN, tinyPng, type Json, type PopostStub, type Recorded } from '../image-helpers';
import type { TestRuntime } from '../../src/testing/memory';

export const CLIP = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom'), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
export const MOVE = new Uint8Array([0, 0, 0, 20, ...Buffer.from('ftypqt  '), 9, 9, 9, 9, 9, 9, 9, 9]);
export const PRODUCT = tinyPng([200, 10, 10]);
export const START = Date.parse('2026-11-24T10:00:00Z');
export const MODEL = { id: 'video-a', label: 'Video A', resolutions: ['480p', '720p'], seconds: { min: 4, max: 15 }, aspectRatios: ['16:9', '9:16'], maxReferenceImages: 4, credits: { '480p': 5, '720p': 10 } };

type Reply = ReturnType<typeof ok>;

/** Keys sorted, so two bodies compare by what they say. */
const canonical = (value: Json): string =>
  JSON.stringify(value, (_key, v: Json) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** A charge (or, negative, a refund) under the task a request named. */
export interface Charge { task?: string; kind: 'video' | 'voice' | 'image' | 'transcription' | 'link'; credits: number; seconds?: number; characters?: number }

/** The video endpoints as agreed. A task is done at its readyAfter-th poll; a quote binds the body of the generation. */
export class VideoApi {
  disabled = false;
  balance = 500;
  /** Every charge and refund, with the task it was made under. */
  readonly ledger: Charge[] = [];
  /** False: GET /usage/tasks/{id} is not there (a server from before it: 404). */
  usageOn = true;
  readyAfter = 2;
  failWith: { code: string; message: string } | null = null;
  /** The next answer of POST /videos/generations is lost after the task was made (a gateway error instead). */
  loseAnswer = false;
  readonly quotes = new Map<string, Json>();
  readonly tasks = new Map<string, Json>();
  private readonly byKey = new Map<string, string>();
  private readonly polls = new Map<string, number>();

  constructor(private readonly stub: PopostStub) {
    stub.files.set('clip.mp4', CLIP);
    const route = (method: string, path: string, handle: (req: Recorded) => Reply) =>
      stub.set(method, path, (req) => (this.disabled ? err(403, 'VIDEO_GENERATION_DISABLED', 'Video generation is turned off for this account') : handle(req)));
    route('GET', '/videos/models', () => ok({ models: [MODEL], default: 'video-a' }));
    route('POST', '/videos/uploads', (req) => this.upload(req.json ?? {}));
    route('POST', '/videos/quote', (req) => this.quote(req.json ?? {}));
    route('POST', '/videos/generations', (req) => this.create(req.json ?? {}, req.headers['x-popost-task']));
    route('GET', '/videos/generations', (req) => this.poll(req.query.id ?? ''));
  }

  private upload(body: Json): Reply {
    const id = 'vu_' + this.stub.calls('POST', '/videos/uploads').length;
    return ok({ uploadId: id, uploadUrl: ORIGIN + '/storage/' + id, method: 'PUT', headers: { 'Content-Type': body.mimeType, 'x-stub-signature': 'sig-' + id }, expiresAt: '2026-12-01T10:00:00Z' });
  }

  private price = (body: Json): number => body.seconds * ((body.resolution ?? '480p') === '720p' ? 10 : 5);

  private quote(body: Json): Reply {
    const quoteId = 'q_' + (this.quotes.size + 1);
    this.quotes.set(quoteId, body);
    const { model = 'video-a', resolution = '480p', seconds, aspectRatio = '16:9' } = body;
    return ok({ quoteId, quoteExpiresAt: '2026-11-24T11:00:00Z', model, resolution, seconds, aspectRatio, credits: this.price(body), balance: this.balance });
  }

  /** Charges `credits` of `kind` under `task` (the header of the request), as the platform books it. */
  charge(task: string | undefined, kind: Charge['kind'], credits: number, more: Partial<Charge> = {}): void {
    this.balance -= credits;
    this.ledger.push({ ...(task ? { task } : {}), kind, credits, ...more });
  }

  /** GET /usage/tasks/{id}: the net credits of the task and its items by kind; an unknown task is 0 and no items. */
  usage(id: string): Json {
    const mine = this.ledger.filter((c) => c.task === id);
    const kinds = [...new Set(mine.map((c) => c.kind))];
    const items = kinds.map((kind) => {
      const of = mine.filter((c) => c.kind === kind);
      return { kind, credits: of.reduce((n, c) => n + c.credits, 0), count: of.filter((c) => c.credits > 0).length };
    });
    return { id, title: null, credits: Math.max(0, mine.reduce((n, c) => n + c.credits, 0)), items };
  }

  private create(body: Json, task?: string): Reply {
    const { prompt: _prompt, quoteId, idempotencyKey, ...rest } = body;
    const quoted = this.quotes.get(quoteId);
    if (!quoted) return err(400, 'QUOTE_EXPIRED', 'no such quote');
    if (canonical(quoted) !== canonical(rest)) return err(409, 'QUOTE_MISMATCH', 'the body differs from the quote');
    const known = this.byKey.get(idempotencyKey);
    const made = known ? this.tasks.get(known) : this.make(quoted, idempotencyKey, task);
    if (!made) return err(402, 'INSUFFICIENT_CREDITS', 'not enough credits', { required: this.price(quoted), balance: this.balance });
    if (this.loseAnswer) {
      this.loseAnswer = false;
      return [502, 'bad gateway'];
    }
    return ok({ ...made });
  }

  private make(quoted: Json, key: string, under: string | undefined): Json | undefined {
    const credits = this.price(quoted);
    if (this.balance < credits) return undefined;
    this.charge(under, 'video', credits, { seconds: quoted.seconds });
    const task = { id: 'vt_' + (this.tasks.size + 1), under, status: 'queued', model: quoted.model ?? 'video-a', resolution: quoted.resolution ?? '480p', seconds: quoted.seconds, aspectRatio: quoted.aspectRatio ?? '16:9', credits, createdAt: '2026-11-24T10:00:00Z' };
    this.tasks.set(task.id, task);
    this.byKey.set(key, task.id);
    return task;
  }

  private poll(id: string): Reply {
    const task = this.tasks.get(id);
    if (!task) return err(404, 'NOT_FOUND', 'no such task');
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    if (task.status === 'queued' || task.status === 'running') {
      if (n < this.readyAfter) task.status = 'running';
      else if (this.failWith) {
        // A clip that failed is refunded, under the task it was charged under.
        Object.assign(task, { status: 'failed', error: this.failWith });
        this.charge(task.under, 'video', -task.credits);
      }
      else Object.assign(task, { status: 'succeeded', completedAt: '2026-11-24T10:01:00Z', expiresAt: '2026-12-01T10:01:00Z', video: { url: ORIGIN + '/files/clip.mp4', urlExpiresAt: '2026-11-24T11:01:00Z', bytes: CLIP.length } });
    }
    return ok({ ...task });
  }
}

/** A platform stub with the video endpoints, two reference files, and a clock that moves only when the generator waits. */
export const scene = async (env: Record<string, string | undefined> = {}) => {
  const made: { api?: VideoApi } = {};
  // GET /usage/tasks/{id} for any id, from the ledger; recorded like every other request.
  const fetchHandler = (stub: PopostStub) => async (request: Request): Promise<Response> => {
    const id = /\/usage\/tasks\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
    if (!id || request.method !== 'GET' || !made.api?.usageOn) return stub.fetch(request);
    stub.requests.push({ method: 'GET', path: new URL(request.url).pathname, query: {}, headers: headersOf(request.headers), json: null, raw: new Uint8Array() });
    return Response.json({ success: true, data: made.api.usage(decodeURIComponent(id)), error: null });
  };
  const base = await newScene({ env, files: { '/work/product.png': PRODUCT, '/work/move.mov': MOVE }, fetchHandler });
  const api = new VideoApi(base.stub);
  made.api = api;
  const waited: number[] = [];
  let now = START;
  const rt: TestRuntime = { ...base.rt, now: () => new Date(now), sleep: async (ms: number) => void (waited.push(ms), (now += ms)) };
  return { rt, stub: base.stub, api, waited };
};

