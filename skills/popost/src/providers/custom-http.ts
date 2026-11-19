/**
 * Bring-your-own-key image API adapter (port of providers/custom_http.py). No placeholder successes.
 *
 * Two modes (`config.mode`):
 * 1. `openai-compatible`: `POST {baseUrl}/v1/images/generations` with `Authorization: Bearer <env var>`; the answer's
 *    `data[].url` / `b64_json` come back synchronously, or `asyncTaskPath` points at a task id to poll;
 * 2. `http`: explicit submit / poll / download templates (method, URL, body, field paths).
 *
 * The config only names environment variables (`auth.envVar`); secrets are read at request time and never echoed. A
 * service that is unconfigured, unreachable or has no known price reports unavailable, never "connected".
 */
import { createHash } from 'node:crypto';
import { networkReason } from '../core/error-text';
import { sha256File } from '../core/util';
import { msg } from '../i18n';
import { BaseImageProvider, downloadUrl, isRecord, type CheckResult, type JsonRecord, type ModelRow, type SubmitRequest } from './base';
import { AmbiguousSubmitError, ImageProviderError } from './errors';
import { isHostBlocked } from './api';
import { sleep, timeoutSignal } from './time';
import { customMockModels, fillTemplate, getPath, imageMimeByName, type TemplateValues } from './custom-http-util';

export const PROVIDER_NAME = 'custom';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

interface SyncTask extends JsonRecord {
  status: string;
  urls: string[];
  b64: string[];
}

export class CustomHttpProvider extends BaseImageProvider {
  readonly name = PROVIDER_NAME;
  readonly mode: string;
  private readonly baseUrl: string;
  private readonly syncCache = new Map<string, SyncTask>();

  constructor(...args: ConstructorParameters<typeof BaseImageProvider>) {
    super(...args);
    this.mode = (this.config.mode as string | undefined) || 'openai-compatible';
    if (!['openai-compatible', 'http'].includes(this.mode)) throw new ImageProviderError(msg('custom.mode must be openai-compatible or http', 'custom.mode 仅支持 openai-compatible | http'));
    this.baseUrl = String(this.config.baseUrl || '').replace(/\/+$/, '');
  }

  private section = (name: string): JsonRecord => (isRecord(this.config[name]) ? (this.config[name] as JsonRecord) : {});

  // ---------- secrets (read, never echoed) ----------
  /** Secret values this channel may send; error texts are scrubbed of them before they are shown or written down. */
  private secretValues(): string[] {
    const names = [this.section('auth').envVar];
    for (const part of ['submit', 'poll']) {
      const headers = this.section('http')[part];
      if (isRecord(headers) && isRecord(headers.headers))
        for (const value of Object.values(headers.headers)) if (typeof value === 'string' && value.startsWith('$env:')) names.push(value.slice(5));
    }
    return names.map((name) => (typeof name === 'string' ? this.rt.env[name] : undefined)).filter((v): v is string => typeof v === 'string' && v.length >= 6);
  }

  private redact(text: string): string {
    return this.secretValues().reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
  }

  private authHeaders(extra?: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const auth = this.section('auth');
    const envVar = auth.envVar as string | undefined;
    if (envVar) {
      const secret = this.rt.env[envVar];
      if (secret === undefined)
        throw new ImageProviderError(
          msg(
            `the environment variable ${envVar} is not set (keys are read only from environment variables, never from the config)`,
            `环境变量 ${envVar} 未设置（密钥只走环境变量，不写入配置）`,
          ),
        );
      const scheme = auth.scheme === undefined ? 'Bearer' : auth.scheme ? String(auth.scheme) : '';
      headers[String(auth.header ?? 'Authorization')] = scheme ? `${scheme} ${secret}` : secret;
    }
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (typeof value === 'string' && value.startsWith('$env:')) {
        const secret = this.rt.env[value.slice(5)];
        if (secret === undefined) throw new ImageProviderError(msg(`the environment variable ${value.slice(5)} is not set`, `环境变量 ${value.slice(5)} 未设置`));
        headers[name] = secret;
      } else headers[name] = String(value);
    }
    return headers;
  }

  // ---------- live prices ----------
  async models(): Promise<ModelRow[]> {
    const credits = this.config.creditsPerRequest as number | undefined;
    const model = this.config.model as string | undefined;
    if (model && this.config.skipModelDiscovery) return [{ value: model, label: model, credits: credits ?? null, known: credits !== undefined && credits !== null }];
    if (this.mock) return customMockModels(this.rt, this.config.mockModelsPath, this.mockDir);
    if (this.mode === 'openai-compatible') return this.discoverModels();
    if (!model) throw new ImageProviderError(msg('the custom.http config has no model', 'custom.http 配置缺少 model'));
    return [{ value: model, label: model, credits: credits ?? null, known: credits !== undefined && credits !== null }];
  }

  private async discoverModels(): Promise<ModelRow[]> {
    let data: unknown;
    const url = `${this.baseUrl}/v1/models`;
    try {
      const response = await this.rt.fetch(url, { method: 'GET', headers: this.authHeaders(), signal: timeoutSignal(this.rt, 30_000) });
      if (!response.ok)
        throw new ImageProviderError(msg(`GET /v1/models was refused (HTTP ${response.status}); nothing was charged`, `GET /v1/models 被拒绝(${response.status})，未产生费用`));
      data = await response.json();
    } catch (error) {
      if (error instanceof ImageProviderError) throw error;
      const reason = error instanceof SyntaxError ? msg('the answer is not JSON', '响应不是 JSON') : this.redact(networkReason(error, url));
      throw new ImageProviderError(msg(`GET /v1/models failed: ${reason}`, `GET /v1/models 不可达: ${reason}`));
    }
    const items = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    return items.filter((i): i is JsonRecord => isRecord(i) && Boolean(i.id)).map((item) => {
      const credits = item.credits ?? item.price ?? this.config.creditsPerRequest;
      return { value: String(item.id), label: String(item.id), credits: (credits as number | undefined) ?? null, known: credits !== undefined && credits !== null };
    });
  }

  async check(): Promise<CheckResult> {
    if (this.mock) return [true, false, msg('custom mock mode (offline; the connection was not tested)', 'custom mock 模式（不联网，未实测连通）')];
    if (!this.baseUrl) return [false, false, msg('custom.baseUrl is not configured (no own-key service is set up)', 'custom.baseUrl 未配置（BYOK 未设置）')];
    let rows: ModelRow[];
    try {
      rows = await this.models();
    } catch (error) {
      if (error instanceof ImageProviderError) return [false, true, error.message];
      throw error;
    }
    if (this.mode === 'http' && !this.section('http').submit) return [false, true, msg('custom.http.submit is not configured', 'custom.http.submit 未配置')];
    const known = rows.filter((r) => r.known);
    if (!known.length)
      return [
        rows.length > 0,
        true,
        msg("custom lists models but their prices are unknown: a submit needs explicit acceptance of the provider's charges", 'custom 可列出模型；价格未知，需显式接受供应商费用后才能提交'),
      ];
    return [true, true, msg(`custom (${this.mode}) config is readable; ${known.length} model(s) with a known price`, `custom(${this.mode}) 配置可读，已知模型 ${known.length} 个`)];
  }

  // ---------- HTTP ----------
  /** A 4xx is a refusal (no order made); a 5xx, a network error or a timeout leaves the order's state unknown. */
  private async call(method: string, url: string, body?: unknown, headers?: Record<string, unknown>, timeoutSec = 120): Promise<JsonRecord> {
    try {
      new URL(url);
    } catch {
      throw new ImageProviderError(msg(`invalid request URL (a local config error; nothing was sent): ${url}`, `请求 URL 非法（本地配置错误，未发请求）: ${url}`));
    }
    let response: Response;
    try {
      response = await this.rt.fetch(url, { method, headers: this.authHeaders(headers), body: body === undefined ? undefined : JSON.stringify(body), signal: timeoutSignal(this.rt, timeoutSec * 1000) });
    } catch (error) {
      // A host that refuses the URL never sent anything: a plain refusal, not an unknown outcome.
      if (isHostBlocked(error))
        throw new ImageProviderError(msg(`this environment does not allow connections to ${hostOf(url)}; nothing was sent`, `当前运行环境不允许访问该地址，未发请求（${hostOf(url)}）`));
      const reason = this.redact(networkReason(error, url));
      throw new AmbiguousSubmitError(
        msg(
          `network error or timeout (${reason}): whether the order was accepted is unknown; do not retry automatically`,
          `网络错误/超时(${reason})，受理状态不确定，禁止自动重试`,
        ),
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400 && response.status < 500)
        throw new ImageProviderError(msg(`refused with HTTP ${response.status} (no order was created)`, `HTTP ${response.status} 被拒绝（未建单）`));
      throw new AmbiguousSubmitError(
        msg(`HTTP ${response.status}: whether the order was accepted is unknown; do not retry automatically`, `HTTP ${response.status}，受理状态不确定，禁止自动重试`),
      );
    }
    const text = await response.text();
    try {
      return text.trim() ? (JSON.parse(text) as JsonRecord) : {};
    } catch {
      throw new AmbiguousSubmitError(
        msg('the answer is not valid JSON: whether the order was accepted is unknown; do not retry automatically', '响应不是合法 JSON，受理状态不确定，禁止自动重试'),
      );
    }
  }

  // ---------- submit ----------
  override async submit(prompt: string, request: SubmitRequest = {}): Promise<JsonRecord> {
    const { aspect = '1:1' } = request;
    const capabilities = this.section('capabilities');
    this.aspects = Array.isArray(capabilities.aspects) ? (capabilities.aspects as string[]) : this.aspects;
    const { refs, count } = this.validateSubmitArgs(prompt, aspect, request.refs, request.count);
    if (refs.length && !capabilities.referenceImages)
      throw new ImageProviderError(
        msg(
          'custom profile does not declare referenceImages support; configure its actual image-edit transport',
          'custom 配置未声明支持 referenceImages；请配置它实际的改图传输方式',
        ),
      );
    const model = request.model || (this.config.model as string | undefined);
    if (!model) throw new ImageProviderError(msg('no model is set for custom', 'custom 未指定 model'));
    const values: TemplateValues = { prompt, model, aspect, count, refs: JSON.stringify(refs.map((r) => r.value)), baseUrl: this.baseUrl };
    if (this.dryRun) return this.dryRunPlan(values);
    if (this.mock) return this.mockSubmit(aspect, model, count);
    return this.mode === 'openai-compatible' ? this.ocSubmit(values) : this.httpSubmit(values);
  }

  private async dryRunPlan(values: TemplateValues): Promise<JsonRecord> {
    if (this.mode === 'openai-compatible') {
      const body = await this.ocBody(values);
      return { taskId: null, status: 'dry-run', dryRun: true, request: { method: 'POST', url: `${this.baseUrl}/v1/images/generations`, body } };
    }
    const cfg = this.submitTemplate();
    return { taskId: null, status: 'dry-run', dryRun: true, request: { method: (cfg.method as string) || 'POST', url: fillTemplate(cfg.url, values), body: fillTemplate(cfg.body, values) } };
  }

  private submitTemplate(): JsonRecord {
    const cfg = this.section('http').submit;
    if (!isRecord(cfg)) throw new ImageProviderError(msg('custom.http.submit is not configured', 'custom.http.submit 未配置'));
    return cfg;
  }

  private sizeOf = (aspect: string): string => String(this.section('sizeMap')[aspect] ?? aspect);

  /** Local references travel only as data URIs (their content), never as filesystem paths. */
  private async ocBody(values: TemplateValues): Promise<JsonRecord> {
    const body: JsonRecord = { model: values.model, prompt: values.prompt, n: values.count, size: this.sizeOf(values.aspect) };
    const refs = JSON.parse(values.refs) as string[];
    if (!refs.length) return body;
    const transport = (this.config.referenceTransport as string | undefined) ?? 'data-uri';
    body.image = await Promise.all(
      refs.map(async (ref) => {
        if (!(await this.rt.fs.stat(ref))?.isFile) return ref;
        if (transport !== 'data-uri')
          throw new ImageProviderError(
            msg('Local reference requires a supported upload/data-uri adapter, never a filesystem path', '本地参考图需要受支持的上传 / data-uri 方式，不能直接传文件路径'),
          );
        return `data:${imageMimeByName(ref)};base64,${Buffer.from(await this.rt.fs.readFile(ref)).toString('base64')}`;
      }),
    );
    return body;
  }

  private async ocSubmit(values: TemplateValues): Promise<JsonRecord> {
    const data = await this.call('POST', `${this.baseUrl}/v1/images/generations`, await this.ocBody(values));
    const asyncPath = this.config.asyncTaskPath as string | undefined;
    const { model, aspect, count } = values;
    if (asyncPath) {
      const taskId = getPath(data, asyncPath);
      if (!taskId) throw new AmbiguousSubmitError(msg(`the async answer has no taskId at ${asyncPath}; the state is unknown`, `异步响应缺少 taskId 字段 ${asyncPath}，状态不确定`));
      return { taskId, model, aspect, count, status: 'running', raw: data };
    }
    const items = Array.isArray(data.data) ? data.data.filter(isRecord) : [];
    if (!items.length) throw new AmbiguousSubmitError(msg('the synchronous answer has no data items; the outcome is unknown', '同步响应无 data 项，结果不确定'));
    const taskId = `sync-${createHash('sha256').update(values.prompt + model + aspect).digest('hex').slice(0, 12)}`;
    const urls = items.filter((i) => i.url).map((i) => String(i.url));
    const b64 = items.filter((i) => !i.url && i.b64_json).map((i) => String(i.b64_json));
    this.syncCache.set(taskId, { status: 'completed', urls, b64 });
    return { taskId, model, aspect, count, status: 'completed' };
  }

  private async httpSubmit(values: TemplateValues): Promise<JsonRecord> {
    const cfg = this.submitTemplate();
    const data = await this.call((cfg.method as string) || 'POST', String(fillTemplate(cfg.url, values)), fillTemplate(cfg.body, values), cfg.headers as Record<string, unknown>);
    const taskId = getPath(data, (cfg.taskIdPath as string) || 'data.task_id');
    if (!taskId)
      throw new AmbiguousSubmitError(
        msg(
          `the submit answer has no taskId (${String(cfg.taskIdPath)}); the state is unknown, do not retry automatically`,
          `提交响应缺少 taskId(${String(cfg.taskIdPath)})，状态不确定，禁止自动重试`,
        ),
      );
    return { taskId: String(taskId), status: 'running', raw: data };
  }

  // ---------- mock ----------
  private mockFile = (): string => this.rt.path.join(this.mockDir ?? '', 'mock_tasks.json');

  private async mockTasks(): Promise<JsonRecord[]> {
    return (await this.rt.fs.stat(this.mockFile()))?.isFile ? (JSON.parse(await this.rt.fs.readText(this.mockFile())) as JsonRecord[]) : [];
  }

  private async mockSubmit(aspect: string, model: string, count: number): Promise<JsonRecord> {
    const tasks = await this.mockTasks();
    const taskId = `mock-task-${tasks.length + 1}`;
    tasks.push({ taskId, status: 'running', model, aspect, count });
    await this.rt.fs.writeFile(this.mockFile(), JSON.stringify(tasks, null, 1));
    return { taskId, status: 'running', mock: true };
  }

  /** A mock task is "running" until first polled, then completes. */
  private async mockStatus(taskId: string): Promise<JsonRecord> {
    const tasks = await this.mockTasks();
    const task = tasks.find((t) => t.taskId === taskId);
    if (!task) return { taskId, status: 'running', mock: true };
    if (task.status === 'running') {
      task.status = 'completed';
      task.outputs = [{ url: 'mock://mock_result.png' }];
      await this.rt.fs.writeFile(this.mockFile(), JSON.stringify(tasks, null, 1));
    }
    return { ...task };
  }

  // ---------- polling (existing ids only) ----------
  override async status(taskId: string): Promise<JsonRecord> {
    if (this.mock) return this.mockStatus(taskId);
    const cached = this.syncCache.get(taskId);
    if (cached) return { ...cached };
    const cfg = this.section('http').poll;
    if (!isRecord(cfg)) throw new ImageProviderError(msg('custom has no poll config (required unless the mode is synchronous)', 'custom 未配置 poll（非同步模式必须配置）'));
    const data = await this.call((cfg.method as string) || 'GET', String(fillTemplate(cfg.url, { taskId, baseUrl: this.baseUrl })), undefined, cfg.headers as Record<string, unknown>, 60);
    const value = String(getPath(data, (cfg.statusPath as string) || 'data.status') || '').toLowerCase();
    const listed = (key: string, fallback: string[]) => (Array.isArray(cfg[key]) ? (cfg[key] as unknown[]) : fallback).map((x) => String(x).toLowerCase());
    if (listed('doneValues', ['succeeded', 'completed']).includes(value)) return { taskId, status: 'completed', raw: data };
    if (listed('failValues', ['failed', 'error']).includes(value)) return { taskId, status: 'failed', raw: data };
    return { taskId, status: 'running', raw: data };
  }

  override wait = async (taskId: string, intervalSec = 2, timeoutSec = 300): Promise<JsonRecord> => {
    const deadline = this.rt.now().getTime() + timeoutSec * 1000;
    while (this.rt.now().getTime() < deadline) {
      const data = await this.status(taskId);
      if (data.status === 'completed' || data.status === 'failed') return data;
      await sleep(this.rt, Math.max(intervalSec, 0) * 1000);
    }
    throw new ImageProviderError(msg(`polling timed out: task ${taskId} did not finish within ${timeoutSec}s`, `轮询超时：任务 ${taskId} 未在 ${timeoutSec}s 内完成`));
  };

  override async result(taskId: string): Promise<string[]> {
    const data = await this.status(taskId);
    if (data.status !== 'completed')
      throw new ImageProviderError(msg(`task ${taskId} is not completed (status: ${String(data.status)})`, `任务 ${taskId} 未 completed（当前 ${String(data.status)}）`));
    const outputs = Array.isArray(data.outputs) ? (data.outputs as JsonRecord[]) : [];
    const urls = Array.isArray(data.urls) && data.urls.length ? (data.urls as string[]) : outputs.filter((o) => o.url).map((o) => String(o.url));
    if (!urls.length && this.mode === 'http') {
      const download = isRecord(this.section('http').download) ? (this.section('http').download as JsonRecord) : {};
      const url = getPath(isRecord(data.raw) ? data.raw : {}, (download.urlPath as string) || 'data.result_url');
      if (url) urls.push(String(url));
    }
    if (!urls.length && !(Array.isArray(data.b64) && data.b64.length))
      throw new ImageProviderError(msg(`task ${taskId} is completed but has no result`, `任务 ${taskId} completed 但无结果`));
    return urls;
  }

  override async materialize(taskId: string, outDir: string, filename?: string): Promise<JsonRecord[]> {
    const data = await this.status(taskId);
    await this.rt.fs.mkdir(outDir);
    const target = (i: number) => this.rt.path.join(outDir, filename ?? `${taskId}_${i}.png`);
    const out: JsonRecord[] = [];
    for (const [i, payload] of (Array.isArray(data.b64) ? (data.b64 as string[]) : []).entries()) {
      await this.rt.fs.writeFile(target(i), new Uint8Array(Buffer.from(payload, 'base64')));
      out.push({ url: `b64://${taskId}`, localPath: target(i), sha256: await sha256File(this.rt, target(i)) });
    }
    for (const [i, url] of (await this.result(taskId)).entries()) {
      if (url.startsWith('mock://')) await this.rt.fs.writeFile(target(i), await this.rt.fs.readFile(this.rt.path.join(this.mockDir ?? '', this.rt.path.basename(url))));
      else await downloadUrl(this.rt, url, target(i));
      out.push({ url, localPath: target(i), sha256: await sha256File(this.rt, target(i)) });
    }
    return out;
  }
}
