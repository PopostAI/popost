/**
 * The built-in generator on popost.ai: `popost video generate video|image <request.json> <out-file>` keeps the
 * POPOST_GEN_CMD contract (index.ts) and makes the clip or picture through the popost.ai Open API, in the user's own
 * account (the key and address every platform command reads: POPOST_API_KEY or the file `popost auth set` wrote,
 * POPOST_BASE_URL), paid in credits. This file makes clips; cloud-image.ts makes pictures.
 *
 * A clip: the reference files are uploaded (POST /videos/uploads, then their bytes to the address it gives; the first
 * and last frame of a request the same way, sent as `frames` instead of `references`), the request is priced (POST
 * /videos/quote) and goes on only when the price is agreed: within --confirm --max-credits N (or POPOST_GEN_MAX_CREDITS,
 * which materials sets to what is left of its own --max-credits), or with --yes once the user has seen it. Otherwise
 * nothing is charged and ConfirmNeeded carries the price. In a project with an agreement (approved.ts) a clip that is
 * not one of the agreed clips is "unplanned": ConfirmNeeded with reason "unplanned", whatever the budget, until the
 * user approved it on its own (--approve-unplanned <key>). Then POST /videos/generations with the quote and an idempotency key
 * derived from the request, GET /videos/generations?id= every 10 s until the task ends, and the clip is downloaded
 * from the signed link of the task. Model and resolution come from the environment (POPOST_VIDEO_MODEL,
 * POPOST_VIDEO_RESOLUTION), never from the request; unset, the platform chooses.
 *
 * A retry never pays twice. What was sent for a request (its uploads, its quote, its task) is kept in a small record in
 * the task directory (`videos/<key>.json`). Run again, the request finds its task and waits for it or downloads it, and
 * an upload or a quote that is still valid is used again, so the same key always goes with the same body. Only a task
 * that failed (its credits were refunded) or whose result expired (the platform keeps it 7 days) is made again, under
 * the next key (`<key>.2`, ...).
 */
import { networkReason } from '../../core/error-text';
import { sha256, writeAtomic } from '../../core/util';
import { checkUrl, downloadResult, sniffImageMime, type PopostClient } from '../../providers/api';
import { describeError } from '../../providers/api-errors';
import { isRecord, type JsonRecord } from '../../providers/base';
import { AmbiguousSubmitError, PopostApiError } from '../../providers/errors';
import { defaultTaskDir } from '../../providers/paths';
import { sleep, timeoutSignal } from '../../providers/time';
import type { Runtime } from '../../runtime';
import { clipStanding, projectOf, recordClip, shortWhat, type ClipGate, type UnplannedClip } from './approved';
import { ConfirmNeeded, type GenerateKind, type GenerateRequest, type PriceToConfirm } from './index';

/** A failure of the generator, with the exit code it ends with (1: refused or failed; 2: the request or the setup needs fixing). */
export class GenerateError extends Error {
  override name = 'GenerateError';
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface CloudSettings {
  readonly videoModel?: string;
  readonly resolution?: string;
  readonly imageModel?: string;
  /** --confirm --max-credits N, else POPOST_GEN_MAX_CREDITS: the most this call may cost without asking. */
  readonly maxCredits?: number;
  /** POPOST_GEN_WAIT_MIN: how long a clip is waited for. */
  readonly waitMinutes: number;
  /** --yes: the user has agreed to the price. */
  readonly yes: boolean;
  /** Where the agreement of the clip is looked for (approved.ts); project undefined: the folders above the output file. */
  readonly gate: Omit<ClipGate, 'project'> & { readonly project?: string };
}

/** What the command line adds to the environment: --confirm --max-credits N, --yes, --approve-unplanned, --project. */
export interface CloudFlags {
  readonly yes: boolean;
  readonly maxCredits?: number;
  readonly approve?: readonly string[];
  readonly project?: string;
}

const MINUTE_MS = 60_000;
const POLL_MS = 10_000;
const DEFAULT_WAIT_MIN = 30;
const DEFAULT_SECONDS = 5;
const CREATE_TRIES = 3;
const CREATE_TIMEOUT_SEC = 120;
const UPLOAD_TIMEOUT_MS = 10 * MINUTE_MS;
const DOWNLOAD_TIMEOUT_SEC = 900;
const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
export const RETRY_HINT = 'Run the same command again: it sends the same idempotency key, so it is never paid twice.';

const setting = (rt: Runtime, name: string): string | undefined => rt.env[name]?.trim() || undefined;

const numberSetting = (rt: Runtime, name: string, example: string): number | undefined => {
  const raw = setting(rt, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new GenerateError(name + ' is a number, such as ' + example + '; it is "' + raw + '".', 2);
  return value;
};

/** The keys of a list written as "a,b c". */
const keysOf = (raw: string | undefined): string[] => (raw ?? '').split(/[\s,]+/).filter(Boolean);

/**
 * The settings of the environment and the command line; the request has no say in them. materials passes its part
 * through the environment: POPOST_GEN_MAX_CREDITS (what is left of its budget), POPOST_GEN_PROJECT, POPOST_GEN_FILE
 * and POPOST_GEN_REQUEST (the clip in the project and the hash of its request as written), POPOST_GEN_APPROVE.
 */
export const cloudSettings = (rt: Runtime, flags: CloudFlags): CloudSettings => {
  const project = flags.project ?? setting(rt, 'POPOST_GEN_PROJECT');
  const [file, planned] = [setting(rt, 'POPOST_GEN_FILE'), setting(rt, 'POPOST_GEN_REQUEST')];
  return {
    videoModel: setting(rt, 'POPOST_VIDEO_MODEL'),
    resolution: setting(rt, 'POPOST_VIDEO_RESOLUTION'),
    imageModel: setting(rt, 'POPOST_IMAGE_MODEL'),
    maxCredits: flags.maxCredits ?? numberSetting(rt, 'POPOST_GEN_MAX_CREDITS', '60'),
    waitMinutes: numberSetting(rt, 'POPOST_GEN_WAIT_MIN', '30') || DEFAULT_WAIT_MIN,
    yes: flags.yes,
    gate: { ...(project ? { project } : {}), ...(file ? { file } : {}), ...(planned ? { planned } : {}), approve: [...(flags.approve ?? []), ...keysOf(setting(rt, 'POPOST_GEN_APPROVE'))] },
  };
};

const UNPLANNED_NEXT =
  'This clip is not one of the clips the user agreed to (a new clip, a regeneration or variant, or a changed request), so nothing was charged, whatever the budget. Show the user the clip, why it is needed and its price; only after a yes, run again with --approve-unplanned <its key>.';

/**
 * Goes on only with the user's agreement to the price: within the budget of the call when one is set (--max-credits,
 * POPOST_GEN_MAX_CREDITS; --yes never passes it), else with --yes. A balance that cannot pay is said first: there is
 * nothing to agree to then. An unplanned clip is asked about next, whatever the budget.
 */
export const agreeToPrice = (s: CloudSettings, price: PriceToConfirm, unplanned?: UnplannedClip): void => {
  if (typeof price.balance === 'number' && price.balance < price.credits)
    throw new GenerateError('Not enough credits: this needs ' + price.credits + ' credits and the balance is ' + price.balance + '. Nothing was charged; popost account shows the balance and where to buy more. [INSUFFICIENT_CREDITS]');
  if (unplanned) throw new ConfirmNeeded({ ...price, reason: 'unplanned', clip: unplanned }, UNPLANNED_NEXT);
  if (s.maxCredits !== undefined ? price.credits <= s.maxCredits : s.yes) return;
  throw new ConfirmNeeded(
    price,
    s.maxCredits !== undefined
      ? 'This costs ' + price.credits + ' credits, more than the budget of this call (' + s.maxCredits + ' credits), so nothing was charged. Show the user the price; only if they agree, run again with --confirm --max-credits N (N: what is left of the agreed budget).'
      : 'This costs ' + price.credits + ' credits and nothing was charged: show the user the price, and run again with --confirm --max-credits N only after they agree.',
  );
};

/** The idempotency key of a request: what it asks for, with its references by content. The same request, the same key. */
export const requestKey = (kind: GenerateKind, fields: JsonRecord): string => kind + '-' + sha256(JSON.stringify(fields));

// ---------- references ----------

export type MediaKind = 'image' | 'video' | 'audio';
type ListName = 'images' | 'videos' | 'audios';
const LISTS: readonly (readonly [MediaKind, ListName, string])[] = [
  ['image', 'images', 'a JPEG, PNG or WebP picture'],
  ['video', 'videos', 'an MP4 or MOV clip'],
  ['audio', 'audios', 'an MP3 or WAV sound'],
];

const has = (head: Uint8Array, from: number, text: string): boolean => String.fromCharCode(...head.subarray(from, from + text.length)) === text;

/** The type of a reference file by its first bytes (the extension is not trusted); null when the platform does not take it. */
export const mediaType = (kind: MediaKind, head: Uint8Array): string | null => {
  if (kind === 'image') {
    const mime = sniffImageMime(head);
    return mime === 'image/gif' ? null : mime;
  }
  if (kind === 'video') {
    if (has(head, 4, 'ftyp')) return has(head, 8, 'qt  ') ? 'video/quicktime' : 'video/mp4';
    return ['moov', 'mdat', 'wide', 'free'].some((box) => has(head, 4, box)) ? 'video/quicktime' : null;
  }
  if (has(head, 0, 'RIFF') && has(head, 8, 'WAVE')) return 'audio/wav';
  return has(head, 0, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) ? 'audio/mpeg' : null;
};

interface Reference {
  readonly kind: MediaKind;
  /** A frame the clip starts from or ends on, not a reference: sent as frames.first or frames.last. */
  readonly frame?: 'first' | 'last';
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mimeType: string;
}

const readReference = async (rt: Runtime, kind: MediaKind, path: string, where: string, what: string): Promise<Reference> => {
  const name = rt.path.basename(path);
  const bytes = await rt.fs.readFile(path).catch(() => {
    throw new GenerateError('The reference file ' + path + ' cannot be read; nothing was sent.', 2);
  });
  const mimeType = mediaType(kind, bytes.subarray(0, 16));
  if (!mimeType) throw new GenerateError(name + ' in "' + where + '" is not ' + what + '; nothing was sent.', 2);
  return { kind, name, bytes, sha256: sha256(bytes), mimeType };
};

/**
 * The files of a request: its references, or the frames it starts from and ends on. The platform takes one or the
 * other (a model starts from a frame or follows references), so a request with both is refused here, before anything
 * is uploaded.
 */
const readReferences = async (rt: Runtime, request: GenerateRequest): Promise<Reference[]> => {
  const out: Reference[] = [];
  for (const [kind, list, what] of LISTS) for (const path of request[list] ?? []) out.push(await readReference(rt, kind, path, list, what));
  const { firstFrame, lastFrame } = request;
  if (firstFrame === undefined && lastFrame === undefined) return out;
  if (out.length) throw new GenerateError('"firstFrame" and "lastFrame" cannot be combined with "images", "videos" or "audios": a clip starts from a frame or follows references, not both. Nothing was sent.', 2);
  if (firstFrame === undefined) throw new GenerateError('"lastFrame" needs "firstFrame": the picture the clip starts from. Nothing was sent.', 2);
  const picture = 'a JPEG, PNG or WebP picture';
  return [
    { ...(await readReference(rt, 'image', firstFrame, 'firstFrame', picture)), frame: 'first' },
    ...(lastFrame === undefined ? [] : [{ ...(await readReference(rt, 'image', lastFrame, 'lastFrame', picture)), frame: 'last' as const }]),
  ];
};

// ---------- what was sent ----------

interface Upload {
  readonly uploadId: string;
  readonly expiresAt: string | null;
}

interface Quote {
  readonly quoteId: string;
  readonly expiresAt: string | null;
  /** The body that was priced: a generation must send the same. */
  readonly body: string;
  readonly price: PriceToConfirm;
}

/** The record of one request: its uploads by content, its quote, its task. */
interface Sent {
  readonly key: string;
  /** 1, and one more for every task that failed or expired. */
  readonly attempt: number;
  readonly uploads: Readonly<Record<string, Upload>>;
  readonly quote?: Quote;
  readonly taskId?: string;
}

const recordFile = (rt: Runtime, key: string): string => rt.path.join(defaultTaskDir(rt), 'videos', key + '.json');

const readRecord = async (rt: Runtime, file: string, key: string): Promise<Sent> => {
  const fresh: Sent = { key, attempt: 1, uploads: {} };
  const text = await rt.fs.readText(file).catch(() => undefined);
  if (text === undefined) return fresh;
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) && data.key === key && typeof data.attempt === 'number' && isRecord(data.uploads) ? (data as unknown as Sent) : fresh;
  } catch {
    return fresh;
  }
};

const save = async (rt: Runtime, file: string, sent: Sent): Promise<Sent> => {
  await writeAtomic(rt, file, JSON.stringify({ schema: 'popost-video-generation.v1', ...sent }, null, 1) + '\n');
  return sent;
};

const keyOf = (sent: Sent): string => (sent.attempt > 1 ? sent.key + '.' + sent.attempt : sent.key);

/** Whether a time the platform gave is still more than marginMs away. */
const stillValid = (rt: Runtime, at: string | null | undefined, marginMs: number): boolean => typeof at === 'string' && Date.parse(at) - rt.now().getTime() > marginMs;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// ---------- uploads ----------

const putBytes = async (rt: Runtime, ticket: JsonRecord, ref: Reference): Promise<void> => {
  const url = checkUrl(String(ticket.uploadUrl), 'uploadUrl');
  const headers = Object.fromEntries(Object.entries(isRecord(ticket.headers) ? ticket.headers : {}).map(([k, v]) => [k, String(v)]));
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = ref.mimeType;
  let response: Response;
  try {
    // The bytes go to the storage address as the ticket says, without the platform's key.
    response = await rt.fetch(url, { method: String(ticket.method || 'PUT').toUpperCase(), headers, body: ref.bytes as Uint8Array<ArrayBuffer>, signal: timeoutSignal(rt, UPLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new GenerateError('Uploading ' + ref.name + ' failed (' + networkReason(error, url) + '); nothing was charged. Run the command again.');
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new GenerateError('The storage service refused the upload of ' + ref.name + ' (HTTP ' + response.status + '); nothing was charged. Run the command again.');
};

const upload = async (rt: Runtime, client: PopostClient, ref: Reference): Promise<Upload> => {
  const ticket = await client.request('POST', '/videos/uploads', { body: { kind: ref.kind, mimeType: ref.mimeType, bytes: ref.bytes.length, sha256: ref.sha256 } });
  if (!isRecord(ticket) || typeof ticket.uploadId !== 'string' || typeof ticket.uploadUrl !== 'string')
    throw new GenerateError('popost.ai answered the upload of ' + ref.name + ' without an upload address; nothing was charged. Try again later.');
  await putBytes(rt, ticket, ref);
  return { uploadId: ticket.uploadId, expiresAt: text(ticket.expiresAt) ?? null };
};

/** Every reference uploaded; an upload of the same bytes that is kept for another hour is used again. */
const ensureUploads = async (rt: Runtime, client: PopostClient, refs: readonly Reference[], start: Sent, file: string): Promise<Sent> => {
  let sent = start;
  for (const ref of refs) {
    if (stillValid(rt, sent.uploads[ref.sha256]?.expiresAt, 60 * MINUTE_MS)) continue;
    sent = await save(rt, file, { ...sent, uploads: { ...sent.uploads, [ref.sha256]: await upload(rt, client, ref) } });
  }
  return sent;
};

// ---------- quote, task ----------

/** The body of the quote, and of the generation besides its prompt, quote id and key. */
const specOf = (s: CloudSettings, request: GenerateRequest, seconds: number, refs: readonly Reference[], sent: Sent): JsonRecord => {
  const idOf = (r: Reference | undefined): string => sent.uploads[r?.sha256 ?? '']?.uploadId ?? '';
  const ids = (kind: MediaKind): string[] => refs.filter((r) => r.kind === kind && !r.frame).map(idOf);
  const references = Object.fromEntries(LISTS.map(([kind, list]) => [list, ids(kind)] as const).filter(([, list]) => list.length));
  const [first, last] = [refs.find((r) => r.frame === 'first'), refs.find((r) => r.frame === 'last')];
  return {
    ...(s.videoModel ? { model: s.videoModel } : {}),
    ...(s.resolution ? { resolution: s.resolution } : {}),
    seconds,
    ...(request.aspect ? { aspectRatio: request.aspect } : {}),
    ...(first ? { frames: { first: idOf(first), ...(last ? { last: idOf(last) } : {}) } } : {}),
    ...(Object.keys(references).length ? { references } : {}),
  };
};

/** The price of the body: the recorded quote while it is valid for another minute, else a new one. */
const ensureQuote = async (rt: Runtime, client: PopostClient, body: JsonRecord, sent: Sent, file: string): Promise<Sent> => {
  const json = JSON.stringify(body);
  if (sent.quote?.body === json && stillValid(rt, sent.quote.expiresAt, MINUTE_MS)) return sent;
  const data = await client.request('POST', '/videos/quote', { body }).catch((error: unknown) => {
    // The platform names the field a model does not take: a model without frames is said in so many words.
    if (body.frames && error instanceof PopostApiError && error.code === 'VIDEO_OPTION_UNSUPPORTED' && error.details.field === 'frames')
      throw new GenerateError('This video model does not take a first or last frame (popost video generate --models lists "frames" for each model): choose another with POPOST_VIDEO_MODEL, or give the picture as a reference in "images" instead. Nothing was charged.');
    throw error;
  });
  if (!isRecord(data) || typeof data.quoteId !== 'string' || typeof data.credits !== 'number')
    throw new GenerateError('popost.ai answered the quote without a quote id or a price; nothing was charged. Try again later.');
  const price: PriceToConfirm = {
    credits: data.credits,
    model: text(data.model),
    resolution: text(data.resolution),
    seconds: typeof data.seconds === 'number' ? data.seconds : undefined,
    aspectRatio: text(data.aspectRatio),
    balance: typeof data.balance === 'number' ? data.balance : null,
  };
  return save(rt, file, { ...sent, quote: { quoteId: data.quoteId, expiresAt: text(data.quoteExpiresAt) ?? null, body: json, price } });
};

interface Task {
  readonly id: string;
  readonly status: string;
  readonly credits?: unknown;
  readonly video?: { readonly url?: unknown; readonly bytes?: unknown };
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const taskOf = (data: unknown): Task | undefined => (isRecord(data) && typeof data.id === 'string' && typeof data.status === 'string' ? (data as unknown as Task) : undefined);

const createTask = async (rt: Runtime, client: PopostClient, body: JsonRecord): Promise<Task> => {
  for (let tries = 1; ; tries++) {
    try {
      const task = taskOf(await client.request('POST', '/videos/generations', { body, ambiguous: true, hint: RETRY_HINT, timeoutSec: CREATE_TIMEOUT_SEC }));
      if (task) return task;
      throw new AmbiguousSubmitError('popost.ai answered without a task, so whether it took the request is unknown. ' + RETRY_HINT);
    } catch (error) {
      // One key and one body make one task at most: asking again is safe, and finds out what happened.
      if (!(error instanceof AmbiguousSubmitError) || tries >= CREATE_TRIES) throw error;
      await sleep(rt, POLL_MS);
    }
  }
};

interface Job {
  readonly request: GenerateRequest;
  readonly seconds: number;
  readonly refs: readonly Reference[];
  readonly file: string;
  /** Set when the clip is not one the user agreed to: it is asked about, whatever the budget. */
  readonly unplanned?: UnplannedClip;
  /** Called once the task is made, with the price it was made at. */
  readonly onPaid: (credits: number) => Promise<void>;
}

const submit = async (rt: Runtime, client: PopostClient, s: CloudSettings, job: Job, start: Sent): Promise<Task> => {
  let sent = start;
  for (let round = 1; ; round++) {
    sent = await ensureUploads(rt, client, job.refs, sent, job.file);
    const body = specOf(s, job.request, job.seconds, job.refs, sent);
    sent = await ensureQuote(rt, client, body, sent, job.file);
    const quote = sent.quote as Quote;
    // Only the price was asked for (GenerateRequest.priceOnly): it is answered as a price to agree to, whatever the budget.
    if (job.request.priceOnly) throw new ConfirmNeeded(quote.price, 'This costs ' + quote.price.credits + ' credits. Only its price was asked for: nothing was made or charged.');
    agreeToPrice(s, quote.price, job.unplanned);
    try {
      const task = await createTask(rt, client, { ...body, prompt: job.request.prompt, quoteId: quote.quoteId, idempotencyKey: keyOf(sent) });
      await save(rt, job.file, { ...sent, taskId: task.id });
      await job.onPaid(typeof task.credits === 'number' ? task.credits : quote.price.credits);
      return task;
    } catch (error) {
      // A quote that ran out while the user decided: priced again (and agreed again) once.
      if (round > 1 || !(error instanceof PopostApiError) || error.code !== 'QUOTE_EXPIRED') throw error;
      const { quote: _expired, ...rest } = sent;
      sent = rest;
    }
  }
};

const getTask = async (client: PopostClient, id: string): Promise<Task> => {
  const task = taskOf(await client.request('GET', '/videos/generations', { query: { id } }));
  if (!task) throw new PopostApiError('popost.ai answered without the task ' + id, { code: 'BAD_RESPONSE' });
  return task;
};

/** The task as it is now, or undefined when the platform no longer has it. */
const findTask = (client: PopostClient, id: string): Promise<Task | undefined> =>
  getTask(client, id).catch((error: unknown) => {
    if (error instanceof PopostApiError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  });

const ENDED = ['succeeded', 'failed', 'expired'];
/** Answers that say nothing about the task: the next poll asks again. */
const PASSING = new Set(['NETWORK', 'BAD_RESPONSE', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'TIMEOUT', 'UPSTREAM_ERROR']);

const waitFor = async (rt: Runtime, client: PopostClient, first: Task, minutes: number): Promise<Task> => {
  const deadline = rt.now().getTime() + minutes * MINUTE_MS;
  let task = first;
  while (!ENDED.includes(task.status)) {
    if (rt.now().getTime() >= deadline)
      throw new GenerateError('The clip is still being made on popost.ai after ' + minutes + ' minutes (task ' + task.id + ', ' + task.status + '). Run the same command again later to pick it up: it is not paid twice. POPOST_GEN_WAIT_MIN waits longer.');
    await sleep(rt, POLL_MS);
    const last = task;
    task = await getTask(client, task.id).catch((error: unknown) => {
      if (error instanceof PopostApiError && PASSING.has(error.code ?? '')) return last;
      throw error;
    });
  }
  return task;
};

const ended = (task: Task): GenerateError => {
  if (task.status === 'expired')
    return new GenerateError('The clip of task ' + task.id + ' was kept 7 days on popost.ai and has been deleted. Run the command again to make it again (it is priced again).');
  const code = text(task.error?.code) ?? 'GENERATION_FAILED';
  return new GenerateError('The clip could not be made: ' + describeError(code, task.error?.message) + '. Its credits were refunded; running the command again makes a new attempt, priced again.');
};

const fetchClip = async (rt: Runtime, client: PopostClient, done: Task, out: string): Promise<void> => {
  const labels = { what: 'the clip', retry: 'run the same command again: it downloads the clip without paying again' };
  let task = done;
  for (let tries = 1; ; tries++) {
    const url = task.video?.url;
    if (typeof url !== 'string') throw new GenerateError('popost.ai says the clip of task ' + task.id + ' is made but gives no link to it. Run the command again later.');
    try {
      const data = await downloadResult(rt, url, out, MAX_CLIP_BYTES, DOWNLOAD_TIMEOUT_SEC, labels);
      const bytes = task.video?.bytes;
      if (typeof bytes === 'number' && data.length !== bytes) {
        await rt.fs.rm(out);
        throw new PopostApiError('The clip arrived with ' + data.length + ' of its ' + bytes + ' bytes; ' + labels.retry, { code: 'DOWNLOAD_FAILED' });
      }
      return;
    } catch (error) {
      // A link that ran out: the task gives a new one.
      if (tries >= 2 || !(error instanceof PopostApiError) || error.code !== 'DOWNLOAD_FAILED') throw error;
      task = await getTask(client, task.id);
    }
  }
};

/** The agreement the clip is held to, when its project has one: the project of the settings, else the one above out. */
const gateOf = async (rt: Runtime, s: CloudSettings, out: string): Promise<ClipGate | undefined> => {
  const project = s.gate.project ?? (await projectOf(rt, out));
  if (!project) return undefined;
  const inside = rt.path.relative(project, out);
  const file = s.gate.file ?? (inside.startsWith('..') ? undefined : inside.split(rt.path.sep).join('/'));
  return { ...s.gate, project, ...(file ? { file } : {}) };
};

/** What a made clip says: what it cost, what this call charged (0 when it was paid before) and its request key. */
export interface MadeClip { credits?: number; chargedCredits: number; key: string }

/** Makes the clip a request asks for at out, on popost.ai; resolves with the credits it cost and was charged now. */
export const makeClip = async (rt: Runtime, client: PopostClient, s: CloudSettings, request: GenerateRequest, out: string): Promise<MadeClip> => {
  const seconds = request.seconds ?? DEFAULT_SECONDS;
  const refs = await readReferences(rt, request);
  const byContent = Object.fromEntries(LISTS.map(([kind, list]) => [list, refs.filter((r) => r.kind === kind && !r.frame).map((r) => r.sha256)]));
  // The frames join the key only when there are any, so a request without them keeps the key it always had.
  const frames = Object.fromEntries(refs.flatMap((r) => (r.frame ? [[r.frame + 'Frame', r.sha256]] : [])));
  const key = requestKey('video', { model: s.videoModel ?? null, resolution: s.resolution ?? null, prompt: request.prompt, seconds, aspect: request.aspect ?? null, ...byContent, ...frames });
  const file = recordFile(rt, key);
  let sent = await readRecord(rt, file, key);
  let task = sent.taskId ? await findTask(client, sent.taskId) : undefined;
  if (sent.taskId && (!task || task.status === 'failed' || task.status === 'expired')) {
    // That attempt is over and nothing more comes of it: the next one has a key of its own.
    sent = { key, attempt: sent.attempt + 1, uploads: sent.uploads };
    task = undefined;
  }
  let charged = 0;
  if (!task) {
    // A new task is paid for: within a project's agreement only when the clip is one of the agreed clips.
    const gate = request.priceOnly ? undefined : await gateOf(rt, s, out);
    const standing = gate ? await clipStanding(rt, gate, key) : undefined;
    const what = shortWhat(request.prompt);
    const unplanned = standing === 'unplanned' ? { key, ...(gate?.file ? { file: gate.file } : {}), what, seconds, ...(request.aspect ? { aspect: request.aspect } : {}) } : undefined;
    const onPaid = async (credits: number): Promise<void> => {
      charged = credits;
      if (gate && (standing === 'plan' || standing === 'user')) await recordClip(rt, gate, { key, ...(gate.file ? { file: gate.file } : {}), what, seconds, credits, by: standing });
    };
    task = await submit(rt, client, s, { request, seconds, refs, file, onPaid, ...(unplanned ? { unplanned } : {}) }, sent);
  }
  const done = await waitFor(rt, client, task, s.waitMinutes);
  if (done.status !== 'succeeded') throw ended(done);
  await fetchClip(rt, client, done, out);
  return { ...(typeof done.credits === 'number' ? { credits: done.credits } : {}), chargedCredits: charged, key };
};

/** GET /videos/models: the models a clip can be made with, and the one used when POPOST_VIDEO_MODEL is unset. */
export const listModels = async (client: PopostClient): Promise<JsonRecord> => {
  const data = await client.request('GET', '/videos/models');
  if (!isRecord(data) || !Array.isArray(data.models)) throw new GenerateError('popost.ai answered without a list of video models. Try again later.');
  return {
    models: data.models,
    default: data.default ?? null,
    note: 'POPOST_VIDEO_MODEL takes an id, POPOST_VIDEO_RESOLUTION one of its resolutions. "frames": true is a model that takes "firstFrame" and "lastFrame". Every clip costs credits, and popost.ai keeps it 7 days.',
  };
};
