/**
 * `generate`: the second step, the only one that can charge (port of `cmd_generate` in provider_cli.py).
 *
 * Before any request: explicit `--confirm`; the quote file's integrity hash; the ledger has no record of the quote; the
 * quote is `quoted` and unexpired; prompt, model, aspect, count and references match what was quoted (local references
 * by content); the endpoint binding is unchanged; the live price still equals the quoted one; the cap holds; the request
 * hash matches. Then the ledger reserves the quote, the provider submits, and the ledger settles. An unknown outcome is
 * recorded `ambiguous` and never retried.
 */
import { createHash } from 'node:crypto';
import { readJson, sha256File, writeAtomic } from '../core/util';
import type { BaseImageProvider, JsonRecord, Ref, SubmitOptions } from './base';
import { canonicalJson, pyStr } from './canonical';
import { creditCap, endpointBinding, ledgerPathOf, makeProvider, normalizePrompt, parseCredits, providerConfig, quoteDirOf, recordIntegrityHash, requestHash, type Ctx, type PricingSnapshot, type QuotePayload } from './cli-config';
import { buildRefs, isFree, readPrompt, serverQuote } from './cli-quote';
import { Decimal, decimalOf } from './decimal';
import { AmbiguousSubmitError, CapabilityError, CliReject, ImageProviderError } from './errors';
import * as ledger from './ledger';
import { PopostProvider } from './popost';
import { sleep } from './time';

export interface GenerateArgs {
  quoteId: string;
  confirm: boolean;
  promptFile?: string;
  prompt?: string;
  aspectRatio?: string;
  model?: string;
  ref: string[];
  refUrl: string[];
  count?: number;
  outDir?: string;
  pollInterval?: number;
  pollTimeout?: number;
  idempotencyKey?: string;
}

export interface QuoteRecord extends JsonRecord {
  quoteId: string;
  provider: string;
  model: string;
  prompt: string;
  aspect: string;
  count: number;
  refs: Ref[];
  requestHash: string;
  pricingSnapshot: PricingSnapshot;
  totalCredits: string | null;
  unknownCostAcknowledged?: boolean;
  expiresAt: string;
  endpointBinding: string;
  status: string;
  recordHash?: string;
}

const none = (value: unknown): string => pyStr(value, 'None');

/** Derived from quote id + request hash (constant for one quote) unless a person passes one for a safe manual retry. */
const idempotencyKey = (a: GenerateArgs, record: QuoteRecord): string =>
  a.idempotencyKey || `skill-${createHash('sha256').update(`${record.quoteId}|${record.requestHash}`, 'utf8').digest('hex').slice(0, 40)}`;

// ---------------- checks before any request ----------------
const loadQuote = async (ctx: Ctx, quoteId: string): Promise<{ record: QuoteRecord; path: string }> => {
  const path = ctx.rt.path.join(quoteDirOf(ctx), `${quoteId}.json`);
  if (!(await ctx.rt.fs.stat(path))?.isFile) throw new CliReject(1, `quote ${quoteId} 不存在（先执行 quote）`);
  let record: QuoteRecord;
  try {
    record = await readJson<QuoteRecord>(ctx.rt, path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CliReject(1, `quote ${quoteId} 记录不是合法 JSON（文件可能被编辑），拒绝并重新 quote`);
  }
  if (!record.recordHash || recordIntegrityHash(record) !== record.recordHash) throw new CliReject(1, 'quote 记录完整性校验失败（文件可能被编辑），拒绝并重新 quote');
  return { record, path };
};

const checkUsable = (ctx: Ctx, record: QuoteRecord, quoteId: string): void => {
  if (record.status !== 'quoted') throw new CliReject(1, `quote ${quoteId} 状态为 ${record.status}，不可用于提交`);
  const expires = Date.parse(record.expiresAt);
  if (Number.isNaN(expires)) throw new CliReject(1, `quote ${quoteId} 的 expiresAt 非法（${record.expiresAt}），请重新 quote`);
  if (ctx.rt.now().getTime() > expires) throw new CliReject(1, `quote ${quoteId} 已过期（${record.expiresAt}），请重新 quote`);
};

interface Bound {
  prompt: string;
  refs: Ref[];
}

/** What the caller passed again must equal what the quote bound; nothing may change between quote and charge. */
const bindRequest = async (ctx: Ctx, a: GenerateArgs, record: QuoteRecord): Promise<Bound> => {
  const prompt = a.prompt || a.promptFile ? await readPrompt(ctx, a) : record.prompt;
  const given = await buildRefs(ctx, a);
  const refs = given.length ? given : record.refs;
  if (normalizePrompt(prompt) !== normalizePrompt(record.prompt)) throw new CliReject(1, 'prompt 与 quote 不一致，拒绝（变更请求须重新 quote）');
  if ((a.model && a.model !== record.model) || (a.aspectRatio && a.aspectRatio !== record.aspect) || (a.count && a.count !== Number(record.count)))
    throw new CliReject(1, 'model/aspect/count 与 quote 不一致，拒绝');
  for (const ref of refs) if (ref.kind === 'local' && (await sha256File(ctx.rt, ref.value)) !== ref.sha256) throw new CliReject(1, 'reference bytes changed since quote');
  if (canonicalJson(refs) !== canonicalJson(record.refs)) throw new CliReject(1, '参考图与 quote 不一致（本地内容 sha256 / URL 顺序），拒绝');
  return { prompt, refs };
};

const dryRunPlan = async (ctx: Ctx, a: GenerateArgs, record: QuoteRecord, bound: Bound): Promise<JsonRecord> => {
  const prov = makeProvider(ctx, record.provider);
  prov.dryRun = true;
  const options: SubmitOptions | undefined = prov instanceof PopostProvider ? { idempotencyKey: idempotencyKey(a, record), maxCredits: record.totalCredits } : undefined;
  try {
    const plan = await prov.submit(bound.prompt, { aspect: record.aspect, refs: bound.refs, model: record.model, count: Number(record.count), options });
    return { ok: true, dryRun: true, quoteId: a.quoteId, plan, charged: false, message: 'dry-run：未预占、未联网查询、未提交、未扣费' };
  } catch (error) {
    if (error instanceof CapabilityError) throw new CliReject(2, error.message);
    throw error;
  }
};

interface Rechecked {
  options: SubmitOptions | undefined;
  unit: Decimal | null;
  total: Decimal | null;
  extraBilling: JsonRecord;
}

const sameDecimal = (a: Decimal | null, b: Decimal | null): boolean => (a === null || b === null ? a === b : a.equals(b));

/** The live price against the quoted one: the platform's own quote, or the provider's current model list. */
const recheckPrice = async (ctx: Ctx, a: GenerateArgs, record: QuoteRecord, prov: BaseImageProvider, refs: Ref[]): Promise<Rechecked> => {
  const pcfg = providerConfig(ctx.cfg, record.provider);
  const snapUnit = record.pricingSnapshot.unitCredits === null ? null : decimalOf(record.pricingSnapshot.unitCredits);
  const count = Number(record.count);
  if (prov instanceof PopostProvider) {
    const { quote, unit, total } = await serverQuote(prov, record.model, record.aspect, count, refs, isFree(ctx, pcfg), true);
    const quotedTotal = record.totalCredits ? decimalOf(record.totalCredits) : null;
    if (quote.model !== record.model) throw new CliReject(1, `平台报价模型 ${quote.model} 与 quote 绑定模型 ${record.model} 不一致，停止并重新 quote`);
    if (!sameDecimal(unit, snapUnit) || !sameDecimal(total, quotedTotal))
      throw new CliReject(1, `价格已变动：quote=${none(snapUnit && String(snapUnit))}（合计 ${none(quotedTotal && String(quotedTotal))}），latest=${unit}（合计 ${total}）；停止并重新 quote，不得用旧价扣费`);
    return { options: { idempotencyKey: idempotencyKey(a, record), maxCredits: record.totalCredits }, unit, total, extraBilling: { balanceBefore: quote.balance } };
  }
  const row = (await prov.models()).find((r) => r.value === record.model);
  if (!row) throw new CliReject(1, `latest 清单中模型 ${record.model} 价格未知，拒绝提交`);
  const unknownOk = record.provider === 'custom' && (row.credits === null || row.credits === undefined) && ctx.g.acceptUnknownCost && Boolean(record.unknownCostAcknowledged);
  const unit = unknownOk ? null : parseCredits(row.credits, isFree(ctx, pcfg, row));
  if (!sameDecimal(unit, snapUnit)) throw new CliReject(1, `价格已变动：quote=${none(snapUnit && String(snapUnit))}，latest=${none(unit && String(unit))}；停止并重新 quote，不得用旧价扣费`);
  return { options: undefined, unit, total: unit ? unit.times(count) : null, extraBilling: {} };
};

// ---------------- submit, wait, materialize, settle ----------------
const submitReserved = async (ctx: Ctx, ledgerPath: string, record: QuoteRecord, prov: BaseImageProvider, bound: Bound, options: SubmitOptions | undefined): Promise<JsonRecord> => {
  const reason = (extra: JsonRecord) => ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'ambiguous', extra);
  try {
    return await prov.submit(bound.prompt, { aspect: record.aspect, refs: bound.refs, model: record.model, count: Number(record.count), options });
  } catch (error) {
    if (error instanceof AmbiguousSubmitError) {
      await reason({ reason: error.message });
      throw new CliReject(1, `POST 结果不确定已记 ambiguous：${error.message}；禁止自动重试，请人工核对`);
    }
    if (error instanceof ImageProviderError) {
      await reason({ reason: `rejected: ${error.message}`, charged: false });
      throw new CliReject(1, `提交被拒绝（未建单未扣费）: ${error.message}`);
    }
    throw error;
  }
};

/** Waits for a task that was submitted asynchronously; a timeout leaves the outcome unknown, so it is recorded ambiguous. */
const waitForTask = async (ctx: Ctx, a: GenerateArgs, ledgerPath: string, record: QuoteRecord, prov: BaseImageProvider, submitted: JsonRecord, taskId: string): Promise<void> => {
  const pollCfg = Number(providerConfig(ctx.cfg, record.provider).pollIntervalSec ?? 30);
  const interval = Number(a.pollInterval || pollCfg);
  const timeout = Number(a.pollTimeout || 300);
  if (prov.wait) {
    await prov.wait(taskId, interval, timeout);
    return;
  }
  if (submitted.status === 'completed') return;
  const deadline = ctx.rt.now().getTime() + timeout * 1000;
  while (ctx.rt.now().getTime() < deadline) {
    const st = await prov.status(taskId);
    if (st.status === 'completed' || st.status === 'failed') return;
    await sleep(ctx.rt, interval * 1000);
  }
  await ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'ambiguous', { reason: 'poll timeout', taskId });
  throw new CliReject(1, '轮询超时，记 ambiguous；未确认完成，禁止重试提交');
};

const markConsumed = (ctx: Ctx, record: QuoteRecord, path: string): Promise<void> => {
  record.status = 'consumed';
  return writeAtomic(ctx.rt, path, JSON.stringify(record, null, 2));
};

const finish = async (ctx: Ctx, a: GenerateArgs, ledgerPath: string, record: QuoteRecord, qpath: string, prov: BaseImageProvider, submitted: JsonRecord): Promise<JsonRecord[]> => {
  const taskId = submitted.taskId as string | undefined;
  if (!taskId) {
    await ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'ambiguous', { reason: 'no taskId' });
    throw new CliReject(1, '未取得 taskId，记 ambiguous，禁止自动重试');
  }
  await waitForTask(ctx, a, ledgerPath, record, prov, submitted, taskId);
  const final = await prov.status(taskId);
  if (final.status !== 'completed') {
    await ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'ambiguous', { reason: `task ${String(final.status)}`, taskId });
    throw new CliReject(1, `任务终态非 completed：${String(final.status)}`);
  }
  try {
    const materials = await prov.materialize(taskId, resolveOut(ctx, a));
    await ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'consumed', { taskId, materials });
    await markConsumed(ctx, record, qpath);
    return materials;
  } catch (error) {
    if (!(error instanceof ImageProviderError)) throw error;
    // Generated and charged: the ledger says consumed and the result can be fetched again, never regenerated.
    await ledger.settle(ctx.rt, ledgerPath, record.quoteId, 'consumed', { taskId, materializeError: error.message });
    await markConsumed(ctx, record, qpath);
    throw new CliReject(1, `已生成（taskId ${taskId}，已计费），但结果落地失败：${error.message}；用 download --task-id ${taskId} --out-dir DIR 重试，无需重新生成`);
  }
};

const resolveOut = (ctx: Ctx, a: GenerateArgs): string => ctx.rt.path.resolve(ctx.rt.cwd, a.outDir as string);

// ---------------- the command ----------------
export const cmdGenerate = async (ctx: Ctx, a: GenerateArgs): Promise<JsonRecord> => {
  if (!a.confirm)
    throw new CliReject(3, '未明确确认：宿主须先展示报价并取得明确费用授权，用户明确授权覆盖此请求后，携带 --quote-id 与 --confirm 调用；本次不提交、不扣费');
  const { record, path: qpath } = await loadQuote(ctx, a.quoteId);
  // The ledger is consulted first: whatever the record says, one quote id is submitted at most once.
  const ledgerPath = ledgerPathOf(ctx);
  const existing = await ledger.get(ctx.rt, ledgerPath, a.quoteId);
  if (existing) throw new CliReject(1, `quote ${a.quoteId} 在 ledger 中为 ${String(existing.state)}，禁止重复调用`);
  checkUsable(ctx, record, a.quoteId);
  const bound = await bindRequest(ctx, a, record);
  if (ctx.g.dryRun) return dryRunPlan(ctx, a, record, bound);
  // Checked before the paid request, where Python only found out afterwards that nothing could be saved.
  if (!a.outDir) throw new CliReject(2, 'generate 需要 --out-dir 落地素材');
  const name = record.provider;
  const pcfg = providerConfig(ctx.cfg, name);
  const binding = endpointBinding(ctx.rt, name, pcfg);
  if (binding !== record.endpointBinding || binding !== record.pricingSnapshot.endpointBinding) throw new CliReject(1, '端点/账户绑定与 quote 不符（配置已变更），拒绝并重新 quote');
  const prov = makeProvider(ctx, name);
  const priced = await recheckPrice(ctx, a, record, prov, bound.refs);
  const count = Number(record.count);
  const cap = creditCap(ctx.cfg, name, pcfg);
  if (priced.total && priced.unit && cap && priced.total.compare(cap) > 0) throw new CliReject(1, `单请求总积分 ${priced.total} = ${priced.unit}×${count} 超过硬顶 ${cap}，拒绝`);
  const payload: QuotePayload = { provider: name, model: record.model, prompt: bound.prompt, aspect: record.aspect, count, refs: bound.refs, pricingSnapshot: record.pricingSnapshot };
  const rh = requestHash(payload);
  if (rh !== record.requestHash) throw new CliReject(1, 'requestHash 与 quote 不符，拒绝');
  const meta: JsonRecord = { model: record.model, aspect: record.aspect, count };
  if (priced.options) Object.assign(meta, { idempotencyKey: priced.options.idempotencyKey, maxCredits: priced.options.maxCredits });
  await ledger.reserve(ctx.rt, ledgerPath, a.quoteId, rh, name, meta);
  const submitted = await submitReserved(ctx, ledgerPath, record, prov, bound, priced.options);
  const materials = await finish(ctx, a, ledgerPath, record, qpath, prov, submitted);
  return summary(a, ledgerPath, record, submitted, materials, priced, count);
};

const summary = (a: GenerateArgs, ledgerPath: string, record: QuoteRecord, submitted: JsonRecord, materials: JsonRecord[], priced: Rechecked, count: number): JsonRecord => {
  const out: JsonRecord = {
    ok: true,
    quoteId: a.quoteId,
    taskId: submitted.taskId,
    materials,
    billing: {
      unitAmount: priced.unit ? String(priced.unit) : null,
      count,
      totalAmount: priced.total ? String(priced.total) : null,
      unit: record.pricingSnapshot.billingUnit ?? 'credits',
      priceStatus: priced.unit === null ? 'unknown' : 'quoted',
      charged: true,
      actualCredits: submitted.costCredits ?? null,
      balance: submitted.balance ?? null,
      note: '实际扣费以服务端返回 costCredits 为准',
      ...priced.extraBilling,
    },
    ledger: ledgerPath,
  };
  if (submitted.idempotencyKey) out.idempotencyKey = submitted.idempotencyKey;
  if (submitted.taskRecord) out.taskRecord = submitted.taskRecord;
  return out;
};
