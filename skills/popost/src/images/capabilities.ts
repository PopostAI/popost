/**
 * What the picture model of a job can do, as far as `image prepare` needs it: which picture ratios it makes and how many
 * reference pictures it takes. The platform's model list is free to read, so it is asked when the key and the network
 * allow; otherwise the answer is the common ratios and the largest limit the platform has, and `quote` stays the
 * authority that checks the request.
 */
import { executeCli } from '../providers/cli';
import { isRecord, type ModelRow } from '../providers/base';
import { loadConfig, providerConfig } from '../providers/cli-config';
import { MAX_REFERENCE_IMAGES } from '../providers/popost-validate';
import type { Project } from '../core/project';
import type { JobProvider } from './jobs';
import { invocation, providerName } from './run';

export interface ModelLimits {
  /** The ratios the model declares (`16:9`); `undefined`: not known, or not restricted. */
  readonly aspects?: readonly string[];
  /** How many reference pictures a request may carry. */
  readonly maxReferenceImages: number;
  /** Why the live model list was not used, when it was wanted. */
  readonly unavailable?: string;
}

/** A bring-your-own-key service declares no more than this unless its config says so. */
const BYOK_REFERENCES = 5;
const BYOK_ASPECTS = ['1:1', '16:9', '9:16'];

const wantedModel = (provider: JobProvider, config: Record<string, unknown>): string | undefined => {
  const named = provider.model || config.defaultModel || config.model;
  return typeof named === 'string' && named ? named : undefined;
};

/** The model the request will use: the named one, else the platform's default, else the only one. */
const pickRow = (rows: readonly ModelRow[], wanted: string | undefined): ModelRow | undefined =>
  rows.find((row) => row.value === wanted) ?? rows.find((row) => row.isDefault) ?? (rows.length === 1 ? rows[0] : undefined);

const platformLimits = async (project: Project, provider: JobProvider, config: string | undefined): Promise<ModelLimits> => {
  const fallback: ModelLimits = { maxReferenceImages: MAX_REFERENCE_IMAGES };
  try {
    const outcome = await executeCli(project.rt, invocation(project, provider, { config, acceptUnknownCost: false }, { name: 'models' }));
    if (outcome.code !== 0) return { ...fallback, unavailable: String(outcome.result.error ?? 'the model list could not be read') };
    const settings = providerConfig(await loadConfig(project.rt, config), providerName(provider));
    const rows = Array.isArray(outcome.result.models) ? (outcome.result.models as ModelRow[]) : [];
    const row = pickRow(rows, wantedModel(provider, settings));
    return { aspects: row?.aspectRatios?.length ? row.aspectRatios : undefined, maxReferenceImages: Math.min(MAX_REFERENCE_IMAGES, row?.maxReferenceImages ?? MAX_REFERENCE_IMAGES), unavailable: row ? undefined : 'no single model to read limits from' };
  } catch (error) {
    return { ...fallback, unavailable: error instanceof Error ? error.message : String(error) };
  }
};

const byokLimits = async (project: Project, provider: JobProvider, config: string | undefined): Promise<ModelLimits> => {
  try {
    const capabilities = providerConfig(await loadConfig(project.rt, config), providerName(provider)).capabilities;
    const declared = isRecord(capabilities) && Array.isArray(capabilities.aspects) ? capabilities.aspects.map(String) : BYOK_ASPECTS;
    return { aspects: declared, maxReferenceImages: BYOK_REFERENCES };
  } catch (error) {
    return { aspects: BYOK_ASPECTS, maxReferenceImages: BYOK_REFERENCES, unavailable: error instanceof Error ? error.message : String(error) };
  }
};

/** Limits of the model a job on this channel will use. A host channel generates elsewhere, so only the common limits apply. */
export const modelLimits = async (project: Project, provider: JobProvider, config?: string): Promise<ModelLimits> => {
  if (provider.channel === 'official') return platformLimits(project, provider, config);
  if (provider.channel === 'host') return { maxReferenceImages: BYOK_REFERENCES };
  return byokLimits(project, provider, config);
};
