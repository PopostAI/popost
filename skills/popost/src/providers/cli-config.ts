/**
 * Shared pieces of the two-step quote / generate CLI (port of the helpers in provider_cli.py): private config, the
 * hashes that bind a quote to its request, price parsing, the credit cap, directories and the provider factory.
 */
import { createHash } from 'node:crypto';
import type { Runtime } from '../runtime';
import { isFile } from '../core/util';
import { BASE_URL_ENV, DEFAULT_BASE_URL, DEFAULT_KEY_ENV } from './api';
import { isRecord, type BaseImageProvider, type JsonRecord, type Ref } from './base';
import { canonicalJson, pyStr } from './canonical';
import { Decimal, decimalOf } from './decimal';
import { CliReject } from './errors';
import { getProvider, OFFICIAL_PROVIDER } from './index';
import { defaultConfigPath, defaultQuoteDir, resolvePath } from './paths';
import { PopostProvider } from './popost';

/** The platform-credit hard cap of one request; private config can only lower it. */
export const MAX_CREDITS_PER_REQUEST = Decimal.parse('200')!;

/** Options every subcommand accepts (the `common` parent parser of provider_cli.py). */
export interface Globals {
  mock: boolean;
  dryRun: boolean;
  mockDir?: string;
  quoteDir?: string;
  ledger?: string;
  taskDir?: string;
  acceptUnknownCost: boolean;
}

export interface Ctx {
  rt: Runtime;
  cfg: JsonRecord;
  g: Globals;
}

// ---------------- config ----------------
export const loadConfig = async (rt: Runtime, path?: string): Promise<JsonRecord> => {
  const file = path || rt.env.POPOST_PROVIDER_CONFIG || rt.env.SOCIAL_POST_STUDIO_CONFIG || defaultConfigPath(rt);
  const abs = resolvePath(rt, file);
  if (!(await isFile(rt, abs))) return {};
  try {
    const data: unknown = JSON.parse(await rt.fs.readText(abs));
    return isRecord(data) ? data : {};
  } catch (error) {
    throw new CliReject(2, `配置文件 ${file} 读取失败: ${(error as Error).message}`);
  }
};

// Top-level (flat, old-format) keys merge into a channel's section: popost only takes the model-choice keys, so a BYOK
// baseUrl or auth is never applied to the platform channel by accident.
const SHARED_KEYS = ['defaultModel', 'providerOverrides', 'pollIntervalSec', 'mockModelsPath'];
const BYOK_KEYS = ['creditsPerRequest', 'mode', 'baseUrl', 'model', 'sizeMap', 'auth', 'http', 'asyncTaskPath', 'declared', 'capabilities', 'referenceTransport', 'billing', 'maxAmountPerRequest'];

export const providerConfig = (cfg: JsonRecord, name: string): JsonRecord => {
  const merged: JsonRecord = isRecord(cfg[name]) ? { ...(cfg[name] as JsonRecord) } : {};
  for (const key of name === OFFICIAL_PROVIDER ? SHARED_KEYS : [...SHARED_KEYS, ...BYOK_KEYS]) if (key in cfg && !(key in merged)) merged[key] = cfg[key];
  return merged;
};

// ---------------- binding hashes ----------------
export const normalizePrompt = (text: string | null | undefined): string => (text ?? '').split(/\s+/).filter(Boolean).join(' ');

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface PricingSnapshot {
  unitCredits: string | null;
  label: string | null | undefined;
  billingUnit: string;
  priceFetchedAt: string;
  priceSource: string;
  pricingVersion: unknown;
  endpointBinding: string;
}

export interface QuotePayload {
  provider: string;
  model: string;
  prompt: string;
  aspect: string;
  count: number;
  refs: Ref[];
  pricingSnapshot: PricingSnapshot;
}

/** The request as the quote saw it; any change of what will be bought changes this hash. */
export const requestHash = (payload: QuotePayload): string => {
  const snap = payload.pricingSnapshot;
  return sha(
    canonicalJson({
      provider: payload.provider,
      model: payload.model,
      prompt: normalizePrompt(payload.prompt),
      aspect: payload.aspect,
      count: payload.count,
      refs: payload.refs,
      unitCredits: pyStr(snap.unitCredits, 'None'),
      priceSource: snap.priceSource,
      pricingVersion: snap.pricingVersion ?? null,
      endpointBinding: snap.endpointBinding,
      billingUnit: snap.billingUnit ?? 'credits',
    }),
  );
};

const INTEGRITY_FIELDS = ['schemaVersion', 'quoteId', 'provider', 'model', 'prompt', 'aspect', 'count', 'refs', 'pricingSnapshot', 'totalCredits', 'expiresAt', 'endpointBinding', 'unknownCostAcknowledged'];

/** Detects a quote file edited after it was written. */
export const recordIntegrityHash = (record: JsonRecord): string =>
  sha(canonicalJson(Object.fromEntries(INTEGRITY_FIELDS.filter((k) => k in record).map((k) => [k, record[k]]))));

/** Endpoint / account identity as a hash: no secret value is ever stored. */
export const endpointBinding = (rt: Runtime, name: string, pcfg: JsonRecord): string => {
  const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
  let material: string;
  if (name === 'custom')
    material = [
      pyStr(pcfg.mode),
      pyStr(pcfg.baseUrl),
      pyStr(pcfg.model),
      pyStr(auth.envVar),
      canonicalJson(pcfg.billing ?? {}, true),
      canonicalJson(pcfg.capabilities ?? {}, true),
      pyStr(pcfg.referenceTransport),
    ].join('|');
  else if (name === OFFICIAL_PROVIDER) {
    const base = String(pcfg.baseUrl || rt.env[BASE_URL_ENV] || DEFAULT_BASE_URL).replace(/\/+$/, '');
    material = [name, base, pyStr(auth.envVar || DEFAULT_KEY_ENV), pyStr(pcfg.defaultModel || '')].join('|');
  } else material = [name, pyStr(pcfg.defaultModel || '')].join('|');
  const credentialName = typeof auth.envVar === 'string' ? auth.envVar : name === OFFICIAL_PROVIDER ? DEFAULT_KEY_ENV : undefined;
  const credential = credentialName ? rt.env[credentialName]?.trim() : undefined;
  if (credential) material += `|credential:${sha(credential)}`;
  return sha(material).slice(0, 16);
};

// ---------------- prices ----------------
const repr = (value: unknown): string => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

/** A unit price as a decimal: refuses booleans, missing, NaN/Inf, negative; zero only when explicitly declared free. */
export const parseCredits = (value: unknown, allowFree = false): Decimal => {
  if (typeof value === 'boolean') throw new CliReject(1, '价格为布尔值，非法（拒绝）');
  if (value === null || value === undefined) throw new CliReject(1, '价格未知，拒绝报价/提交');
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (Decimal.isNonFinite(text)) throw new CliReject(1, '价格非有限值（NaN/Inf），拒绝');
  const d = decimalOf(value);
  if (!d) throw new CliReject(1, `价格非数值: ${repr(value)}，拒绝`);
  if (d.isNegative()) throw new CliReject(1, `负价格 ${d}，拒绝`);
  if (d.isZero() && !allowFree) throw new CliReject(1, '零价格未显式声明免费，按未知价拒绝（禁止 0 元扣费放行）');
  return d;
};

/** Platform channel: `min(200, maxCreditsPerRequest)`; BYOK: `maxAmountPerRequest` (may be none). */
export const creditCap = (cfg: JsonRecord, name: string, pcfg: JsonRecord): Decimal | null => {
  const cap = decimalOf('maxCreditsPerRequest' in cfg ? cfg.maxCreditsPerRequest : 200);
  if (!cap || cap.isNegative()) throw new CliReject(1, '配置 maxCreditsPerRequest 非法');
  if (name === OFFICIAL_PROVIDER) return cap.compare(MAX_CREDITS_PER_REQUEST) < 0 ? cap : MAX_CREDITS_PER_REQUEST;
  if (pcfg.maxAmountPerRequest !== undefined && pcfg.maxAmountPerRequest !== null) return decimalOf(pcfg.maxAmountPerRequest);
  return null;
};

// ---------------- directories and providers ----------------
export const quoteDirOf = (ctx: Ctx): string => resolvePath(ctx.rt, ctx.g.quoteDir || defaultQuoteDir(ctx.rt));

/** Local task records of the synchronous channel: `--task-dir` > `POPOST_TASK_DIR` > `tasks/` beside the quote directory. */
export const taskDirFor = (ctx: Ctx): string => {
  const { rt, g } = ctx;
  if (g.taskDir) return resolvePath(rt, g.taskDir);
  if (rt.env.POPOST_TASK_DIR) return resolvePath(rt, rt.env.POPOST_TASK_DIR);
  return rt.path.join(rt.path.dirname(quoteDirOf(ctx)), 'tasks');
};

export const resolveOutDir = (ctx: Ctx, outDir: string): string => resolvePath(ctx.rt, outDir);

export const ledgerPathOf = (ctx: Ctx): string => resolvePath(ctx.rt, ctx.g.ledger || ctx.rt.path.join(quoteDirOf(ctx), '..', 'ledger.jsonl'));

export const makeProvider = (ctx: Ctx, name: string): BaseImageProvider => {
  const pcfg = providerConfig(ctx.cfg, name);
  // No fallback into the package: without an explicit directory the provider writes its mock state in the working dir.
  const mockDir = ctx.g.mockDir || (pcfg.mockDir as string | undefined) || null;
  const provider = getProvider(ctx.rt, name, { config: pcfg, dryRun: ctx.g.dryRun, mock: ctx.g.mock, mockDir: mockDir && resolvePath(ctx.rt, mockDir) });
  if (provider instanceof PopostProvider && (ctx.g.taskDir || !provider.taskDir)) provider.taskDir = taskDirFor(ctx);
  return provider;
};
