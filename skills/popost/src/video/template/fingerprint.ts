/** A reference's sampled visual identity, independent of corrected shot and caption classifications. */
import { createHash } from 'node:crypto';
import type { Measure } from '../types';

export const referenceFingerprint = (m: Measure): string | undefined => m.signature.count > 1 && m.signature.data
  ? 'sha256:' + createHash('sha256').update(JSON.stringify([m.source.width, m.source.height, m.source.fps, m.source.frames, m.signature.every, m.signature.width, m.signature.height, m.signature.count, m.signature.data])).digest('hex')
  : undefined;
