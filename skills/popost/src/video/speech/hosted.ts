/**
 * Transcription by popost.ai, for a connected account without a transcriber of its own (POPOST_ASR_CMD keeps priority).
 * It costs credits, so it is used only within a budget the user confirmed: POPOST_ASR_MAX_CREDITS, the most one command
 * may spend on transcription, counted down call by call; without it there is no hosted transcriber. Pricing is free:
 * `popost video transcript <video> --quote`.
 *
 * A call takes the 16 kHz WAV the engine made (at most 30 min and 64 MiB, as the platform takes it), prices its
 * length, and refuses when the rest of the budget does not cover it; then the platform makes a job (its operation key
 * comes from the sound and the language, so a retry reuses the job: a running one is waited for and a finished one read
 * back, neither charged again), the WAV is uploaded and the job is run. A run that takes long answers `running`: the
 * job is then read every 3 s, for at most 30 min, with a line on stderr every 30 s. Reading a job is free.
 */
import { sha256 } from '../../core/util';
import { sleep } from '../../providers/time';
import { AmbiguousSubmitError, PopostApiError } from '../../providers/errors';
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { operationKeyOf, platform, quoteTranscription, readTranscription, runTranscription, startTranscription, uploadWav, type Transcription, type WordTime } from '../hosted-api';
import { probe } from '../media/ffmpeg';
import { isMono16, plainWav, readWav, speechWav } from '../media/wav';
import { ToolError } from '../tool';
import type { RawTranscript, Transcriber } from './types';

export const ASR_BUDGET = 'POPOST_ASR_MAX_CREDITS';
const QUOTE_HINT = 'popost video transcript <video> --quote';

/** The confirmed budget: a whole number of credits, or undefined when it is unset; NaN when it is set to something else. */
const budgetOf = (rt: Runtime): number | undefined => {
  const raw = rt.env[ASR_BUDGET]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
};

const connected = (rt: Runtime): boolean => {
  try {
    return platform(rt).hasKey();
  } catch {
    return false; // a POPOST_BASE_URL that is not an address: no account to use
  }
};

/** Why there is no hosted transcriber (connected: an account is, but the budget is missing or wrong), or undefined when there is one. */
export const hostedTranscriptionAbsence = (rt: Runtime): { connected: boolean; why: string } | undefined => {
  if (!connected(rt)) return { connected: false, why: 'no popost.ai account is connected' };
  const budget = budgetOf(rt);
  if (budget === undefined) return { connected: true, why: 'no ' + ASR_BUDGET + ' budget is set for popost.ai transcription (' + QUOTE_HINT + ' prices it)' };
  if (Number.isNaN(budget)) return { connected: true, why: ASR_BUDGET + ' is not a whole number of credits' };
  return undefined;
};

const CJK_START = /^[\u{3040}-\u{30ff}\u{3400}-\u{9fff}\u{ac00}-\u{d7af}]/u;
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

/**
 * The platform's words as a recogniser gives them (speech/types.ts): a word that does not start with a CJK character
 * starts with a space, which marks a new word (toFrames joins Latin pieces without one); punctuation on its own joins
 * the word before it; a word without a confidence has 1.
 */
export const rawTranscriptOf = (language: string, words: readonly WordTime[]): RawTranscript => {
  const out: RawTranscript['words'] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && PUNCTUATION_ONLY.test(text)) {
      out[out.length - 1] = { ...prev, text: prev.text + text };
      continue;
    }
    out.push({ text: CJK_START.test(text) ? text : ' ' + text, start: w.start, end: w.end, confidence: w.confidence ?? 1 });
  }
  return { language, words: out };
};

/** Seconds of sound as they are priced: to a thousandth. */
const pricedSeconds = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** What the platform transcribes: at most this long and this large. */
export const MAX_SECONDS = 30 * 60;
export const MAX_BYTES = 64 * 1024 * 1024;

const POLL_MS = 3000;
const WAIT_LIMIT_MS = 30 * 60_000;
const PROGRESS_MS = 30_000;
/** A rate-limited read waits as long as the platform asks (else RATE_WAIT_MS), never more than RATE_WAIT_MAX_MS. */
const RATE_WAIT_MS = 10_000, RATE_WAIT_MAX_MS = 60_000;
/** Reads in a row that may fail for a reason that passes by itself (no answer, a gateway page) before the wait gives up. */
const READ_FAILURES = 5;
const PASSING = new Set(['NETWORK', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'BAD_RESPONSE']);

/** How long to wait before the next read after a failed one, or undefined when the failure is final. */
const waitAfter = (e: unknown, failures: number): number | undefined => {
  if (!(e instanceof PopostApiError)) return undefined;
  if (e.code === 'RATE_LIMITED') {
    const asked = Number(e.details.retryAfterSeconds);
    return Math.min(RATE_WAIT_MAX_MS, Number.isFinite(asked) && asked > 0 ? asked * 1000 : RATE_WAIT_MS);
  }
  // A failed job (UPSTREAM_ERROR) or any other refusal is final.
  return PASSING.has(e.code ?? '') && failures <= READ_FAILURES ? POLL_MS : undefined;
};

/** Reads a running job every 3 s until it is ready or failed, for at most 30 min; a line on stderr every 30 s. */
const untilDone = async (rt: Runtime, job: Transcription, seconds: number): Promise<Transcription> => {
  const started = rt.now().getTime();
  let last = job, said = started, failures = 0, pause = POLL_MS;
  while (last.state === 'running') {
    const now = rt.now().getTime();
    if (now - started >= WAIT_LIMIT_MS)
      throw new ToolError('The popost.ai transcription is still running after 30 min; run the same command again later: it waits for the same job, without a new charge.');
    if (now - said >= PROGRESS_MS) {
      rt.stderr('popost.ai is transcribing ' + seconds.toFixed(1) + ' s of sound (' + Math.round((now - started) / 1000) + ' s so far)\n');
      said = now;
    }
    await sleep(rt, pause);
    try {
      last = await readTranscription(rt, job.id);
      failures = 0;
      pause = POLL_MS;
    } catch (e) {
      // A rate limit is the platform saying when to come back, not a failed read.
      if (!(e instanceof PopostApiError && e.code === 'RATE_LIMITED')) failures += 1;
      const wait = waitAfter(e, failures);
      if (wait === undefined) throw e;
      pause = wait;
    }
  }
  return last;
};

/**
 * The job of this sound, finished: a job made before is waited for or read back (not charged again); a new one is
 * uploaded and run within `remaining`. charged: the credits of a job run by this call.
 */
const sendAndRun = async (rt: Runtime, bytes: Uint8Array, language: string | undefined, remaining: number, seconds: number): Promise<{ result: Transcription; charged: number }> => {
  const operationKey = operationKeyOf({ transcription: sha256(bytes), language: language ?? '' });
  const job = await startTranscription(rt, { operationKey, sizeBytes: bytes.length, ...(language ? { language } : {}) });
  const earlier = { id: job.id, state: job.state, language: '', seconds, chargedCredits: 0, words: [] };
  if (job.state === 'ready') return { result: await readTranscription(rt, job.id), charged: 0 };
  if (job.state === 'running' || job.state === 'failed') return { result: await untilDone(rt, earlier, seconds), charged: 0 };
  if (job.uploadUrl) await uploadWav(rt, job.uploadUrl, bytes, 'the sound to transcribe');
  const hint = 'Run the same command again: the same sound reuses the same transcription job.';
  try {
    const result = await untilDone(rt, await runTranscription(rt, job.id, remaining, hint), seconds);
    return { result, charged: result.chargedCredits };
  } catch (e) {
    if (e instanceof AmbiguousSubmitError) throw new ToolError(e.message);
    throw e;
  }
};

/** The popost.ai transcriber, or undefined unless an account is connected and POPOST_ASR_MAX_CREDITS is a valid budget. */
export const hostedTranscriber = (rt: Runtime): Transcriber | undefined => {
  if (hostedTranscriptionAbsence(rt) !== undefined) return undefined;
  let remaining = budgetOf(rt) ?? 0;
  const transcribe = async (file: string, language?: string): Promise<RawTranscript> => {
    const wav = readWav(await rt.fs.readFile(file));
    if (!isMono16(wav) || wav.sampleRate !== 16000) throw new ToolError('popost.ai transcribes 16 kHz, one-channel, 16-bit PCM WAV; ' + file + ' is not one.');
    const bytes = plainWav(wav);
    if (wav.seconds > MAX_SECONDS || bytes.length > MAX_BYTES)
      throw new ToolError('popost.ai transcribes at most 30 min of sound; this is ' + (wav.seconds / 60).toFixed(1) + ' min. Use a transcriber of your own (POPOST_ASR_CMD) for it.');
    const seconds = pricedSeconds(wav.seconds);
    const credits = await quoteTranscription(rt, seconds);
    if (credits > remaining)
      throw new ToolError('Transcribing ' + seconds.toFixed(1) + ' s of sound costs ' + credits + ' credits; ' + remaining + ' of the confirmed ' + ASR_BUDGET + ' budget are left. Price it with ' + QUOTE_HINT + ' and, with the user\'s agreement, set a budget that covers it.');
    const { result, charged } = await sendAndRun(rt, bytes, language, remaining, seconds);
    if (result.state === 'failed') throw new ToolError('The popost.ai transcription failed; run the same command again to start a new one.');
    if (result.state !== 'ready') throw new ToolError('The popost.ai transcription is ' + (result.state || 'not ready') + '; run the same command again.');
    remaining = Math.max(0, remaining - charged);
    return rawTranscriptOf(result.language || language || '', result.words);
  };
  return {
    // Refusals of the platform keep their code (PopostApiError); anything else is the transcriber's failure, as a tool's.
    transcribe: (file, language) => transcribe(file, language).catch((e: unknown) => {
      if (e instanceof ToolError || e instanceof PopostApiError) throw e;
      throw new ToolError('popost.ai could not transcribe the sound: ' + (e instanceof Error ? e.message : String(e)));
    }),
  };
};

/** What transcribing a video's sound with popost.ai would cost: its length as the engine sends it, priced for free. */
export const quoteVideoSpeech = async (rt: Runtime, video: string): Promise<{ sound: boolean; seconds: number; credits: number }> => {
  const info = await probe(rt, video);
  if (!info.hasAudio) return { sound: false, seconds: 0, credits: 0 };
  return withTempDir(rt, 'popost-video-audio-', async (dir) => {
    const file = rt.path.join(dir, 'audio.wav');
    await speechWav(rt, video, file);
    const seconds = pricedSeconds(readWav(await rt.fs.readFile(file)).seconds);
    return { sound: true, seconds, credits: await quoteTranscription(rt, seconds) };
  });
};
