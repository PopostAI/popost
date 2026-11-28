/** Stable material provenance, with narrowly reconstructed historical cast prompts. */
import { sha256 } from '../../core/util';

export interface MaterialProvenance {
  request: object;
  voiceHash?: string;
  dependencies: readonly (readonly [string, string | null])[];
  lines?: readonly object[];
  /** A real generation constraint, never removed by the historical-prompt compatibility path. */
  separateMusic?: true;
}

export const materialSignature = (value: MaterialProvenance): string => sha256(JSON.stringify(value));

/** Alternatives change only a verified cast-evidence rendering; all other context stays exact. */
export const materialSignatures = (value: MaterialProvenance, legacyRequests: readonly object[] = []): string[] =>
  [...new Set([materialSignature(value), ...legacyRequests.map(request => materialSignature({ ...value, request }))])];
