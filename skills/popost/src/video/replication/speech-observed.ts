/** Actual native speech observations are independent of a generator's requested line slots. */
import { z } from 'zod';
import type { Runtime } from '../../runtime';
import { sha256File } from '../../core/util';
import type { Problem } from '../types';
import { probe } from '../media/ffmpeg';
import { error } from '../project/check-common';
import { isOutside } from '../project/check';
import { evidenceSchema, type ReplicationEvidence } from './contract';
import { evidenceProblems } from './io';
import { joinSpans } from '../timeline/mix';

export const OBSERVED_SPEECH = '.speech-observed.json';
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const wordSchema = z.object({ text: z.string(), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), confidence: z.number().optional() });
const transcriptSchema = z.object({ fps: z.number().finite().positive(), language: z.string().optional(), words: z.array(wordSchema).min(1) });
export const speechObservationReviewSchema = z.strictObject({
  words: z.enum(['passed', 'failed', 'unknown']), articulation: z.enum(['passed', 'failed', 'unknown']),
  evidence: z.array(evidenceSchema), note: z.string().optional(),
});
export type SpeechObservationReview = z.infer<typeof speechObservationReviewSchema>;
const fileSchema = z.strictObject({ file: z.string().min(1), sha256: hash, media: z.literal('data') });
const observedSchema = z.strictObject({
  format: z.literal('popost-native-speech-observation'), version: z.literal(1), videoSha256: hash,
  source: z.strictObject({ fps: z.number().finite().positive(), frames: z.number().int().positive() }),
  transcript: fileSchema.extend({ fps: z.number().finite().positive() }),
  spansSeconds: z.array(z.tuple([z.number().finite().nonnegative(), z.number().finite().positive()])).min(1),
  review: speechObservationReviewSchema.optional(), reviewSource: fileSchema.optional(),
});
export type NativeSpeechObservation = z.infer<typeof observedSchema>;
type Clock = { fps: number; frames: number };
const fix = 'Transcribe this actual native clip, import its ASR with video replication observe, and inspect its audible words and visible articulation. Keep the original requested speech receipt unchanged.';
const failure = (file: string, message: string): Problem => error(file + OBSERVED_SPEECH, message, fix);
const insideMedia = async (rt: Runtime, dir: string, media: string): Promise<void> => {
  if (isOutside(rt.path.relative(dir, media))) throw new Error('The native media must stay inside the project.');
  if (rt.fs.realpath && isOutside(rt.path.relative(await rt.fs.realpath(dir), await rt.fs.realpath(media))))
    throw new Error('The native media resolves outside the project. Copy its real bytes inside.');
};

/** ASR frames belong to the ASR clock, which can differ from the video's native FPS. */
export const observedSeconds = (raw: unknown, seconds: number): { fps: number; spans: [number, number][] } => {
  const t = transcriptSchema.parse(raw), spans: [number, number][] = [];
  let previous = -1;
  for (const w of t.words) {
    if (!w.text.trim()) continue;
    if (w.end <= w.start || w.start < previous || w.start / t.fps >= seconds || w.end / t.fps > seconds + 1 / t.fps + 0.001)
      throw new Error('Actual ASR words must be ordered and lie within the media duration on their own FPS clock.');
    spans.push([w.start / t.fps, Math.min(seconds, w.end / t.fps)]);
    previous = w.start;
  }
  if (!spans.length) throw new Error('No actual spoken words were observed. Do not turn a silent clip into requested speech.');
  return { fps: t.fps, spans: joinSpans(spans) };
};

const reviewProblems = (file: string, o: NativeSpeechObservation, audioSha256?: string): Problem[] => {
  const r = o.review, out: Problem[] = [];
  if (!r || r.words !== 'passed' || r.articulation !== 'passed')
    return [failure(file, 'Native speech timing was observed, but the actual words and visible articulation have not both passed review.')];
  const actual = r.evidence.filter(e => e.kind === 'observed' && e.file && e.sha256);
  if (!actual.some(e => e.at && o.spansSeconds.some(s => Math.min(s[1], e.at![1]) > Math.max(s[0], e.at![0])) && ((e.media === 'video' && e.sha256 === o.videoSha256) || (e.media === 'audio' && e.sha256 === audioSha256))))
    out.push(failure(file, 'The words review needs an audible interval of this exact native video or its locked audio, not a text-only verdict.'));
  const frames = actual.filter(e => e.media === 'video' && e.sha256 === o.videoSha256 && e.frame !== undefined);
  if (new Set(frames.map(e => e.frame)).size < 2)
    out.push(failure(file, 'The articulation review needs at least two distinct inspected frames of this exact native video. ASR is not a lip-sync measurement.'));
  if (frames.some(e => !o.spansSeconds.some(s => e.frame! / o.source.fps >= s[0] - 1 / o.source.fps && e.frame! / o.source.fps < s[1] + 1 / o.source.fps)))
    out.push(failure(file, 'An articulation sample is outside the actually observed speech; inspect the mouth while it speaks, not only a silent hero frame.'));
  if (actual.some(e => e.sha256 === o.videoSha256 && ((e.frame !== undefined && e.frame >= o.source.frames) || (e.at && e.at[1] > o.source.frames / o.source.fps))))
    out.push(failure(file, 'A native speech review points outside the actual media clock.'));
  return out;
};

/** Missing observations can render a first draft; a strict final check calls this with required:true. */
export const readObservedSpeech = async (rt: Runtime, dir: string, file: string, options: { required?: boolean; final?: boolean; clock?: Clock } = {}): Promise<{ observation?: NativeSpeechObservation; spans?: [number, number][]; problems: Problem[] }> => {
  const full = rt.path.resolve(dir, file), sidecar = full + OBSERVED_SPEECH;
  if (!await rt.fs.stat(sidecar)) return { problems: options.required ? [failure(file, 'Actual native speech timing has not been observed; requested line slots are not evidence of when the model spoke.')] : [] };
  try {
    await insideMedia(rt, dir, full);
    const o = observedSchema.parse(JSON.parse(await rt.fs.readText(sidecar)));
    const problems = await evidenceProblems(rt, dir, o);
    if (await sha256File(rt, full) !== o.videoSha256) throw new Error('The native media changed after the speech observation.');
    const clock = options.clock ?? (options.final ? await probe(rt, full) : undefined);
    if (clock && (clock.frames !== o.source.frames || Math.abs(clock.fps - o.source.fps) > .005)) throw new Error('The actual native media clock differs from the observation.');
    const raw: unknown = JSON.parse(await rt.fs.readText(rt.path.resolve(dir, o.transcript.file)));
    const measured = observedSeconds(raw, o.source.frames / o.source.fps);
    if (measured.fps !== o.transcript.fps || JSON.stringify(measured.spans) !== JSON.stringify(o.spansSeconds)) throw new Error('Observed spans differ from the bound actual ASR clock/words. Re-import the actual observation.');
    const receipt = await rt.fs.readText(full + '.speech.json').then(t => JSON.parse(t) as { videoSha256?: string; audioSha256?: string }, () => undefined);
    if (receipt?.videoSha256 && receipt.videoSha256 !== o.videoSha256) throw new Error('The original speech receipt belongs to a different media file.');
    if (o.reviewSource) {
      const original: unknown = JSON.parse(await rt.fs.readText(rt.path.resolve(dir, o.reviewSource.file)));
      const checked = speechObservationReviewSchema.parse(original);
      // Evidence paths may be rewritten by portable copying; hashes and observations retain their meaning.
      const portable = (v: unknown): unknown => Array.isArray(v) ? v.map(portable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'file').map(([k, value]) => [k, portable(value)])) : v;
      if (JSON.stringify(portable(checked)) !== JSON.stringify(portable(o.review))) throw new Error('The observation review differs from its bound review file.');
    }
    if (options.final) problems.push(...reviewProblems(file, o, receipt?.audioSha256));
    if (problems.some(p => p.level === 'error')) return { problems };
    return { observation: o, spans: o.spansSeconds, problems };
  } catch (e) { return { problems: [failure(file, e instanceof Error ? e.message : String(e))] }; }
};

const copyEvidence = async (rt: Runtime, from: string, to: string, e: { file: string; sha256: string }, mediaFile?: string): Promise<void> => {
  if (e.file === mediaFile) return;
  const ext = rt.path.extname(e.file).replace(/[^.a-z0-9]/gi, '') || '.bin';
  const target = 'replication-speech-evidence/' + e.sha256 + ext;
  await rt.fs.writeFile(rt.path.join(to, target), await rt.fs.readFile(rt.path.resolve(from, e.file)));
  e.file = target;
};

/** Portable --assets fills preserve the actual ASR/review evidence, not just a requested receipt. */
export const copyObservedSpeech = async (rt: Runtime, from: string, to: string, file: string): Promise<void> => {
  const read = await readObservedSpeech(rt, from, file);
  if (read.problems.length) throw new Error(read.problems.map(p => p.message).join(' '));
  if (!read.observation) return;
  const o = structuredClone(read.observation);
  await copyEvidence(rt, from, to, o.transcript);
  if (o.reviewSource) await copyEvidence(rt, from, to, o.reviewSource);
  for (const e of o.review?.evidence ?? []) if (e.file && e.sha256) await copyEvidence(rt, from, to, e as ReplicationEvidence & { file: string; sha256: string }, file);
  await rt.fs.writeFile(rt.path.join(to, file) + OBSERVED_SPEECH, JSON.stringify(o, null, 2) + '\n');
};

/** Import real ASR and optional human review without changing the native clip or its requested receipt. */
export const observeNativeSpeech = async (rt: Runtime, options: { dir: string; media: string; transcript: string; review?: string }): Promise<NativeSpeechObservation> => {
  const dir = rt.path.resolve(options.dir), media = rt.path.resolve(options.media), file = rt.path.relative(dir, media);
  await insideMedia(rt, dir, media);
  const p = await probe(rt, media);
  if (!p.hasAudio) throw new Error('The actual native clip has no audio stream.');
  const videoSha256 = await sha256File(rt, media), raw: unknown = JSON.parse(await rt.fs.readText(options.transcript));
  const receipt = await rt.fs.readText(media + '.speech.json').then(t => JSON.parse(t) as { videoSha256?: string }, () => undefined);
  if (receipt?.videoSha256 && receipt.videoSha256 !== videoSha256) throw new Error('Keep the original receipt and reconcile the changed native file before importing an observation.');
  const measured = observedSeconds(raw, p.frames / p.fps);
  const original: NativeSpeechObservation = {
    format: 'popost-native-speech-observation', version: 1, videoSha256,
    source: { fps: p.fps, frames: p.frames },
    transcript: { file: rt.path.relative(dir, options.transcript), sha256: await sha256File(rt, options.transcript), media: 'data', fps: measured.fps }, spansSeconds: measured.spans,
  };
  // A real external ASR file is copied in before its portable evidence record is persisted.
  await copyEvidence(rt, dir, dir, original.transcript);
  if (options.review) {
    original.review = speechObservationReviewSchema.parse(JSON.parse(await rt.fs.readText(options.review)));
    original.reviewSource = { file: rt.path.relative(dir, options.review), sha256: await sha256File(rt, options.review), media: 'data' };
    await copyEvidence(rt, dir, dir, original.reviewSource);
    const problems = await evidenceProblems(rt, dir, original.review);
    if (problems.length) throw new Error(problems.map(p => p.message).join(' '));
  }
  const sidecar = media + OBSERVED_SPEECH;
  const previous = await rt.fs.readFile(sidecar).catch(() => undefined);
  await rt.fs.writeFile(sidecar, JSON.stringify(original, null, 2) + '\n');
  const checked = await readObservedSpeech(rt, dir, file, { clock: p });
  if (checked.problems.length) {
    if (previous) await rt.fs.writeFile(sidecar, previous); else await rt.fs.rm(sidecar);
    throw new Error(checked.problems.map(p => p.message).join(' '));
  }
  return original;
};
