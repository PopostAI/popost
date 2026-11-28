/**
 * The reading of a reference's sound with its files at hand: the measurement by ffmpeg (free), and the listener, which
 * is the sound analysis of a connected popost.ai account, paid in credits as transcription is: priced first (free),
 * run only within --confirm --max-credits N (wallet.ts), under an operation key made from the sound, so the same sound
 * is never paid for twice. It degrades cleanly: without an account, on a server that does not offer it (404), for a
 * sound longer than it takes, or when it fails, the measurement stands and the record says why nobody listened.
 */
import { sha256 } from '../../core/util';
import { AmbiguousSubmitError, PopostApiError } from '../../providers/errors';
import { sleep } from '../../providers/time';
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { connected, operationKeyOf, quoteSoundAnalysis, readSoundAnalysis, runSoundAnalysis, startSoundAnalysis, uploadWav, type SoundAnalysis } from '../hosted-api';
import { plainWav, readWav, speechWav } from '../media/wav';
import { ToolError } from '../tool';
import type { PriceItem, Wallet } from '../wallet';
import { measureSound, type SoundMeasure } from './measure';
import { decodeMono, integratedLoudness } from './pcm';
import { isSoundFile, type SoundAnalysisRecord, type SoundFile } from './reading';

/** What the platform analyses: a 16 kHz, one-channel, 16-bit WAV of at most ten minutes and 20 MB. */
export const MAX_ANALYSIS_SECONDS = 600;
export const MAX_ANALYSIS_BYTES = 20 * 1024 * 1024;
const POLL_MS = 3000;
const WAIT_LIMIT_MS = 5 * 60_000;

/** The sound of a video as the listener hears it (16 kHz, one channel), with its hash and length. */
export interface HeardSound { bytes: Uint8Array; sha256: string; seconds: number }

export const heardSound = (rt: Runtime, video: string): Promise<HeardSound> =>
  withTempDir(rt, 'popost-video-sound-', async (dir) => {
    const file = rt.path.join(dir, 'audio.wav');
    await speechWav(rt, video, file);
    const wav = readWav(await rt.fs.readFile(file));
    const bytes = plainWav(wav);
    return { bytes, sha256: sha256(bytes), seconds: Math.round(wav.seconds * 1000) / 1000 };
  });

/** The measurement of a file's sound; cuts and motion: the picture's events in seconds. */
export const measureFile = async (rt: Runtime, file: string, picture: { cuts?: readonly number[]; motion?: readonly number[] } = {}): Promise<SoundMeasure> => {
  const pcm = await decodeMono(rt, file);
  const loudness = await integratedLoudness(rt, file).catch(() => undefined);
  const m = measureSound(pcm, 22050, picture);
  return loudness === undefined ? m : { ...m, loudness };
};

const missing = (e: unknown): boolean => e instanceof PopostApiError && (e.status === 404 || e.code === 'NOT_FOUND');
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'failed';

/**
 * What the listener will do for this sound, decided before anything is paid: kept (an earlier reading of the same
 * sound, in the sound.json that is there), to run (with its price), or not at all (with the reason).
 */
export type AnalysisPlan =
  | { kind: 'kept'; record: SoundAnalysisRecord }
  | { kind: 'run'; credits: number; item: PriceItem }
  | { kind: 'none'; record: SoundAnalysisRecord };

export const planAnalysis = async (rt: Runtime, sound: HeardSound | undefined, o: { skip?: boolean; before?: unknown; what?: string } = {}): Promise<AnalysisPlan> => {
  if (!sound) return { kind: 'none', record: { status: 'silent' } };
  const before = isSoundFile(o.before) ? (o.before as SoundFile) : undefined;
  if (before?.audioSha256 === sound.sha256 && before.analysis.status === 'done' && before.analysis.result) return { kind: 'kept', record: { ...before.analysis, chargedCredits: 0 } };
  if (o.skip) return { kind: 'none', record: { status: 'skipped' } };
  if (!connected(rt)) return { kind: 'none', record: { status: 'no-account' } };
  if (sound.seconds > MAX_ANALYSIS_SECONDS || sound.bytes.length > MAX_ANALYSIS_BYTES) return { kind: 'none', record: { status: 'too-long', why: (sound.seconds / 60).toFixed(1) + ' min; at most ' + MAX_ANALYSIS_SECONDS / 60 + ' min are analysed' } };
  try {
    const credits = await quoteSoundAnalysis(rt, sound.seconds);
    return { kind: 'run', credits, item: { kind: 'sound-analysis', what: o.what ?? 'the sound of the reference (music, ambience, effects)', credits, seconds: sound.seconds } };
  } catch (e) {
    // A server from before the sound analysis answers 404: the reading goes on without a listener.
    if (missing(e)) return { kind: 'none', record: { status: 'unavailable' } };
    if (e instanceof PopostApiError) return { kind: 'none', record: { status: 'failed', why: 'its price could not be read: ' + firstLine(e) } };
    throw e;
  }
};

const untilDone = async (rt: Runtime, job: SoundAnalysis): Promise<SoundAnalysis> => {
  const started = rt.now().getTime();
  let last = job;
  while (last.state === 'running' || last.state === 'created') {
    if (rt.now().getTime() - started >= WAIT_LIMIT_MS) throw new ToolError('The popost.ai sound analysis is still running after 5 min; run the same command again later: it reads the same job, without a new charge.');
    await sleep(rt, POLL_MS);
    last = await readSoundAnalysis(rt, job.id);
  }
  return last;
};

/**
 * Runs the analysis of a sound within `wallet`. A job of the same sound made before is read back or waited for (not
 * charged again); a failed one is followed by a new job under the key after it. A failure of the listener is a record
 * ('failed', with the reason), never the end of the reading: only a refused price stops the command, before anything
 * is charged (the caller's walletFor).
 */
export const runAnalysis = async (rt: Runtime, sound: HeardSound, wallet: Wallet, language?: 'en' | 'zh'): Promise<SoundAnalysisRecord> => {
  const start = (operationKey: string) => startSoundAnalysis(rt, { operationKey, sizeBytes: sound.bytes.length, ...(language ? { language } : {}) });
  try {
    let job = await start(operationKeyOf({ soundAnalysis: sound.sha256, language: language ?? '' }));
    if (job.state === 'failed') job = await start(operationKeyOf({ soundAnalysis: sound.sha256, language: language ?? '', after: job.id }));
    let done: SoundAnalysis, charged = 0;
    if (job.state === 'ready') done = await readSoundAnalysis(rt, job.id);
    else if (job.state === 'running') done = await untilDone(rt, { id: job.id, state: 'running', seconds: sound.seconds, chargedCredits: 0, failure: null, result: null });
    else {
      wallet.check(await quoteSoundAnalysis(rt, sound.seconds), 'Analysing ' + sound.seconds.toFixed(1) + ' s of sound with popost.ai');
      if (job.uploadUrl) await uploadWav(rt, job.uploadUrl, sound.bytes, 'the sound to analyse');
      done = await untilDone(rt, await runSoundAnalysis(rt, job.id, wallet.left, 'Run the same command again: the same sound reuses the same analysis job.'));
      charged = done.state === 'ready' ? done.chargedCredits : 0;
      wallet.pay(charged);
    }
    if (done.state !== 'ready' || !done.result) return { status: 'failed', id: done.id, chargedCredits: 0, why: done.failure ?? 'the analysis ended ' + (done.state || 'without a result') };
    return { status: 'done', id: done.id, chargedCredits: charged, result: done.result };
  } catch (e) {
    if (missing(e)) return { status: 'unavailable' };
    if (e instanceof AmbiguousSubmitError || e instanceof ToolError || e instanceof PopostApiError) return { status: 'failed', why: firstLine(e) };
    throw e;
  }
};
