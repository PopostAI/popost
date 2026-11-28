/**
 * A file's sound as samples, by ffmpeg: one channel of 32-bit floats for the measurements (sound/measure.ts), the
 * integrated loudness ffmpeg's EBU R 128 meter reads, and PCM written as a WAV file (tests and cut effects).
 */
import type { Runtime } from '../../runtime';
import { runFfmpeg, runFfmpegOk } from '../media/ffmpeg';
import { ANALYSIS_RATE } from './measure';

/** The longest sound measured: a reference longer than this is read to here (20 min is 106 MB of samples). */
export const MAX_MEASURED_SECONDS = 20 * 60;

/** One channel of a file's sound (a video's first audio stream, or a sound file) at `rate`, samples in -1..1; from/length in seconds. */
export const decodeMono = async (rt: Runtime, file: string, rate = ANALYSIS_RATE, span: { from?: number; seconds?: number } = {}): Promise<Float32Array> => {
  const seek = span.from !== undefined && span.from > 0 ? ['-ss', span.from.toFixed(3)] : [];
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', ...seek, '-i', file, '-vn', '-map', '0:a:0', '-t', String(Math.min(MAX_MEASURED_SECONDS, span.seconds ?? MAX_MEASURED_SECONDS)), '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
  // A copy at offset 0: the bytes ffmpeg gave need not start on a 4-byte boundary.
  const bytes = r.stdout.slice(0, r.stdout.length - (r.stdout.length % 4));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
};

/** The integrated loudness of a file in LUFS (EBU R 128), or undefined when ffmpeg gives none (a sound shorter than its 0.4 s gate, or silence). */
export const integratedLoudness = async (rt: Runtime, file: string): Promise<number | undefined> => {
  const r = await runFfmpeg(rt, ['-nostats', '-i', file, '-vn', '-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Integrated loudness:'));
  const value = Number(/I:\s*(-?[\d.]+)\s*LUFS/.exec(summary)?.[1]);
  return r.code === 0 && Number.isFinite(value) && value > -70 ? Math.round(value * 10) / 10 : undefined;
};

/** Samples in -1..1 as a 16-bit, one-channel PCM WAV. */
export const wavOf = (pcm: Float32Array, rate: number): Uint8Array => {
  const out = new Uint8Array(44 + pcm.length * 2), view = new DataView(out.buffer);
  const text = (at: number, s: string): void => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  return out;
};
