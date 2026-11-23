/** Compare retained reference content without stretching a removed platform endcard over the new closing. */
import { endAt } from '../elements/carry';
import type { ReferenceFacts } from '../template/facts';
import { referenceFingerprint } from '../template/fingerprint';
import type { DroppedShot } from '../template/types';
import type { Measure } from '../types';

export const comparisonScope = (reference: Measure, facts?: ReferenceFacts): { measure: Measure; omitted?: DroppedShot[] } => {
  const unchanged = { measure: reference };
  const omitted = facts?.omittedShots;
  if (!Array.isArray(omitted) || !omitted.length || !facts?.template.fingerprint || referenceFingerprint(reference) !== facts.template.fingerprint) return unchanged;
  const fps = reference.source.fps;
  let end = reference.source.frames;
  // Only a contiguous, fully declared tail is eligible. Never remove a middle shot or silently change an unrelated source.
  for (const s of [...omitted].reverse()) {
    if (!s || typeof s.reason !== 'string' || !s.reason.trim() || !Array.isArray(s.seconds) || s.seconds.length !== 2 || !s.seconds.every(Number.isFinite) || Math.abs(s.seconds[1] * fps - end) > 0.51 || s.seconds[0] < 0 || s.seconds[0] >= s.seconds[1]) return unchanged;
    end = Math.round(s.seconds[0] * fps);
    if (!reference.shots.some((shot) => Math.abs(shot.start - end) <= 1)) return unchanged;
  }
  return end > 0 && end < reference.source.frames ? { measure: endAt({ measure: reference }, end).measure, omitted } : unchanged;
};
