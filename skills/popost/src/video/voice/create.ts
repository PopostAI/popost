/**
 * A personal voice on the connected popost.ai account, made from a recording of one person: the sound of an audio or a
 * video file becomes a sample (one channel, 16-bit PCM WAV at 24 kHz, 10 to 60 s, at most 10 MB, the rules the
 * platform checks again), which is uploaded once. The voice then appears in `voice list` beside the official ones and
 * is used like them (`voice use`, `voice quote`, `voice speak`, `popost:<id>`). Making a voice needs the user's
 * statement that they own the voice or have the speaker's permission: there is no voice without it.
 */
import { sha256 } from '../../core/util';
import { PopostApiError } from '../../providers/errors';
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { finishVoice, operationKeyOf, startVoice, uploadWav } from '../hosted-api';
import { runFfmpeg } from '../media/ffmpeg';
import { isMono16, readWav } from '../media/wav';
import { lastLines } from '../tool';
import { hostedVoicePage } from './hosted';

export const SAMPLE = { minSeconds: 10, maxSeconds: 60, maxBytes: 10 * 1024 * 1024, rate: 24000 } as const;
export const CONSENT = 'the user owns this voice or has the speaker\'s permission to make a voice of it';

export interface VoiceSample { bytes: Uint8Array; seconds: number; start: number; trimmed: boolean }

const round = (s: number): number => Math.round(s * 100) / 100;

/** The sample of a recording: its first sound track from `start`, at most SAMPLE.maxSeconds, as mono 16-bit PCM WAV. */
export const voiceSample = async (rt: Runtime, file: string, start = 0): Promise<VoiceSample> =>
  withTempDir(rt, 'popost-voice-sample-', async (dir) => {
    const out = rt.path.join(dir, 'sample.wav');
    // No metadata and no encoder tag: the WAV is a plain 44-byte header and the sound.
    const r = await runFfmpeg(rt, [
      '-y', '-loglevel', 'error', ...(start > 0 ? ['-ss', String(start)] : []), '-i', file, '-map', '0:a:0', '-vn', '-t', String(SAMPLE.maxSeconds),
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-ac', '1', '-ar', String(SAMPLE.rate), '-c:a', 'pcm_s16le', out,
    ]);
    if (r.code !== 0)
      throw new Error(/matches no streams|does not contain any stream/i.test(r.stderr) ? 'There is no sound in ' + file + '.' : 'ffmpeg could not read the sound of ' + file + ': ' + lastLines(r.stderr, 2));
    const bytes = await rt.fs.readFile(out);
    const wav = readWav(bytes);
    if (!isMono16(wav) || wav.sampleRate !== SAMPLE.rate) throw new Error('ffmpeg did not write a mono 16-bit PCM WAV.');
    if (wav.seconds < SAMPLE.minSeconds)
      throw new Error('The recording has ' + round(wav.seconds) + ' s of sound' + (start > 0 ? ' from ' + start + ' s' : '') + '; a voice needs ' + SAMPLE.minSeconds + ' to ' + SAMPLE.maxSeconds + ' s of one person speaking clearly. Give a longer recording' + (start > 0 ? ' or an earlier --start' : '') + '.');
    if (bytes.length > SAMPLE.maxBytes) throw new Error('The sample is ' + bytes.length + ' bytes; at most ' + SAMPLE.maxBytes + ' are accepted.');
    return { bytes, seconds: round(wav.seconds), start, trimmed: wav.seconds >= SAMPLE.maxSeconds - 0.05 };
  });

export interface NewVoiceOptions {
  file: string;
  name: string;
  language?: 'zh' | 'en';
  description?: string;
  /** Seconds into the recording where the sample starts. */
  start?: number;
  /** The user's statement: CONSENT. */
  consent: boolean;
}

/** What the platform is asked for, checked before anything is read or sent. */
export const checkNewVoice = (o: NewVoiceOptions): { name: string; description?: string } => {
  if (!o.consent) throw new Error('Making a voice needs --consent: it states that ' + CONSENT + '. Ask the user; without that statement no voice is made.');
  const name = o.name.trim(), description = o.description?.trim();
  if (!name || [...name].length > 100) throw new Error('--name is 1 to 100 characters.');
  if (description && [...description].length > 500) throw new Error('--description is at most 500 characters.');
  if (o.language !== undefined && o.language !== 'zh' && o.language !== 'en') throw new Error('--language is zh or en.');
  if (o.start !== undefined && !(Number.isFinite(o.start) && o.start >= 0)) throw new Error('--start is a number of seconds, 0 or more.');
  return { name, ...(description ? { description } : {}) };
};

/** The account's own voice with this id, from every page of the catalog; undefined when it is not there. */
const ownVoice = async (rt: Runtime, id: string): Promise<Record<string, unknown> | undefined> => {
  for (let page = 1; ; page += 1) {
    const result = await hostedVoicePage(rt, 'mine', page);
    const match = result.items.find((v) => v.id === id);
    if (match) return match as unknown as Record<string, unknown>;
    if (!result.items.length || page * 100 >= result.total) return undefined;
  }
};

/**
 * Makes the voice: the sample, then create, upload and complete. The operation key comes from the sample and what the
 * voice is called, so running the same command again after a failure continues the same voice; when the platform says
 * that voice is already made, it is read from the catalog. Returns the voice as the catalog lists it.
 */
export const createHostedVoice = async (rt: Runtime, o: NewVoiceOptions): Promise<{ voice: Record<string, unknown>; sample: Omit<VoiceSample, 'bytes'> & { bytes: number }; again: boolean }> => {
  const { name, description } = checkNewVoice(o);
  const sample = await voiceSample(rt, o.file, o.start ?? 0);
  const operationKey = operationKeyOf({ voice: sha256(sample.bytes), name, language: o.language ?? '', description: description ?? '' });
  const started = await startVoice(rt, { operationKey, name, ...(o.language ? { language: o.language } : {}), ...(description ? { description } : {}), sizeBytes: sample.bytes.length });
  const made = started.uploadUrl === null ? await ownVoice(rt, started.id) : undefined;
  if (started.uploadUrl !== null) await uploadWav(rt, started.uploadUrl, sample.bytes, 'the voice sample');
  const voice = made ?? (await finishVoice(rt, started.id).catch((e: unknown) => {
    // The platform checked the sample and refused it: another recording makes another sample (and another key).
    if (!(e instanceof PopostApiError) || e.code !== 'INVALID_REQUEST') throw e;
    throw new PopostApiError('popost.ai could not use this recording as a voice sample (' + e.message + '). Give another recording: 10 to 60 s of one person speaking clearly, alone and without music.', { code: e.code, ...(e.status ? { status: e.status } : {}), details: e.details });
  }));
  return { voice, sample: { seconds: sample.seconds, start: sample.start, trimmed: sample.trimmed, bytes: sample.bytes.length }, again: started.uploadUrl === null };
};
