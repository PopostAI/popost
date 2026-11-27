/**
 * PCM WAV files as the hosted voice and transcription services take them: the format and length read from the header
 * (chunks ffmpeg adds before the sound, such as LIST, are skipped), the same sound behind a plain 44-byte header, and
 * the sound of a video as the transcribers hear it.
 */
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from './ffmpeg';

export interface Wav {
  /** 1 for integer PCM. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bytes of sound a second (sampleRate × channels × bytes a sample). */
  byteRate: number;
  /** The sound: the bytes of the data chunk. */
  data: Uint8Array;
  seconds: number;
}

const tag = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

/** The format and the sound of a WAV file; throws when the bytes are not one. */
export const readWav = (bytes: Uint8Array): Wav => {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw new Error('This is not a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<Wav, 'data' | 'seconds'> | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(bytes, at), size = view.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length)
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), byteRate: view.getUint32(body + 8, true), bitsPerSample: view.getUint16(body + 14, true) };
    if (id === 'data') {
      if (!fmt || !fmt.byteRate) break;
      // A size the writer could not go back and fill in (0xFFFFFFFF from a pipe) means "to the end of the file".
      const data = bytes.subarray(body, Math.min(bytes.length, body + size));
      return { ...fmt, data, seconds: data.length / fmt.byteRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error('The WAV file has no format or no sound.');
};

/** Integer PCM, one channel, 16 bits: what the hosted services take (each checks its own sample rates). */
export const isMono16 = (w: Wav): boolean => w.format === 1 && w.channels === 1 && w.bitsPerSample === 16;

/** The same sound behind a plain 44-byte header (RIFF, fmt, data), with no other chunk. */
export const plainWav = (w: Wav): Uint8Array => {
  const out = new Uint8Array(44 + w.data.length);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + w.data.length, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, w.format, true); view.setUint16(22, w.channels, true);
  view.setUint32(24, w.sampleRate, true); view.setUint32(28, w.byteRate, true);
  view.setUint16(32, (w.channels * w.bitsPerSample) / 8, true); view.setUint16(34, w.bitsPerSample, true);
  text(36, 'data'); view.setUint32(40, w.data.length, true);
  out.set(w.data, 44);
  return out;
};

/** The sound of a video as the transcribers hear it: 16 kHz, one channel, 16-bit PCM WAV at `out`. */
export const speechWav = (rt: Runtime, video: string, out: string): Promise<unknown> =>
  runFfmpegOk(rt, ['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
