/** The read-only and bookkeeping commands of the provider CLI: `status`, `download`, `models`, `check`, `inventory`. */
import type { JsonRecord } from './base';
import { makeProvider, resolveOutDir, type Ctx } from './cli-config';
import { ImageProviderError } from './errors';
import { availablePaidProviders } from './index';
import { ManualProvider } from './manual-host';

/** Reads an existing task id only; for the platform channel it reads the local task record and asks nobody. */
export const cmdStatus = async (ctx: Ctx, name: string, taskId: string, raw: boolean): Promise<JsonRecord> => {
  const data = await makeProvider(ctx, name).status(taskId);
  return { ok: true, taskId, status: data.status, raw: raw ? data : null };
};

/** Copies or downloads the result of a finished task again; never regenerates. */
export const cmdDownload = async (ctx: Ctx, name: string, taskId: string, outDir: string): Promise<JsonRecord> => {
  const materials = await makeProvider(ctx, name).materialize(taskId, resolveOutDir(ctx, outDir));
  return { ok: true, taskId, materials };
};

export const cmdModels = async (ctx: Ctx, name: string): Promise<JsonRecord> => ({ ok: true, provider: name, models: await makeProvider(ctx, name).models() });

/** Capability preflight. A paid channel that is not usable makes `ok` false; the exit code stays 0. Never prints credentials. */
export const cmdCheck = async (ctx: Ctx, name: string): Promise<JsonRecord> => {
  const checks: Record<string, JsonRecord> = {};
  let ok = true;
  for (const target of [name]) {
    const provider = makeProvider(ctx, target);
    let result: readonly [boolean, boolean, string];
    try {
      result = await provider.check();
    } catch (error) {
      if (!(error instanceof ImageProviderError)) throw error;
      result = [false, true, error.message];
    }
    checks[target] = { ok: result[0], measured: result[1], generative: provider.generative, message: result[2] };
    if (result[0] === false && availablePaidProviders().includes(target)) ok = false;
  }
  return { ok, checks };
};

/** The manual channel: registers files the user supplied (existence and sha256). No API, no cost. */
export const cmdInventory = async (ctx: Ctx, files: readonly string[]): Promise<JsonRecord> => {
  const items = await new ManualProvider(ctx.rt, { config: {}, dryRun: false, mock: ctx.g.mock }).inventory(files);
  return { ok: true, channel: 'manual', charged: false, items, note: '用户直接提供的素材，未发起任何 API、未计费' };
};
