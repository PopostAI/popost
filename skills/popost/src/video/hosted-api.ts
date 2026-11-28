/**
 * The video engine's calls to the popost.ai Open API for spoken word times, new voices, transcription and music, in one place:
 * the paths, the request bodies and the fields read from the answers. A change of the platform's field names is made
 * here and nowhere else.
 *
 *   POST /voices/speech             answer gains words: [{ text, start, end }] | null (seconds from the start of the WAV)
 *   POST /voices                    { operationKey, name, language?, description?, sizeBytes, consent: true } -> { id, uploadUrl | null }
 *   POST /voices/{id}/complete      -> the voice, as GET /voices lists it
 *   POST /transcriptions            { operationKey, sizeBytes, language? } -> { id, uploadUrl, state } (the same key again:
 *                                   the same job, `running`, `ready` or `failed` once it was run; a failed job keeps
 *                                   its key, so speech/hosted.ts moves on to a key made from the failed job's id)
 *   POST /transcriptions/quote      { seconds } -> { credits } (free)
 *   POST /transcriptions/{id}/run   { maxCredits } -> { id, state: 'ready', language, seconds, chargedCredits, words },
 *                                   or { id, state: 'running' } when it takes longer than the platform waits (~45 s)
 *   GET  /transcriptions/{id}       the same as run, with 'running', 'ready' or 'failed'; free
 *   POST /music/quote               { seconds } -> { credits } (free)
 *   POST /music                     { operationKey, prompt, seconds, instrumental, maxCredits } -> the music job (the same
 *                                   key again: the same job, never a second charge); answers `ready`, or `running`
 *                                   when it takes longer than the platform waits (~80 s)
 *   GET  /music/{id}                { id, state: 'running' | 'ready' | 'failed', seconds, chargedCredits, audioUrl | null,
 *                                   failure: 'rejected' | 'unavailable' | null, suggestion | null }; free. audioUrl is a
 *                                   signed address of an MP3, valid about an hour; a failed job is refunded in full
 *                                   a job also says `model` (null, or the tier that made it: the generator then returns a whole
 *                                   track, longer than asked) and `maxTrackSeconds`; POST /music/quote answers them too
 *   POST /sound-analyses            { operationKey, sizeBytes, language? } -> { id, uploadUrl, state }
 *   POST /sound-analyses/quote      { seconds } -> { credits } (free)
 *   POST /sound-analyses/{id}/run   { maxCredits } -> the analysis (answers when it is done, up to about 95 s)
 *   GET  /sound-analyses/{id}       { id, state, seconds, chargedCredits, failure, result }; free
 *   GET  /me                        { credits: { balance } }: the balance a price is held against; free
 * Refusals: INVALID_REQUEST (bad or incomplete audio), CREDIT_LIMIT_EXCEEDED (price above maxCredits), UPSTREAM_ERROR
 * (a failed job), RATE_LIMITED (with Retry-After), CONTENT_REJECTED (a music prompt that names an artist or a song,
 * quotes lyrics or asks for harm).
 *
 * The bytes go to the signed uploadUrl with PUT and Content-Type audio/wav, without the platform's headers.
 */
import { sha256 } from '../core/util';
import { PopostClient } from '../providers/api';
import { isRecord } from '../providers/base';
import type { Runtime } from '../runtime';

/** A run waits up to about 45 s (music: 80 s) and answers `running` after that; a proxy on the way ends any answer at 100 s. */
const LONG_SECONDS = 120;
export const platform = (rt: Runtime, timeoutSec = 180): PopostClient => new PopostClient(rt, { timeoutSec });

/** A stable operation key (a version-4 UUID shape) for what `parts` describes: the same request sent again is the same operation. */
export const operationKeyOf = (parts: unknown): string => {
  const hex = sha256(JSON.stringify(parts)).slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8';
  const id = hex.join('');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A word and its time in seconds; confidence (0..1) only when the platform gives one. */
export interface WordTime { text: string; start: number; end: number; confidence?: number }

/** The words of an answer that have a text and a time; anything else in the list is left out. */
export const wordTimesOf = (value: unknown): WordTime[] =>
  (Array.isArray(value) ? value : []).flatMap((w): WordTime[] => {
    if (!isRecord(w) || typeof w.text !== 'string' || !isTime(w.start) || !isTime(w.end) || w.end < w.start) return [];
    const confidence = typeof w.confidence === 'number' && w.confidence >= 0 && w.confidence <= 1 ? { confidence: w.confidence } : {};
    return [{ text: w.text, start: w.start, end: w.end, ...confidence }];
  });

/** The account's credit balance (GET /me, free), or undefined when it cannot be read. */
export const accountBalance = async (rt: Runtime): Promise<number | undefined> => {
  try {
    const data = await platform(rt, 30).request('GET', '/me');
    const balance = isRecord(data) && isRecord(data.credits) ? data.credits.balance : undefined;
    return typeof balance === 'number' && Number.isFinite(balance) ? balance : undefined;
  } catch {
    return undefined;
  }
};

/** A popost.ai account is connected (an API key, or the login of popost auth login). */
export const connected = (rt: Runtime): boolean => {
  try {
    return platform(rt).hasKey();
  } catch {
    return false; // a POPOST_BASE_URL that is not an address: no account to use
  }
};

// ---------- speech ----------

export interface SpeechAnswer { audioUrl: string; chargedCredits: number; words: WordTime[] }

export const speechAnswerOf = (data: unknown): SpeechAnswer => {
  if (!isRecord(data) || typeof data.audioUrl !== 'string' || typeof data.chargedCredits !== 'number') throw new Error('Invalid speech response.');
  return { audioUrl: data.audioUrl, chargedCredits: data.chargedCredits, words: wordTimesOf(data.words) };
};

// ---------- new voices ----------

export interface NewVoice { operationKey: string; name: string; language?: 'zh' | 'en'; description?: string; sizeBytes: number }

/** Asks for a new personal voice. uploadUrl null: this operation key already made its voice. */
export const startVoice = async (rt: Runtime, v: NewVoice): Promise<{ id: string; uploadUrl: string | null }> => {
  const body = { operationKey: v.operationKey, name: v.name, ...(v.language ? { language: v.language } : {}), ...(v.description ? { description: v.description } : {}), sizeBytes: v.sizeBytes, consent: true };
  const data = await platform(rt).request('POST', '/voices', { body });
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id || !(typeof data.uploadUrl === 'string' || data.uploadUrl === null)) throw new Error('Invalid voice creation response.');
  return { id: data.id, uploadUrl: data.uploadUrl };
};

/** Says the sample is uploaded; the answer is the voice as the catalog lists it. */
export const finishVoice = async (rt: Runtime, id: string): Promise<Record<string, unknown> & { id: string }> => {
  const data = await platform(rt).request('POST', '/voices/' + encodeURIComponent(id) + '/complete', {});
  if (!isRecord(data) || typeof data.id !== 'string') throw new Error('Invalid voice completion response.');
  return data as Record<string, unknown> & { id: string };
};

// ---------- transcription ----------

export interface TranscriptionJob { id: string; uploadUrl: string | null; state: string }

export const startTranscription = async (rt: Runtime, o: { operationKey: string; sizeBytes: number; language?: string }): Promise<TranscriptionJob> => {
  const body = { operationKey: o.operationKey, sizeBytes: o.sizeBytes, ...(o.language ? { language: o.language } : {}) };
  const data = await platform(rt).request('POST', '/transcriptions', { body });
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id) throw new Error('Invalid transcription response.');
  return { id: data.id, uploadUrl: typeof data.uploadUrl === 'string' ? data.uploadUrl : null, state: typeof data.state === 'string' ? data.state : '' };
};

/** Credits a transcription of this many seconds of sound costs. Free. */
export const quoteTranscription = async (rt: Runtime, seconds: number): Promise<number> => {
  const data = await platform(rt).request('POST', '/transcriptions/quote', { body: { seconds } });
  if (!isRecord(data) || !isCount(data.credits)) throw new Error('Invalid transcription quote.');
  return data.credits;
};

export interface Transcription { id: string; state: string; language: string; seconds: number; chargedCredits: number; words: WordTime[] }

const transcriptionOf = (data: unknown): Transcription => {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.state !== 'string') throw new Error('Invalid transcription response.');
  if (data.state === 'ready' && (!Array.isArray(data.words) || !isCount(data.chargedCredits))) throw new Error('Invalid transcription response.');
  return {
    id: data.id, state: data.state, language: typeof data.language === 'string' ? data.language : '',
    seconds: isTime(data.seconds) ? data.seconds : 0, chargedCredits: isCount(data.chargedCredits) ? data.chargedCredits : 0, words: wordTimesOf(data.words),
  };
};

/** Runs an uploaded transcription, charging at most maxCredits. A request that may charge: an unknown outcome throws AmbiguousSubmitError. */
export const runTranscription = async (rt: Runtime, id: string, maxCredits: number, hint: string): Promise<Transcription> =>
  transcriptionOf(await platform(rt, LONG_SECONDS).request('POST', '/transcriptions/' + encodeURIComponent(id) + '/run', { body: { maxCredits }, ambiguous: true, hint }));

/** A transcription as it is now; reading it never charges. */
export const readTranscription = async (rt: Runtime, id: string): Promise<Transcription> =>
  transcriptionOf(await platform(rt).request('GET', '/transcriptions/' + encodeURIComponent(id)));

/** Uploads a WAV to the signed address of a new voice or a transcription. */
export const uploadWav = (rt: Runtime, url: string, bytes: Uint8Array, what: string): Promise<void> =>
  platform(rt).putSigned(url, bytes, 'audio/wav', what, 'run the same command again');

// ---------- music ----------

/** What a generated track of a length costs, and what makes it: the tier (when the generator returns a whole track) and its longest track. */
export interface MusicQuote { credits: number; model: string | null; maxTrackSeconds: number | null }

/** The price of a generated track of this many seconds, with its tier. Free. */
export const quoteMusicTrack = async (rt: Runtime, seconds: number): Promise<MusicQuote> => {
  const data = await platform(rt).request('POST', '/music/quote', { body: { seconds } });
  if (!isRecord(data) || !isCount(data.credits)) throw new Error('Invalid music quote.');
  return { credits: data.credits, model: typeof data.model === 'string' && data.model ? data.model : null, maxTrackSeconds: isTime(data.maxTrackSeconds) && data.maxTrackSeconds > 0 ? data.maxTrackSeconds : null };
};

/** Credits a generated track of this many seconds costs. Free. */
export const quoteMusic = async (rt: Runtime, seconds: number): Promise<number> => (await quoteMusicTrack(rt, seconds)).credits;

export interface Music {
  id: string; state: string; seconds: number; chargedCredits: number; audioUrl: string | null;
  /** Of a failed job: 'rejected' (the prompt was refused) or 'unavailable' (the generator failed). */
  failure: string | null;
  /** With 'rejected': the prompt rewritten so that it passes, when the platform has one. */
  suggestion: string | null;
  /** The tier that made the track when the generator returns a whole track (longer than asked: it is cut here); null otherwise. */
  model: string | null;
  /** The longest track that tier makes, in seconds. */
  maxTrackSeconds: number | null;
}

const musicOf = (data: unknown): Music => {
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id || typeof data.state !== 'string') throw new Error('Invalid music response.');
  if (data.state === 'ready' && (typeof data.audioUrl !== 'string' || !isCount(data.chargedCredits))) throw new Error('Invalid music response.');
  const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    id: data.id, state: data.state, seconds: isTime(data.seconds) ? data.seconds : 0, chargedCredits: isCount(data.chargedCredits) ? data.chargedCredits : 0,
    audioUrl: text(data.audioUrl), failure: text(data.failure), suggestion: text(data.suggestion),
    model: text(data.model), maxTrackSeconds: isTime(data.maxTrackSeconds) && data.maxTrackSeconds > 0 ? data.maxTrackSeconds : null,
  };
};

export interface MusicRequest { operationKey: string; prompt: string; seconds: number; instrumental: boolean; maxCredits: number }

/** Asks for a track, charging at most maxCredits. A request that may charge: an unknown outcome throws AmbiguousSubmitError. */
export const startMusic = async (rt: Runtime, o: MusicRequest, hint: string): Promise<Music> =>
  musicOf(await platform(rt, LONG_SECONDS).request('POST', '/music', { body: { ...o }, ambiguous: true, hint }));

/** A music job as it is now; reading it never charges. */
export const readMusic = async (rt: Runtime, id: string): Promise<Music> =>
  musicOf(await platform(rt).request('GET', '/music/' + encodeURIComponent(id)));

// ---------- sound analysis ----------

/** What a listener says of a sound: its music, its ambience, its one-shot effects and the kind of its speech. */
export interface SoundAnalysisResult {
  music: {
    present: boolean; description: string; genre: string; mood: string; tempo: 'slow' | 'medium' | 'fast' | null; bpm: number | null; instruments: string[];
    vocals: 'none' | 'sung' | 'spoken-sample' | 'rap'; energy: string; sections: { from: number; to: number; what: string }[];
  };
  ambience: { present: boolean; description: string };
  effects: { at: number; what: string; kind: string }[];
  speech: { present: boolean; kind: 'none' | 'narration' | 'on-camera-or-dialogue' | 'sung' | 'fragments'; languages: string[] };
  summary: string;
}

export interface SoundAnalysis { id: string; state: string; seconds: number; chargedCredits: number; failure: string | null; result: SoundAnalysisResult | null }

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], otherwise: T): T => (allowed.includes(v as T) ? (v as T) : otherwise);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** The result of an analysis with every field in its place; a field the platform left out is empty, never invented. */
export const soundResultOf = (data: unknown): SoundAnalysisResult | null => {
  if (!isRecord(data)) return null;
  const music = isRecord(data.music) ? data.music : {}, ambience = isRecord(data.ambience) ? data.ambience : {}, speech = isRecord(data.speech) ? data.speech : {};
  return {
    music: {
      present: music.present === true, description: str(music.description), genre: str(music.genre), mood: str(music.mood),
      tempo: oneOf<'slow' | 'medium' | 'fast' | 'none'>(music.tempo, ['slow', 'medium', 'fast'], 'none') === 'none' ? null : (music.tempo as 'slow' | 'medium' | 'fast'),
      bpm: typeof music.bpm === 'number' && music.bpm > 0 ? music.bpm : null, instruments: strings(music.instruments),
      vocals: oneOf(music.vocals, ['none', 'sung', 'spoken-sample', 'rap'] as const, 'none'), energy: str(music.energy),
      sections: (Array.isArray(music.sections) ? music.sections : []).flatMap((s) => (isRecord(s) && isTime(s.from) && isTime(s.to) && s.to > s.from ? [{ from: s.from, to: s.to, what: str(s.what) }] : [])),
    },
    ambience: { present: ambience.present === true, description: str(ambience.description) },
    effects: (Array.isArray(data.effects) ? data.effects : []).flatMap((e) => (isRecord(e) && isTime(e.at) ? [{ at: e.at, what: str(e.what), kind: str(e.kind) }] : [])).sort((a, b) => a.at - b.at),
    speech: { present: speech.present === true, kind: oneOf(speech.kind, ['none', 'narration', 'on-camera-or-dialogue', 'sung', 'fragments'] as const, 'none'), languages: strings(speech.languages) },
    summary: str(data.summary),
  };
};

const soundAnalysisOf = (data: unknown): SoundAnalysis => {
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id || typeof data.state !== 'string') throw new Error('Invalid sound analysis response.');
  const result = soundResultOf(data.result);
  if (data.state === 'ready' && !result) throw new Error('Invalid sound analysis response.');
  return { id: data.id, state: data.state, seconds: isTime(data.seconds) ? data.seconds : 0, chargedCredits: isCount(data.chargedCredits) ? data.chargedCredits : 0, failure: typeof data.failure === 'string' && data.failure ? data.failure : null, result };
};

export const startSoundAnalysis = async (rt: Runtime, o: { operationKey: string; sizeBytes: number; language?: 'en' | 'zh' }): Promise<{ id: string; uploadUrl: string | null; state: string }> => {
  const data = await platform(rt).request('POST', '/sound-analyses', { body: { operationKey: o.operationKey, sizeBytes: o.sizeBytes, ...(o.language ? { language: o.language } : {}) } });
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id) throw new Error('Invalid sound analysis response.');
  return { id: data.id, uploadUrl: typeof data.uploadUrl === 'string' ? data.uploadUrl : null, state: typeof data.state === 'string' ? data.state : '' };
};

/** Credits an analysis of this many seconds of sound costs. Free. */
export const quoteSoundAnalysis = async (rt: Runtime, seconds: number): Promise<number> => {
  const data = await platform(rt).request('POST', '/sound-analyses/quote', { body: { seconds } });
  if (!isRecord(data) || !isCount(data.credits)) throw new Error('Invalid sound analysis quote.');
  return data.credits;
};

/** Runs an uploaded analysis, charging at most maxCredits; it answers when the analysis is done. An unknown outcome throws AmbiguousSubmitError. */
export const runSoundAnalysis = async (rt: Runtime, id: string, maxCredits: number, hint: string): Promise<SoundAnalysis> =>
  soundAnalysisOf(await platform(rt, LONG_SECONDS).request('POST', '/sound-analyses/' + encodeURIComponent(id) + '/run', { body: { maxCredits }, ambiguous: true, hint }));

/** An analysis as it is now; reading it never charges. */
export const readSoundAnalysis = async (rt: Runtime, id: string): Promise<SoundAnalysis> =>
  soundAnalysisOf(await platform(rt).request('GET', '/sound-analyses/' + encodeURIComponent(id)));
