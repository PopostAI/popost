/** `quote`: the first step of the two-step flow (port of `cmd_quote` in provider_cli.py). Never submits, never charges. */
import { isoNow, sha256File, writeAtomic } from '../core/util';
import type { Ref } from './base';
import { isRecord, type JsonRecord } from './base';
import { canonicalJson } from './canonical';
import { creditCap, endpointBinding, parseCredits, providerConfig, quoteDirOf, recordIntegrityHash, requestHash, makeProvider, type Ctx, type PricingSnapshot, type QuotePayload } from './cli-config';
import { Decimal } from './decimal';
import { CapabilityError, CliReject, exitCodeOf, ImageProviderError } from './errors';
import { availablePaidProviders } from './index';
import { resolvePath } from './paths';
import { PopostProvider, type PopostQuote } from './popost';
import { atTime, stamp } from './time';
import { createHash } from 'node:crypto';

export interface QuoteArgs {
  promptFile?: string;
  prompt?: string;
  aspectRatio: string;
  model?: string;
  ref: string[];
  refUrl: string[];
  count: number;
  validSec: number;
}

// ---------------- inputs (shared with generate) ----------------
export const readPrompt = async (ctx: Ctx, a: { promptFile?: string; prompt?: string }): Promise<string> => {
  if (a.promptFile) {
    const path = resolvePath(ctx.rt, a.promptFile);
    if (!(await ctx.rt.fs.stat(path))?.isFile) throw new CliReject(2, `prompt 文件不存在: ${a.promptFile}`);
    return ctx.rt.fs.readText(path);
  }
  if (a.prompt) return a.prompt;
  throw new CliReject(2, '必须提供 --prompt 或 --prompt-file');
};

/** Local references are bound by content (sha256), URL references by their order. */
export const buildRefs = async (ctx: Ctx, a: { ref: string[]; refUrl: string[] }): Promise<Ref[]> => {
  const refs: Ref[] = [];
  for (const p of a.ref) {
    const abs = resolvePath(ctx.rt, p);
    if (!(await ctx.rt.fs.stat(abs))?.isFile) throw new CliReject(2, `本地参考图不存在: ${p}`);
    refs.push({ kind: 'local', value: abs, sha256: await sha256File(ctx.rt, abs) });
  }
  for (const url of a.refUrl) {
    if (!url.startsWith('https://')) throw new CliReject(2, `ref-url 仅支持 https://: ${url}`);
    refs.push({ kind: 'url', value: url, sha256: null });
  }
  return refs;
};

// ---------------- pricing ----------------
export interface PlatformPrice {
  quote: PopostQuote;
  unit: Decimal;
  total: Decimal;
}

/** The platform's free quote: capability problems exit 2, refusals and insufficient credits exit 1. */
export const serverQuote = async (prov: PopostProvider, model: string | null | undefined, aspect: string, count: number, refs: Ref[], allowFree: boolean, recheck = false): Promise<PlatformPrice> => {
  let quote: PopostQuote;
  try {
    quote = (await prov.quote({ model, aspect, count, refs, recheck })) as PopostQuote;
  } catch (error) {
    if (error instanceof CapabilityError) throw new CliReject(2, error.message);
    if (error instanceof ImageProviderError) throw new CliReject(exitCodeOf(error), `${error.message}（未提交、未扣费）`);
    throw error;
  }
  const unit = parseCredits(quote.creditsPerImage, allowFree);
  const total = parseCredits(quote.totalCredits, allowFree);
  if (quote.sufficient === false)
    throw new CliReject(1, `积分不足：本次需要 ${total} 积分，当前余额 ${quote.balance ?? 'None'}；这一步需要 popost 积分：可用 popost account 查看购买选项，或选择本地参考、自带 Key / Agent 生图（未提交、未扣费；popost account 可查余额和购买页面）`);
  return { quote, unit, total };
};

interface Priced {
  model: string;
  label: string | null | undefined;
  unit: Decimal | null;
  total: Decimal | null;
  billingUnit: string;
  priceSource: string;
  extraBilling: JsonRecord;
}

export const isFree = (ctx: Ctx, pcfg: JsonRecord, row?: { free?: boolean }): boolean => Boolean(row?.free || pcfg.free || ctx.cfg.freeExplicit);

const priceOnPlatform = async (ctx: Ctx, prov: PopostProvider, pcfg: JsonRecord, a: QuoteArgs, count: number, refs: Ref[]): Promise<Priced> => {
  const { quote, unit, total } = await serverQuote(prov, a.model, a.aspectRatio, count, refs, isFree(ctx, pcfg));
  return { model: quote.model, label: quote.label, unit, total, billingUnit: 'credits', priceSource: 'popost.ai /images/quote', extraBilling: { balance: quote.balance, sufficient: quote.sufficient } };
};

const priceByoK = async (ctx: Ctx, name: string, pcfg: JsonRecord, a: QuoteArgs, count: number): Promise<Priced> => {
  const prov = makeProvider(ctx, name);
  const capabilities = isRecord(pcfg.capabilities) ? pcfg.capabilities : {};
  if (name === 'custom' && Array.isArray(capabilities.aspects)) prov.aspects = capabilities.aspects as string[];
  if (!prov.aspects.includes(a.aspectRatio))
    throw new CliReject(2, `provider does not declare aspect ${a.aspectRatio}; choose an actually supported asset ratio and crop in HTML`);
  const rows = await prov.models();
  let model = a.model || (pcfg.defaultModel as string | undefined) || (pcfg.model as string | undefined) || prov.defaultModel || rows[0]?.value;
  if (!model) throw new CliReject(1, '模型清单为空，拒绝报价');
  let row = rows.find((r) => r.value === model);
  if (!row) throw new CliReject(1, `模型 ${model} 不在实时清单，拒绝报价`);
  // The same allow-list / lock the submission applies, so a quote that passes cannot be refused at confirm time.
  try {
    model = (await prov.resolveQuotedModel(model)) ?? model;
  } catch (error) {
    if (error instanceof ImageProviderError) throw new CliReject(1, error.message);
    throw error;
  }
  row = rows.find((r) => r.value === model) ?? row;
  const unknownOk = name === 'custom' && (row.credits === null || row.credits === undefined) && ctx.g.acceptUnknownCost;
  const unit = unknownOk ? null : parseCredits(row.credits, isFree(ctx, pcfg, row));
  const billing = isRecord(pcfg.billing) ? pcfg.billing : {};
  return { model, label: row.label, unit, total: unit ? unit.times(count) : null, billingUnit: String(billing.unit ?? 'provider-units'), priceSource: 'custom', extraBilling: {} };
};

const dryRunQuote = async (prov: PopostProvider, a: QuoteArgs, count: number, refs: Ref[]): Promise<JsonRecord> => {
  let plan: JsonRecord;
  try {
    plan = (await prov.quote({ model: a.model, aspect: a.aspectRatio, count, refs })) as unknown as JsonRecord;
  } catch (error) {
    if (error instanceof CapabilityError) throw new CliReject(2, error.message);
    if (error instanceof ImageProviderError) throw new CliReject(1, error.message);
    throw error;
  }
  return { ok: true, dryRun: true, plan, charged: false, message: 'dry-run：未联网、未报价、未写报价记录' };
};

// ---------------- the quote record ----------------
const quoteId = (ctx: Ctx, payload: QuotePayload): string =>
  `q_${stamp(ctx.rt.now())}_${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex').slice(0, 8)}`;

const buildRecord = (ctx: Ctx, name: string, a: QuoteArgs, p: Priced, prompt: string, refs: Ref[], count: number, pcfg: JsonRecord) => {
  const { rt } = ctx;
  const binding = endpointBinding(rt, name, pcfg);
  const snapshot: PricingSnapshot = {
    unitCredits: p.unit ? String(p.unit) : null,
    label: p.label ?? null,
    billingUnit: p.billingUnit,
    priceFetchedAt: isoNow(rt),
    priceSource: p.priceSource,
    pricingVersion: ctx.cfg.pricingVersion ?? null,
    endpointBinding: binding,
  };
  const payload: QuotePayload = { provider: name, model: p.model, prompt, aspect: a.aspectRatio, count, refs, pricingSnapshot: snapshot };
  const qid = quoteId(ctx, payload);
  const expires = new Date(rt.now().getTime() + a.validSec * 1000);
  const record: JsonRecord = {
    schemaVersion: 'quote.v1',
    quoteId: qid,
    provider: name,
    model: p.model,
    prompt,
    aspect: a.aspectRatio,
    count,
    refs,
    requestHash: requestHash(payload),
    pricingSnapshot: snapshot,
    totalCredits: p.total ? String(p.total) : null,
    unknownCostAcknowledged: p.unit === null,
    expiresAt: isoNow(atTime(rt, expires)),
    endpointBinding: binding,
    status: 'quoted',
    confirmRequired: true,
    mock: ctx.g.mock,
    note: `本记录仅为报价，未提交未扣费；须宿主先展示并取得用户明确费用授权，方可 generate --quote-id ${qid} --confirm`,
  };
  record.recordHash = recordIntegrityHash(record);
  return record;
};

export const cmdQuote = async (ctx: Ctx, name: string, a: QuoteArgs): Promise<JsonRecord> => {
  if (!availablePaidProviders().includes(name))
    throw new CliReject(1, `provider ${name} 非生成通道或未知（付费可选 ${availablePaidProviders().join('/')}；manual/host 无需报价）`);
  const prompt = await readPrompt(ctx, a);
  const refs = await buildRefs(ctx, a);
  const count = Math.max(1, Math.trunc(Number(a.count || 1)));
  const prov = makeProvider(ctx, name);
  const pcfg = providerConfig(ctx.cfg, name);
  if (prov instanceof PopostProvider && ctx.g.dryRun) return dryRunQuote(prov, a, count, refs);
  const priced = prov instanceof PopostProvider ? await priceOnPlatform(ctx, prov, pcfg, a, count, refs) : await priceByoK(ctx, name, pcfg, a, count);
  const cap = creditCap(ctx.cfg, name, pcfg);
  if (priced.total && priced.unit && cap && priced.total.compare(cap) > 0) throw new CliReject(1, `单请求总积分 ${priced.total} = ${priced.unit}×${count} 超过硬顶 ${cap}，拒绝`);
  const record = buildRecord(ctx, name, a, priced, prompt, refs, count, pcfg);
  const path = ctx.rt.path.join(quoteDirOf(ctx), `${String(record.quoteId)}.json`);
  await writeAtomic(ctx.rt, path, JSON.stringify(record, null, 2));
  const { unit, total } = priced;
  const snapshot = record.pricingSnapshot as PricingSnapshot;
  return {
    ok: true,
    quote: record,
    quoteFile: path,
    billing: {
      unitAmount: unit ? String(unit) : null,
      count,
      totalAmount: total ? String(total) : null,
      unit: snapshot.billingUnit,
      unitCredits: unit ? String(unit) : null,
      totalCredits: total ? String(total) : null,
      cap: cap ? String(cap) : null,
      priceStatus: unit === null ? 'unknown' : 'quoted',
      charged: false,
      ...priced.extraBilling,
    },
  };
};
