/**
 * An in-memory popost.ai Open API for the hosted voice, transcription and music tests: the voice catalog, speech with
 * word times, new voices, transcription jobs and music jobs, with the signed addresses they hand out, and the account's
 * balance (GET /me), which every charge takes from. It records every request. Nothing leaves the process.
 */
import { expect } from 'vitest';

export const BASE = 'https://platform.example.test/api/open/v1';
export const UPLOADS = 'https://uploads.example.test';
export const AUDIO = 'https://audio.example.test';
export const ENV = { POPOST_API_KEY: 'test-platform-credential', POPOST_BASE_URL: BASE };

/** A PCM WAV of `seconds` of silence; `list` adds a LIST chunk before the sound, as ffmpeg writes one. */
export const wav = (o: { rate?: number; channels?: number; bits?: number; seconds?: number; list?: boolean } = {}): Uint8Array => {
  const rate = o.rate ?? 16000, channels = o.channels ?? 1, bits = o.bits ?? 16, block = (channels * bits) / 8;
  const data = Math.round((o.seconds ?? 1) * rate) * block, list = o.list ? 26 : 0;
  const bytes = new Uint8Array(44 + list + data), view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + list + data, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * block, true);
  view.setUint16(32, block, true); view.setUint16(34, bits, true);
  if (o.list) { text(36, 'LIST'); view.setUint32(40, 18, true); text(44, 'INFOISFT'); }
  text(36 + list, 'data'); view.setUint32(40 + list, data, true);
  return bytes;
};

export interface Sent { method: string; path: string; body: Record<string, unknown> | null; authorization: string | null; task: string | null }

/** A file that starts as an MP3 does (an ID3 tag), `size` bytes long. */
export const mp3 = (size = 512): Uint8Array => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0x49, 0x44, 0x33, 4, 0]);
  return bytes;
};
export interface Put { url: string; bytes: Uint8Array; contentType: string | null; authorization: string | null }

export const voice = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Voice ' + id, description: '', language: 'zh', official: false, sampleUrl: AUDIO + '/sample-' + id + '.wav', defaultFor: null, cloneState: 'pending', ...extra,
});
export const MALE = voice('40ae377c-7f86-4a57-ab15-aa2bd917cf37', { name: 'Default male', official: true, defaultFor: 'male', cloneState: 'ready' });

export interface FakeOptions {
  /** Words the speech answer carries (null: the field is null). */
  speechWords?: unknown;
  /** Bytes served for every audio address (speech results, voice samples). */
  audio?: Uint8Array;
  /** Credits a transcription of `seconds` costs. Default: one per started 10 s. */
  price?: (seconds: number) => number;
  /** The words a finished transcription has. */
  heard?: { text: string; start: number; end: number }[];
  /** Run answers with something that is not an envelope (the outcome is unknown). */
  runBroken?: boolean;
  /** A run takes long: it answers `running`, and the job is ready (or failed) after this many reads. */
  runningReads?: number;
  /** Runs (1 for the first) that start their job, then their answer is cut off (a proxy ends it): the outcome is unknown. */
  cutRuns?: number[];
  /** Runs (1 for the first) whose job ends `failed` instead of `ready`. */
  failRuns?: number[];
  /** Every new job has failed by the time it is made. */
  failAtCreate?: boolean;
  /** POST /voices/{id}/complete refuses the uploaded sample. */
  refuseSample?: boolean;
  /** The first read is rate limited, with a Retry-After of this many seconds. */
  limitFirstRead?: number;
  /** POST /voices refuses with this code. */
  voiceRefusal?: string;
  /** The account's balance at the start (GET /me); unset, GET /me is not answered and the balance is unknown. */
  balance?: number;
  /** Credits one line of speech costs. Default 1. */
  speechPrice?: number;
  /** Credits a music track of `seconds` costs. Default: 1.8 a second, rounded up. */
  musicPrice?: (seconds: number) => number;
  /** A new music job answers `running`, and is done after this many reads. */
  musicReads?: number;
  /** How each new music job ends, in order (the first for the first job): null or absent, ready. */
  musicFailures?: ('rejected' | 'unavailable' | null)[];
  /** The rewritten prompt a rejected job carries. */
  musicSuggestion?: string;
  /** POST /music refuses with this code, before any job is made. */
  musicRefusal?: string;
  /** Bytes served for a music address. */
  music?: Uint8Array;
}

export const fakePlatform = (o: FakeOptions = {}) => {
  const sent: Sent[] = [], puts: Put[] = [];
  const voices = [MALE];
  const made = new Map<string, { id: string; done: boolean }>();
  type Job = { id: string; key: string; language?: string; uploaded?: Uint8Array; state: 'created' | 'running' | 'ready' | 'failed'; reads: number; charged: number; fails?: boolean };
  const jobs = new Map<string, Job>();
  let runs = 0, reads = 0;
  const account = { balance: o.balance ?? 0, charged: 0 };
  const charge = (credits: number): void => void ((account.balance -= credits), (account.charged += credits));
  const price = o.price ?? ((s: number) => Math.ceil(s / 10));
  const speechPrice = o.speechPrice ?? 1;
  const spoken = new Set<string>();
  type Track = { id: string; key: string; seconds: number; state: 'running' | 'ready' | 'failed'; reads: number; charged: number; failure: 'rejected' | 'unavailable' | null };
  const tracks = new Map<string, Track>();
  const musicPrice = o.musicPrice ?? ((s: number) => Math.ceil(s * 1.8));
  /** A track is charged when it is asked for; one that fails gives the credits back. */
  const settle = (t: Track): void => {
    t.state = t.failure ? 'failed' : 'ready';
    if (t.failure) void (charge(-t.charged), (t.charged = 0));
  };
  /** A failed job is final for its key: asking again with the key gets the same refusal, and nothing is made or charged. */
  const failedTrack = (t: Track): Response =>
    Response.json({ success: false, data: null, error: { code: t.failure === 'rejected' ? 'CONTENT_REJECTED' : 'UPSTREAM_ERROR', message: 'Failed.', details: t.failure === 'rejected' && o.musicSuggestion ? { suggestion: o.musicSuggestion } : {} } }, { status: t.failure === 'rejected' ? 422 : 502 });
  const track = (t: Track) => ({
    id: t.id, state: t.state, seconds: t.seconds, chargedCredits: t.charged, audioUrl: t.state === 'ready' ? AUDIO + '/music/' + t.id + '.mp3' : null,
    failure: t.state === 'failed' ? t.failure : null, suggestion: t.state === 'failed' && t.failure === 'rejected' ? (o.musicSuggestion ?? null) : null,
  });
  const ok = (data: unknown) => Response.json({ success: true, data, error: null });
  const refuse = (code: string, message: string, status = 400) => Response.json({ success: false, data: null, error: { code, message } }, { status });
  const secondsOf = (j: Job): number => ((j.uploaded?.length ?? 44) - 44) / 32000;
  /** A running job moves on with every read; it is charged when it is ready. */
  const advance = (j: Job): void => {
    if (j.state !== 'running' || --j.reads > 0) return;
    if (j.fails) j.state = 'failed';
    else {
      Object.assign(j, { state: 'ready', charged: price(secondsOf(j)) });
      charge(j.charged);
    }
  };
  const result = (j: Job) => j.state !== 'ready' ? { id: j.id, state: j.state } : ({
    id: j.id, state: j.state, language: j.language ?? 'zh', seconds: secondsOf(j), chargedCredits: j.charged,
    words: o.heard ?? [{ text: '你', start: 0.1, end: 0.3 }, { text: '好', start: 0.3, end: 0.5 }, { text: '，', start: 0.5, end: 0.55 }, { text: 'Hello', start: 0.6, end: 0.9 }, { text: 'world', start: 0.9, end: 1.2 }],
  });
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === UPLOADS) {
      expect(request.method).toBe('PUT');
      const bytes = new Uint8Array(await request.arrayBuffer());
      puts.push({ url: request.url, bytes, contentType: request.headers.get('content-type'), authorization: request.headers.get('authorization') });
      const job = [...jobs.values()].find((j) => request.url.endsWith('/' + j.id));
      if (job) job.uploaded = bytes;
      return new Response(null, { status: 200 });
    }
    if (url.origin === AUDIO) {
      expect(request.headers.get('authorization')).toBeNull();
      if (url.pathname.endsWith('.mp3')) return new Response((o.music ?? mp3()) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'audio/mpeg' } });
      return new Response((o.audio ?? wav({ rate: 24000 })) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'audio/wav' } });
    }
    const path = url.pathname.replace(new URL(BASE).pathname, '');
    // The balance is read apart from the work: it is not in `sent`. Unset, the account answers without one.
    if (path === '/me' && request.method === 'GET') return o.balance === undefined ? refuse('NOT_FOUND', 'No balance here.', 404) : ok({ credits: { balance: account.balance } });
    const body = request.method === 'GET' ? null : ((await request.text().then((t) => (t ? JSON.parse(t) : null))) as Record<string, unknown> | null);
    sent.push({ method: request.method, path, body, authorization: request.headers.get('authorization'), task: request.headers.get('x-popost-task') });
    if (path === '/voices' && request.method === 'GET') {
      const scope = url.searchParams.get('scope');
      const items = voices.filter((v) => scope === 'all' || (scope === 'official') === v.official);
      return ok({ items, total: items.length });
    }
    if (path === '/voices/quote') return ok({ credits: speechPrice });
    if (path === '/voices/speech') {
      if (speechPrice > Number(body?.maxCredits))
        return Response.json({ success: false, data: null, error: { code: 'CREDIT_LIMIT_EXCEEDED', message: 'The price is above maxCredits.' } }, { status: 402 });
      // One operation key is charged once.
      const key = String(body?.operationKey);
      if (!spoken.has(key)) void (spoken.add(key), charge(speechPrice));
      return ok({ audioUrl: AUDIO + '/speech.wav', chargedCredits: speechPrice, words: o.speechWords });
    }
    if (path === '/voices' && request.method === 'POST') {
      if (o.voiceRefusal) return refuse(o.voiceRefusal, 'Your plan allows no more personal voices.');
      const key = String(body?.operationKey);
      const known = made.get(key);
      if (known) return ok({ id: known.id, uploadUrl: known.done ? null : UPLOADS + '/voices/' + known.id });
      const id = 'v-' + (made.size + 1);
      made.set(key, { id, done: false });
      return ok({ id, uploadUrl: UPLOADS + '/voices/' + id });
    }
    const complete = /^\/voices\/([^/]+)\/complete$/.exec(path);
    if (complete) {
      const entry = [...made.values()].find((m) => m.id === complete[1]);
      if (!entry || !puts.some((p) => p.url.endsWith('/voices/' + entry.id)) || o.refuseSample)
        return Response.json({ success: false, data: null, error: { code: 'INVALID_REQUEST', message: 'The sample is not usable.', details: { issues: [{ path: 'audio' }] } } }, { status: 400 });
      entry.done = true;
      const item = voice(entry.id, { name: 'Made ' + entry.id });
      if (!voices.some((v) => v.id === item.id)) voices.push(item);
      return ok(item);
    }
    if (path === '/music/quote') return ok({ credits: musicPrice(Number(body?.seconds)) });
    if (path === '/music' && request.method === 'POST') {
      // One operation key is one job: asked for again, it is answered as it is and never charged again.
      const key = String(body?.operationKey);
      const known = [...tracks.values()].find((t) => t.key === key);
      if (known) return known.state === 'failed' ? failedTrack(known) : ok(track(known));
      if (o.musicRefusal) return Response.json({ success: false, data: null, error: { code: o.musicRefusal, message: 'Refused.', details: o.musicSuggestion ? { suggestion: o.musicSuggestion } : {} } }, { status: 422 });
      const seconds = Number(body?.seconds), credits = musicPrice(seconds);
      if (credits > Number(body?.maxCredits))
        return Response.json({ success: false, data: null, error: { code: 'CREDIT_LIMIT_EXCEEDED', message: 'The price is above maxCredits.', details: { required: credits, maxCredits: Number(body?.maxCredits) } } }, { status: 402 });
      const made: Track = { id: 'm-' + (tracks.size + 1), key, seconds, state: 'running', reads: o.musicReads ?? 0, charged: credits, failure: o.musicFailures?.[tracks.size] ?? null };
      tracks.set(made.id, made);
      charge(credits);
      if (!made.reads) settle(made);
      return made.state === 'failed' ? failedTrack(made) : ok(track(made));
    }
    const song = /^\/music\/([^/]+)$/.exec(path);
    if (song && request.method === 'GET') {
      const t = tracks.get(song[1] ?? '');
      if (!t) return refuse('NOT_FOUND', 'No such music.', 404);
      if (t.state === 'running' && --t.reads <= 0) settle(t);
      return ok(track(t));
    }
    if (path === '/transcriptions/quote') return ok({ credits: price(Number(body?.seconds)) });
    if (path === '/transcriptions' && request.method === 'POST') {
      const key = String(body?.operationKey);
      const known = [...jobs.values()].find((j) => j.key === key);
      if (known) return ok({ id: known.id, uploadUrl: known.state === 'created' ? UPLOADS + '/transcriptions/' + known.id : null, state: known.state });
      const id = 't-' + (jobs.size + 1);
      jobs.set(id, { id, key, ...(typeof body?.language === 'string' ? { language: body.language } : {}), state: o.failAtCreate ? 'failed' : 'created', reads: 0, charged: 0 });
      if (o.failAtCreate) return ok({ id, uploadUrl: null, state: 'failed' });
      return ok({ id, uploadUrl: UPLOADS + '/transcriptions/' + id, state: 'created' });
    }
    const run = /^\/transcriptions\/([^/]+)\/run$/.exec(path);
    if (run) {
      if (o.runBroken) return new Response('<html>gateway timeout</html>', { status: 504 });
      const job = jobs.get(run[1] ?? '');
      if (!job?.uploaded) return Response.json({ success: false, data: null, error: { code: 'INVALID_REQUEST', message: 'Upload the sound first.', details: { issues: [{ path: 'audio' }] } } }, { status: 400 });
      if (job.state !== 'created') return ok(result(job));
      const credits = price(secondsOf(job));
      if (credits > Number(body?.maxCredits))
        return Response.json({ success: false, data: null, error: { code: 'CREDIT_LIMIT_EXCEEDED', message: 'The price is above maxCredits.', details: { required: credits, maxCredits: Number(body?.maxCredits) } } }, { status: 402 });
      runs += 1;
      const cut = o.cutRuns?.includes(runs) ?? false;
      job.fails = o.failRuns?.includes(runs) ?? false;
      if (o.runningReads || cut) Object.assign(job, { state: 'running', reads: o.runningReads ?? 2 });
      else if (job.fails) job.state = 'failed';
      else {
        Object.assign(job, { state: 'ready', charged: credits });
        charge(credits);
      }
      if (cut) return new Response('<html>origin timed out</html>', { status: 524 });
      return ok(result(job));
    }
    const read = /^\/transcriptions\/([^/]+)$/.exec(path);
    if (read && request.method === 'GET') {
      const job = jobs.get(read[1] ?? '');
      if (!job) return refuse('NOT_FOUND', 'No such transcription.', 404);
      reads += 1;
      if (o.limitFirstRead && reads === 1)
        return Response.json({ success: false, data: null, error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, { status: 429, headers: { 'retry-after': String(o.limitFirstRead) } });
      advance(job);
      return ok(result(job));
    }
    throw new Error('Unexpected test request ' + request.method + ' ' + path);
  };
  return { handler, sent, puts, voices, jobs, made, tracks, account, paths: () => sent.map((s) => s.method + ' ' + s.path) };
};
