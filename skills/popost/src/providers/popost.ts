/**
 * The built-in paid provider: the popost.ai platform OpenAPI (port of providers/popost.py).
 *
 * - `GET /models?kind=image` is the live model list with unit prices (`creditsPerImage`) and capabilities;
 * - `POST /images/quote` is a free quote `{model, n, creditsPerImage, totalCredits, balance, sufficient}`;
 * - `POST /images/generations` generates synchronously and answers with the images (base64 or https URL).
 *
 * The default model is never hard-coded: private config `defaultModel` > the platform's `isDefault` model > no `model`
 * (the platform decides and the quote binds its choice). Once a default is known, another model needs an explicit
 * `providerOverrides` entry; quote and submit apply the same rule.
 *
 * The synchronous endpoint is adapted to the async protocol: `submit` sends the POST (with the idempotency key and the
 * confirmed total `maxCredits`), saves the images into a local task record and returns `completed`.
 */
import { createHash } from 'node:crypto';
import type { Runtime } from '../runtime';
import { stamp } from './time';
import { DEFAULT_KEY_ENV, PopostClient, sniffImageMime } from './api';
import { BaseImageProvider, isInt, isNumber, isRecord, normalizeRefs, type CheckResult, type JsonRecord, type ModelRow, type ProviderInit, type Ref, type SubmitRequest } from './base';
import { AmbiguousSubmitError, CapabilityError, ImageProviderError, PopostApiError } from './errors';
import { defaultTaskDir, staticMockDir } from './paths';
import { PopostMock, TaskStore } from './popost-tasks';
import { validateRequest } from './popost-validate';

export const PROVIDER_NAME = 'popost';
const MAX_PROMPT_CHARS = 32000;
/**
 * How long a generation request is waited for, in seconds; private config `generationTimeoutSec` overrides it. The platform
 * answers only when the picture is done: a request may first wait up to 180 s for a free generation slot, then run up to
 * 360 s of upstream attempts, then save and settle (about 570 s together), and the platform cuts a request off at 600 s
 * (refunding it). Giving up earlier leaves a generation that goes on, succeeds and charges for a picture nobody received.
 * So the default is that 600 s plus a minute for the answer to arrive; it is long only in the rare worst case, a normal
 * generation answers in well under two minutes.
 */
export const GENERATION_TIMEOUT_SEC = 660;
const DEFAULT_TIMEOUT_SEC = 60;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._-]{8,128}$/;
const SECRET_FIELDS = ['apiKey', 'api_key', 'key', 'token', 'secret', 'bearer'];

export interface PopostQuote {
  model: string;
  label: string;
  n: number;
  creditsPerImage: number;
  totalCredits: number;
  balance: number | null;
  sufficient: boolean | null;
  mock: boolean;
}

/** `int` when whole, else `float` (JSON number of a price that was carried as a string). */
const jsonNumber = (value: string | number): number => Number(String(value));

const hex = (rt: Runtime, length: number) => rt.randomUUID().replace(/-/g, '').slice(0, length);

export class PopostProvider extends BaseImageProvider {
  readonly name = PROVIDER_NAME;
  /** Platform credits: the single-request hard cap applies. */
  readonly official = true;
  override readonly refLimit = 10;
  override aspects: readonly string[] = []; // the model's aspectRatios decide
  /** Set by the CLI (`--task-dir`, the quote directory's sibling `tasks/`); config `taskDir` is the fallback. */
  taskDir: string | null;
  private clientInstance: PopostClient | null = null;
  private rows: ModelRow[] | null = null;
  private readonly store: TaskStore;
  private readonly mockState: PopostMock;

  constructor(rt: Runtime, init: ProviderInit = {}) {
    super(rt, init);
    const auth = isRecord(this.config.auth) ? this.config.auth : {};
    for (const field of SECRET_FIELDS)
      if (field in this.config || field in auth) throw new ImageProviderError(`popost 配置里不得写密钥（发现字段 ${field}）：删除该字段，改用 popost auth set 保存密钥（或设置环境变量 ${DEFAULT_KEY_ENV}）`);
    this.taskDir = (this.config.taskDir as string | undefined) || null;
    this.store = new TaskStore(rt, () => this.taskDir || defaultTaskDir(rt));
    this.mockState = new PopostMock(rt, this.mockDir, staticMockDir(rt), this.config.mockModelsPath);
  }

  // ---------- client ----------
  get client(): PopostClient {
    if (!this.clientInstance) {
      const auth = isRecord(this.config.auth) ? this.config.auth : {};
      this.clientInstance = new PopostClient(this.rt, {
        baseUrl: this.config.baseUrl as string | undefined,
        keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV,
        timeoutSec: Number(this.config.timeoutSec || DEFAULT_TIMEOUT_SEC),
      });
    }
    return this.clientInstance;
  }

  // ---------- live model list ----------
  async models(): Promise<ModelRow[]> {
    if (!this.rows) {
      const raw = this.mock ? (await this.mockState.catalog()).models : await this.fetchModels();
      if (!Array.isArray(raw)) throw new PopostApiError('模型清单格式不符（缺 models 数组）', { code: 'BAD_RESPONSE' });
      this.rows = raw.filter((m) => isRecord(m) && m.id && (m.kind ?? 'image') === 'image').map((m) => toRow(m as JsonRecord));
    }
    return this.rows.map((r) => ({ ...r }));
  }

  private async fetchModels(): Promise<unknown> {
    const data = await this.client.request('GET', '/models', { query: { kind: 'image' } });
    return isRecord(data) ? data.models : null;
  }

  private rowFor = async (model: string): Promise<ModelRow | null> => (await this.models()).find((r) => r.value === model) ?? null;

  // ---------- default model and the lock ----------
  pinnedModel = (): string | null => (this.config.defaultModel as string | undefined) || null;
  platformDefault = async (): Promise<string | null> => (await this.models()).find((r) => r.isDefault)?.value ?? null;

  private overridden(model: string): boolean {
    const list = Array.isArray(this.config.providerOverrides) ? this.config.providerOverrides : [];
    return list.some((o) => isRecord(o) && o.model === model && (o.provider ?? PROVIDER_NAME) === PROVIDER_NAME);
  }

  /**
   * The model actually used (`null`: let the platform decide). Once a default is known, switching needs an explicit
   * override. `offline` judges by private config only (dry-run, re-checking a confirmed quote): no platform lookup.
   */
  private async resolveModel(model: string | null | undefined, offline = false): Promise<string | null> {
    let fallback = this.pinnedModel();
    if (fallback === null && !offline) fallback = await this.platformDefault();
    if (!model) return fallback;
    if (fallback === null || model === fallback || this.overridden(model)) return model;
    throw new ImageProviderError(`默认模型锁定为 ${fallback}：换成 ${model} 需要用户在私有配置 providerOverrides 中显式加入 {"provider": "popost", "model": "${model}"}`);
  }

  override resolveQuotedModel(model: string | null | undefined): Promise<string | null> {
    return this.resolveModel(model, this.dryRun);
  }

  // ---------- quote (free, never charges) ----------
  /** `recheck`: re-verifying a confirmed quote; the model lock then follows private config only, not platform drift. */
  async quote(request: { model?: string | null; aspect?: string; count?: number; refs?: readonly unknown[] | null; recheck?: boolean } = {}): Promise<PopostQuote | JsonRecord> {
    const { aspect = '1:1', recheck = false } = request;
    const refs = normalizeRefs(request.refs);
    const count = Math.trunc(Number(request.count || 1));
    const model = await this.resolveModel(request.model, this.dryRun || recheck);
    const body: JsonRecord = { n: count, aspectRatio: aspect, referenceImageCount: refs.length };
    if (model) body.model = model;
    if (this.dryRun) {
      await validateRequest(this.rt, null, aspect, count, refs);
      return { dryRun: true, model, request: this.client.describeRequest('POST', '/images/quote', body) };
    }
    let row: ModelRow | null = null;
    if (model) {
      row = await this.rowFor(model);
      if (!row) throw new ImageProviderError(`模型 ${model} 不在 popost.ai 实时清单（popost provider cli models 查看）`);
    }
    await validateRequest(this.rt, row, aspect, count, refs);
    const data = this.mock ? await this.mockQuote(model, count) : await this.client.request('POST', '/images/quote', { body });
    return this.quoteFrom(data, model, row, aspect, count, refs);
  }

  private async quoteFrom(data: unknown, model: string | null, row: ModelRow | null, aspect: string, count: number, refs: Ref[]): Promise<PopostQuote> {
    if (!isRecord(data) || !isNumber(data.creditsPerImage) || !isNumber(data.totalCredits)) throw new PopostApiError('报价响应缺少 creditsPerImage/totalCredits', { code: 'BAD_RESPONSE' });
    const quoted = (data.model as string | undefined) || model;
    if (!quoted) throw new PopostApiError('报价响应未给出模型', { code: 'BAD_RESPONSE' });
    if (model && quoted !== model) throw new ImageProviderError(`平台报价模型 ${quoted} 与请求模型 ${model} 不一致，拒绝`);
    let chosen = row;
    if (!model) {
      chosen = await this.rowFor(quoted);
      await validateRequest(this.rt, chosen, aspect, count, refs);
    }
    return {
      model: quoted,
      label: chosen?.label || quoted,
      n: count,
      creditsPerImage: data.creditsPerImage,
      totalCredits: data.totalCredits,
      balance: isNumber(data.balance) ? data.balance : null,
      sufficient: typeof data.sufficient === 'boolean' ? data.sufficient : null,
      mock: this.mock,
    };
  }

  private async mockQuote(model: string | null, count: number): Promise<JsonRecord> {
    const chosen = model || (await this.platformDefault()) || (await this.models())[0]?.value || null;
    const unit = (chosen ? await this.rowFor(chosen) : null)?.credits;
    const balance = Number((await this.mockState.catalog()).mockBalance ?? 1000);
    const total = typeof unit === 'number' ? unit * count : null;
    return { model: chosen, n: count, creditsPerImage: unit, totalCredits: total, balance, sufficient: total !== null && balance >= total };
  }

  // ---------- submit (synchronous generation) ----------
  override async submit(prompt: string, request: SubmitRequest = {}): Promise<JsonRecord> {
    const { aspect = '1:1', options = {} } = request;
    if (!prompt || !prompt.trim()) throw new ImageProviderError('prompt 为空');
    if ([...prompt].length > MAX_PROMPT_CHARS) throw new CapabilityError(`prompt 超过 ${MAX_PROMPT_CHARS} 字符上限`);
    const model = await this.resolveModel(request.model, true);
    const refs = normalizeRefs(request.refs);
    const count = Math.trunc(Number(request.count || 1));
    const idem = options.idempotencyKey || `skill-${this.rt.randomUUID().replace(/-/g, '')}`;
    if (!IDEMPOTENCY_RE.test(idem)) throw new ImageProviderError('idempotencyKey 须为 8–128 位字母、数字或 . _ -');
    const body: JsonRecord = { prompt, n: count, aspectRatio: aspect, idempotencyKey: idem };
    if (model) body.model = model;
    if (options.maxCredits !== null && options.maxCredits !== undefined) body.maxCredits = jsonNumber(options.maxCredits);
    if (this.dryRun) return this.dryRunPlan(body, model, aspect, count, refs, idem);
    if (this.mock) return this.mockSubmit(prompt, aspect, model, count, refs, idem);
    return this.send(body, model, aspect, count, refs, idem);
  }

  private async dryRunPlan(body: JsonRecord, model: string | null, aspect: string, count: number, refs: Ref[], idem: string): Promise<JsonRecord> {
    await validateRequest(this.rt, null, aspect, count, refs);
    if (refs.length) body.referenceImages = await Promise.all(refs.map((r) => this.refPreview(r)));
    return { taskId: null, status: 'dry-run', dryRun: true, model, aspect, count, idempotencyKey: idem, request: this.client.describeRequest('POST', '/images/generations', body) };
  }

  private async mockSubmit(prompt: string, aspect: string, model: string | null, count: number, refs: Ref[], idem: string): Promise<JsonRecord> {
    const row = model ? await this.rowFor(model) : null;
    await validateRequest(this.rt, row, aspect, count, refs);
    const chosen = model || (await this.platformDefault());
    const credits = (chosen ? await this.rowFor(chosen) : null)?.credits;
    return this.mockState.submit(prompt, aspect, chosen, count, idem, typeof credits === 'number' ? credits : null);
  }

  private async send(body: JsonRecord, model: string | null, aspect: string, count: number, refs: Ref[], idem: string): Promise<JsonRecord> {
    let row: ModelRow | null = null;
    if (model) {
      row = await this.rowFor(model);
      if (!row) throw new ImageProviderError(`模型 ${model} 已不在 popost.ai 实时清单，未提交`);
    }
    await validateRequest(this.rt, row, aspect, count, refs);
    if (refs.length) body.referenceImages = await this.encodeRefs(refs);
    const taskId = `pt-${stamp(this.rt.now())}-${hex(this.rt, 10)}`;
    const root = await this.store.prepare(taskId); // a result that cannot be saved is found out before paying
    const hint = `禁止自动重试；请先在 popost.ai 账户核对生成记录。如需重试：重新 quote 后 image run（沿用原键）或 provider cli generate 加 --idempotency-key ${idem}，平台不会对同一生成重复扣费`;
    let data: unknown;
    try {
      data = await this.client.request('POST', '/images/generations', { body, timeoutSec: Number(this.config.generationTimeoutSec || GENERATION_TIMEOUT_SEC), ambiguous: true, hint });
    } catch (error) {
      if (!(error instanceof AmbiguousSubmitError)) await this.rt.fs.rm(root); // explicit refusal: nothing was made or charged
      throw error; // an ambiguous one keeps the empty task folder as evidence that the request went out
    }
    const record = await this.saveResult(taskId, root, data, model, aspect, count, idem, hint);
    const usage = isRecord((data as JsonRecord).usage) ? ((data as JsonRecord).usage as JsonRecord) : {};
    const balance = (data as JsonRecord).balance;
    return {
      taskId,
      model: record.model,
      aspect,
      count,
      status: 'completed',
      idempotencyKey: idem,
      costCredits: isNumber(usage.credits) ? usage.credits : null,
      balance: isNumber(balance) ? balance : null,
      images: record.images.length,
      taskRecord: this.store.recordPath(taskId),
    };
  }

  private async saveResult(taskId: string, root: string, data: unknown, model: string | null, aspect: string, count: number, idem: string, hint: string) {
    try {
      return await this.store.store(taskId, root, data, model, aspect, count, idem);
    } catch (error) {
      if (error instanceof AmbiguousSubmitError) throw error;
      const kind = (error as { code?: string })?.code ?? (error as Error)?.name ?? 'Error';
      throw new AmbiguousSubmitError(`生成请求已成功但结果无法保存（${kind}），可能已扣费。${hint}`);
    }
  }

  private async refPreview(ref: Ref): Promise<JsonRecord> {
    if (ref.kind === 'url') return { url: ref.value };
    const stat = await this.rt.fs.stat(ref.value);
    const mime = stat?.isFile ? sniffImageMime((await this.rt.fs.readFile(ref.value)).subarray(0, 16)) : null;
    return { data: `<base64 of ${this.rt.path.basename(ref.value)}, ${stat?.isFile ? stat.size : null} bytes, sha256 ${ref.sha256 || '-'}>`, mimeType: mime };
  }

  /** Local files go inline as base64 (never as paths); a file changed since the quote is refused. */
  private async encodeRefs(refs: readonly Ref[]): Promise<JsonRecord[]> {
    const out: JsonRecord[] = [];
    for (const ref of refs) {
      if (ref.kind === 'url') {
        out.push({ url: ref.value });
        continue;
      }
      const raw = await this.rt.fs.readFile(ref.value);
      if (ref.sha256 && createHash('sha256').update(raw).digest('hex') !== ref.sha256)
        throw new ImageProviderError(`参考图 ${this.rt.path.basename(ref.value)} 在报价后被修改，未提交`);
      out.push({ data: Buffer.from(raw).toString('base64'), mimeType: sniffImageMime(raw.subarray(0, 16)) });
    }
    return out;
  }

  // ---------- status / result / materialize ----------
  override status = (taskId: string): Promise<JsonRecord> => (this.mock ? this.mockState.status(taskId) : this.store.status(taskId));

  override async result(taskId: string): Promise<string[]> {
    if (!this.mock) return this.store.result(taskId);
    const outputs = ((await this.mockState.status(taskId)).outputs as JsonRecord[] | undefined) ?? [];
    return outputs.filter((o) => o.url).map((o) => String(o.url));
  }

  override materialize = (taskId: string, outDir: string, filename?: string): Promise<JsonRecord[]> =>
    this.mock ? this.mockState.materialize(taskId, outDir, filename) : this.store.materialize(taskId, outDir, filename);

  // ---------- preflight ----------
  async check(): Promise<CheckResult> {
    if (this.mock) return this.checkMock();
    if (!this.client.hasKey()) return [false, false, `未配置 API Key：请运行 popost auth login 连接账户；管理连接：${this.client.keyPage()}（环境变量 ${this.client.keyEnv} 同样有效）；未联网`];
    let rows: ModelRow[];
    try {
      rows = await this.models();
    } catch (error) {
      if (error instanceof ImageProviderError) return [false, true, error.message];
      throw error;
    }
    if (!rows.length) return [false, true, 'popost.ai 未返回可用图像模型'];
    const pinned = this.pinnedModel();
    if (pinned && !rows.some((r) => r.value === pinned)) return [false, true, `私有配置 defaultModel=${pinned} 不在 popost.ai 实时清单`];
    const fallback = pinned || (await this.platformDefault());
    return [true, true, `popost.ai 可用：${rows.length} 个图像模型，默认 ${fallback || '由平台决定'}（价格以实时报价为准）`];
  }

  private async checkMock(): Promise<CheckResult> {
    let rows: ModelRow[];
    try {
      rows = await this.models();
    } catch (error) {
      return [false, false, `popost mock 夹具缺失: ${(error as Error).message}`];
    }
    return rows.length ? [true, false, 'popost mock 本地模拟（未联网、未实测、不代表真实连通）'] : [false, false, 'popost mock 清单为空'];
  }
}

/** A platform model as a protocol row: only display and capability fields; vendor and other upstream details are dropped. */
const toRow = (m: JsonRecord): ModelRow => {
  const credits = m.creditsPerImage;
  const row: ModelRow = { value: String(m.id), label: String(m.name || m.id), credits: isNumber(credits) ? credits : null, known: isNumber(credits) };
  if (Array.isArray(m.aspectRatios)) row.aspectRatios = m.aspectRatios.map(String);
  for (const key of ['maxReferenceImages', 'maxImagesPerRequest'] as const) if (isInt(m[key])) row[key] = m[key];
  if (m.isDefault === true) row.isDefault = true;
  if (typeof m.description === 'string' && m.description) row.description = m.description.slice(0, 300);
  return row;
};
