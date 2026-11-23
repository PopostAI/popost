/**
 * The picture signature: 16 x 16 gray thumbnails every 'every' frames, at most 240 of them, row by row, one byte
 * per pixel, base64. Enough to compare the pictures of two videos at the same times without decoding them again.
 */
import type { Measure } from '../types';
import { resample } from './pixels';

export const SIGNATURE_SIZE = 16;
export const MAX_SAMPLES = 240;

export const measureSignature = (gray: readonly Uint8Array[], w: number, h: number): Measure['signature'] => {
  const every = Math.max(1, Math.ceil(gray.length / MAX_SAMPLES));
  const count = Math.ceil(gray.length / every);
  const bytes = new Uint8Array(count * SIGNATURE_SIZE * SIGNATURE_SIZE);
  for (let k = 0; k < count; k++) {
    const small = resample(gray[k * every] as Uint8Array, w, h, 1, SIGNATURE_SIZE, SIGNATURE_SIZE);
    for (let i = 0; i < small.length; i++) bytes[k * SIGNATURE_SIZE * SIGNATURE_SIZE + i] = Math.round(small[i] as number);
  }
  return { every, width: SIGNATURE_SIZE, height: SIGNATURE_SIZE, count, data: Buffer.from(bytes).toString('base64') };
};

/** The thumbnails of a signature as one Uint8Array each. */
export const signatureFrames = (s: Measure['signature']): Uint8Array[] => {
  const all = new Uint8Array(Buffer.from(s.data, 'base64'));
  const size = s.width * s.height;
  return Array.from({ length: s.count }, (_, k) => all.subarray(k * size, (k + 1) * size));
};
