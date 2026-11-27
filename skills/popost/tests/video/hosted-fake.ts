/**
 * An in-memory popost.ai Open API for the hosted voice and transcription tests: the voice catalog, speech with word
 * times, new voices and transcription jobs, with the signed upload addresses they hand out. It records every request.
 * Nothing leaves the process.
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

export interface Sent { method: string; path: string; body: Record<string, unknown> | null; authorization: string | null }
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
  /** POST /voices refuses with this code. */
  voiceRefusal?: string;
}

export const fakePlatform = (o: FakeOptions = {}) => {
  const sent: Sent[] = [], puts: Put[] = [];
  const voices = [MALE];
  const made = new Map<string, { id: string; done: boolean }>();
  const jobs = new Map<string, { id: string; key: string; language?: string; uploaded?: Uint8Array; ready: boolean; charged: number }>();
  const price = o.price ?? ((s: number) => Math.ceil(s / 10));
  const ok = (data: unknown) => Response.json({ success: true, data, error: null });
  const refuse = (code: string, message: string, status = 400) => Response.json({ success: false, data: null, error: { code, message } }, { status });
  const result = (j: { id: string; language?: string; ready: boolean; charged: number; uploaded?: Uint8Array }) => ({
    id: j.id, state: j.ready ? 'ready' : 'uploaded', language: j.language ?? 'zh', seconds: ((j.uploaded?.length ?? 44) - 44) / 32000, chargedCredits: j.charged,
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
      return new Response((o.audio ?? wav({ rate: 24000 })) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'audio/wav' } });
    }
    const path = url.pathname.replace(new URL(BASE).pathname, '');
    const body = request.method === 'GET' ? null : ((await request.text().then((t) => (t ? JSON.parse(t) : null))) as Record<string, unknown> | null);
    sent.push({ method: request.method, path, body, authorization: request.headers.get('authorization') });
    if (path === '/voices' && request.method === 'GET') {
      const scope = url.searchParams.get('scope');
      const items = voices.filter((v) => scope === 'all' || (scope === 'official') === v.official);
      return ok({ items, total: items.length });
    }
    if (path === '/voices/quote') return ok({ credits: 1 });
    if (path === '/voices/speech') return ok({ audioUrl: AUDIO + '/speech.wav', chargedCredits: 1, words: o.speechWords });
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
      if (!entry || !puts.some((p) => p.url.endsWith('/voices/' + entry.id))) return refuse('VOICE_SAMPLE_MISSING', 'Upload the sample first.');
      entry.done = true;
      const item = voice(entry.id, { name: 'Made ' + entry.id });
      if (!voices.some((v) => v.id === item.id)) voices.push(item);
      return ok(item);
    }
    if (path === '/transcriptions/quote') return ok({ credits: price(Number(body?.seconds)) });
    if (path === '/transcriptions' && request.method === 'POST') {
      const key = String(body?.operationKey);
      const known = [...jobs.values()].find((j) => j.key === key);
      if (known) return ok({ id: known.id, uploadUrl: known.ready ? null : UPLOADS + '/transcriptions/' + known.id, state: known.ready ? 'ready' : 'created' });
      const id = 't-' + (jobs.size + 1);
      jobs.set(id, { id, key, ...(typeof body?.language === 'string' ? { language: body.language } : {}), ready: false, charged: 0 });
      return ok({ id, uploadUrl: UPLOADS + '/transcriptions/' + id, state: 'created' });
    }
    const run = /^\/transcriptions\/([^/]+)\/run$/.exec(path);
    if (run) {
      if (o.runBroken) return new Response('<html>gateway timeout</html>', { status: 504 });
      const job = jobs.get(run[1] ?? '');
      if (!job?.uploaded) return refuse('TRANSCRIPTION_NOT_UPLOADED', 'Upload the sound first.');
      const credits = price((job.uploaded.length - 44) / 32000);
      if (credits > Number(body?.maxCredits)) return refuse('CREDIT_LIMIT', 'The transcription costs more than maxCredits.');
      Object.assign(job, { ready: true, charged: credits });
      return ok(result(job));
    }
    const read = /^\/transcriptions\/([^/]+)$/.exec(path);
    if (read && request.method === 'GET') {
      const job = jobs.get(read[1] ?? '');
      return job ? ok(result(job)) : refuse('NOT_FOUND', 'No such transcription.', 404);
    }
    throw new Error('Unexpected test request ' + request.method + ' ' + path);
  };
  return { handler, sent, puts, voices, jobs, made, paths: () => sent.map((s) => s.method + ' ' + s.path) };
};
