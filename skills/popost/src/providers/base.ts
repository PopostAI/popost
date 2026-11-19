/**
 * Image provider protocol (port of providers/base.py): capabilities, pricing, submission, status and materialization.
 * Local references are hashed; an ambiguous submission never retries automatically.
 */
import type { Runtime } from '../runtime';
import { sha256File } from '../core/util';
import { ImageProviderError } from './errors';
import { timeoutSignal } from './time';

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A JSON number (Python `isinstance(v, (int, float)) and not bool`). */
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

export interface Ref {
  kind: string;
  value: string;
  sha256: string | null;
}

/** One row of a live model list. `credits` is the unit price in the provider's own unit; `null` means unknown. */
export interface ModelRow {
  value: string;
  label: string;
  credits: number | string | null | undefined;
  known: boolean;
  free?: boolean;
  aspectRatios?: string[];
  maxReferenceImages?: number;
  maxImagesPerRequest?: number;
  isDefault?: boolean;
  description?: string;
}

/** Submission parameters bound by the caller (idempotency key, confirmed total); providers that do not know them ignore them. */
export interface SubmitOptions {
  idempotencyKey?: string;
  maxCredits?: string | null;
}

/** What `submit` takes besides the prompt; `aspect` defaults to `1:1` and `count` to 1. */
export interface SubmitRequest {
  aspect?: string;
  refs?: readonly unknown[] | null;
  model?: string | null;
  count?: number;
  options?: SubmitOptions;
}

export interface ProviderInit {
  config?: JsonRecord;
  dryRun?: boolean;
  mock?: boolean;
  mockDir?: string | null;
}

export type CheckResult = readonly [ok: boolean, measured: boolean, message: string];

const isUrl = (text: string) => text.startsWith('http://') || text.startsWith('https://');

/** Strings or `{kind, value, sha256}` objects as an ordered list of refs, keeping the given order. */
export const normalizeRefs = (refs: readonly unknown[] | null | undefined): Ref[] =>
  (refs ?? []).map((ref): Ref => {
    if (typeof ref === 'string') return { kind: isUrl(ref) ? 'url' : 'local', value: ref, sha256: null };
    if (isRecord(ref)) {
      const value = ref.value as string;
      const kind = (ref.kind as string | undefined) || (isUrl(String(ref.value ?? '')) ? 'url' : 'local');
      return { kind, value, sha256: (ref.sha256 as string | null | undefined) ?? null };
    }
    throw new ImageProviderError(`非法参考图条目: ${JSON.stringify(ref)}`);
  });

/** Python `urllib.request.url2pathname` on a posix `file://` URL tail. */
const fileUrlPath = (url: string): string => decodeURIComponent(url.slice(7));

/** http(s) download; `file://` only copies a local file (self tests, no network); other schemes are refused. */
export const downloadUrl = async (rt: Runtime, url: string, dest: string, timeoutSec = 120): Promise<void> => {
  if (url.startsWith('file://')) {
    await rt.fs.writeFile(dest, await rt.fs.readFile(fileUrlPath(url)));
    return;
  }
  if (!isUrl(url)) throw new ImageProviderError(`不支持直接下载的引用协议: ${url.split('://')[0]}`);
  const signal = timeoutSignal(rt, timeoutSec * 1000);
  const response = await rt.fetch(url, { headers: { 'User-Agent': 'social-post-studio/1.0' }, signal });
  if (!response.ok) throw new ImageProviderError(`下载失败 HTTP ${response.status}`);
  await rt.fs.writeFile(dest, new Uint8Array(await response.arrayBuffer()));
};

export { sha256File };

/** Abstract image provider. Non-generative ones (manual, host) only implement `check` / `inventory`. */
export abstract class BaseImageProvider {
  abstract readonly name: string;
  readonly generative: boolean = true;
  defaultModel: string | null = null;
  readonly refLimit: number = 5;
  aspects: readonly string[] = ['1:1', '16:9', '9:16'];
  config: JsonRecord;
  dryRun: boolean;
  readonly mock: boolean;
  readonly mockDir: string | null;

  constructor(
    readonly rt: Runtime,
    init: ProviderInit = {},
  ) {
    this.config = init.config ?? {};
    this.dryRun = Boolean(init.dryRun);
    this.mock = Boolean(init.mock);
    this.mockDir = init.mockDir ?? null;
  }

  /** `[{value,label,credits,known}]`; prices are read live. */
  abstract models(): Promise<ModelRow[]>;
  /** Preflight: `[ok, measured, message]`, never prints credentials. */
  abstract check(): Promise<CheckResult>;

  async modelCredits(model: string): Promise<number | string> {
    const row = (await this.models()).find((r) => r.value === model);
    if (!row) throw new ImageProviderError(`模型 ${model} 不在 ${this.name} 实时清单中`);
    if (row.credits === null || row.credits === undefined) throw new ImageProviderError(`模型 ${model} 价格未知（无实时报价）`);
    return row.credits;
  }

  /**
   * The quote-time model gate: lets everything through by default; paid, locked channels override it with the same
   * allow-list the submission uses, so a quote that passes cannot be refused at confirm time.
   */
  async resolveQuotedModel(model: string | null | undefined): Promise<string | null> {
    return model || this.defaultModel;
  }

  async submit(_prompt: string, _request: SubmitRequest = {}): Promise<JsonRecord> {
    throw new ImageProviderError(`${this.name} 不支持提交`);
  }
  async status(_taskId: string): Promise<JsonRecord> {
    throw new ImageProviderError(`${this.name} 不支持状态查询`);
  }
  async result(_taskId: string): Promise<string[]> {
    throw new ImageProviderError(`${this.name} 不支持结果查询`);
  }
  async materialize(_taskId: string, _outDir: string, _filename?: string): Promise<JsonRecord[]> {
    throw new ImageProviderError(`${this.name} 不支持结果落地`);
  }
  /** Polls until the task completes or fails; only providers that submit asynchronously have it. */
  wait?(taskId: string, intervalSec: number, timeoutSec: number): Promise<JsonRecord>;

  /** Shared argument checks of the BYOK channel. */
  validateSubmitArgs(prompt: string, aspect: string, refs: readonly unknown[] | null | undefined, count: number | null | undefined) {
    if (!prompt || !prompt.trim()) throw new ImageProviderError('prompt 为空');
    if (!this.aspects.includes(aspect)) throw new ImageProviderError(`不支持的画幅 ${aspect}（可选 ${this.aspects.join('/')}）`);
    const list = normalizeRefs(refs);
    if (list.length > this.refLimit) throw new ImageProviderError(`参考图数量 ${list.length} 超过上限 ${this.refLimit}`);
    const n = Math.trunc(Number(count || 1));
    if (n < 1) throw new ImageProviderError('count 必须 >=1');
    return { refs: list, count: n };
  }
}
