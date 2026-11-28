/**
 * One voice reference per character: a short, clean sample of one speaker (SAMPLE_SECONDS at most), kept once in the
 * project beside the registered voice (assets/voices/<id>.sample.wav, with a record of where it came from). Every
 * clip in which that character speaks gets it as a reference sound, named in the prompt, and the voice-over of the same
 * character is spoken with the same registered voice (voice/profile.ts), so the person sounds alike on camera and off.
 * The sample is cut from the registered reference by default (free); `popost video voice sample` cuts it from another
 * file of the user's, from an approved clip, or has the registered voice speak a neutral line (a paid line of speech,
 * priced and agreed like any other). WAV, one channel: what the video models take as a reference sound.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from '../media/ffmpeg';
import { silencesOf } from '../sound/measure';
import { decodeMono } from '../sound/pcm';
import type { VoiceProfile } from './profile';

/** A voice is recognisable from five seconds of speech; ten is the most a sample needs, and what every model's reference sounds allow. */
export const SAMPLE_SECONDS = { least: 5, most: 10 } as const;
/** The models take reference sounds of two seconds and more. */
export const SAMPLE_FLOOR = 2;
/** The reference sounds of one clip together, in seconds: the smallest total among the models, used when the model's own limit is not known here. */
export const REFERENCE_TOTAL = 15;
const RATE = 24000;

export interface VoiceSample { version: 1; speaker: string; from: 'reference' | 'file' | 'clip' | 'spoken'; source: string; at: number; seconds: number; referenceSha256: string; audioSha256: string }

export const sampleFile = (id: string): string => 'assets/voices/' + id + '.sample.wav';

/** How long each speaker's sample may be when a clip has several: an equal share of the total, SAMPLE_SECONDS.most at most. */
export const sampleSecondsFor = (speakers: number, total = REFERENCE_TOTAL): number => Math.max(SAMPLE_FLOOR, Math.min(SAMPLE_SECONDS.most, Math.floor(total / Math.max(1, speakers))));

/**
 * Where to cut a sample of `want` seconds from a recording: the start of its longest stretch without a silence of
 * half a second (a clean run of speech), or of the whole recording when it is shorter than that.
 */
export const sampleStart = (silences: readonly (readonly [number, number])[], seconds: number, want: number): { at: number; seconds: number } => {
  const long = silences.filter(([a, b]) => b - a >= 0.5);
  const edges = [0, ...long.flatMap(([a, b]) => [a, b]), seconds];
  let best: [number, number] = [0, Math.min(seconds, want)];
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] ?? 0, b = edges[i + 1] ?? seconds;
    if (b - a > best[1] - best[0] && best[1] - best[0] < want) best = [a, b];
  }
  const length = Math.min(want, best[1] - best[0]);
  return { at: Math.round(best[0] * 100) / 100, seconds: Math.round(length * 100) / 100 };
};

/** The sentence that names the reference sounds of a clip's speakers: "host's voice is @audio1; guest's voice is @audio2". */
export const VOICE_NAMED = (speakers: readonly string[], first: number): string =>
  ' ' + speakers.map((s, i) => 'The voice of ' + s + ' is @audio' + (first + i)).join('; ')
  + ': ' + (speakers.length === 1 ? 'it defines' : 'each defines') + ' the voice\'s identity and timbre only. The lines are spoken with ' + (speakers.length === 1 ? 'that voice' : 'those voices') + ', never with the words of the reference recording, and the voice stays the same through every clip.';

const readRecord = (rt: Runtime, file: string): Promise<VoiceSample | undefined> =>
  rt.fs.readText(file + '.json').then((t) => JSON.parse(t) as VoiceSample, () => undefined);

/** Cuts `seconds` from `at` of a file into the project's sample of a speaker and records it. */
export const cutSample = async (rt: Runtime, dir: string, profile: VoiceProfile, o: { file: string; from: VoiceSample['from']; at?: number; seconds?: number }): Promise<VoiceSample> => {
  const out = rt.path.join(dir, sampleFile(profile.id));
  const pcm = await decodeMono(rt, o.file, RATE);
  const total = pcm.length / RATE;
  const cut = o.at !== undefined ? { at: o.at, seconds: Math.min(o.seconds ?? SAMPLE_SECONDS.most, total - o.at) } : sampleStart(silencesOf(pcm, RATE, -45, 0.5), total, o.seconds ?? SAMPLE_SECONDS.most);
  if (!(cut.seconds >= SAMPLE_FLOOR)) throw new Error('A voice sample needs at least ' + SAMPLE_FLOOR + ' s of speech; ' + rt.path.basename(o.file) + ' has ' + Math.max(0, cut.seconds).toFixed(1) + ' s from ' + cut.at.toFixed(1) + ' s. Give a longer recording of the one speaker (' + SAMPLE_SECONDS.least + ' to ' + SAMPLE_SECONDS.most + ' s is best).');
  await rt.fs.mkdir(rt.path.dirname(out));
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-ss', cut.at.toFixed(3), '-i', o.file, '-t', cut.seconds.toFixed(3), '-vn', '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', '-map_metadata', '-1', out]);
  const record: VoiceSample = { version: 1, speaker: profile.id, from: o.from, source: rt.path.basename(o.file), at: cut.at, seconds: cut.seconds, referenceSha256: profile.sha256, audioSha256: sha256(await rt.fs.readFile(out)) };
  await rt.fs.writeFile(out + '.json', JSON.stringify(record, null, 2) + '\n');
  return record;
};

/**
 * The sample of a speaker's registered voice, as a path in the project: the one that is there when it belongs to the
 * registered voice and is no longer than `most`; else a new one cut from the registered reference.
 */
export const voiceSample = async (rt: Runtime, dir: string, profile: VoiceProfile, most: number = SAMPLE_SECONDS.most): Promise<string> => {
  const rel = sampleFile(profile.id), file = rt.path.join(dir, rel);
  const kept = await readRecord(rt, file);
  const same = kept?.referenceSha256 === profile.sha256 && (await rt.fs.readFile(file).then((b) => sha256(b) === kept.audioSha256, () => false));
  const record = same && kept ? kept : await cutSample(rt, dir, profile, { file: rt.path.resolve(dir, profile.reference), from: 'reference' });
  if (record.seconds <= most + 0.05) return rel;
  // A clip of several speakers has less room for each: the same sample, cut shorter, beside it.
  const shorter = rel.replace(/\.wav$/, '.' + most + 's.wav');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', file, '-t', String(most), '-c:a', 'pcm_s16le', '-map_metadata', '-1', rt.path.join(dir, shorter)]);
  return shorter;
};
