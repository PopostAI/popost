/**
 * `popost inspiration import`: saves a reference post (PostBundle) to the user's popost.ai inspiration library, the web
 * app's "我的灵感 -> 通过 Skill 导入" (port of inspiration_cli.py).
 *
 * 1. the bundle is validated and mapped to the platform's `ParsedPostInput` (`planImport`);
 * 2. every local image: `POST /uploads` (purpose `inspiration`), then the bytes go to the returned URL as the ticket says
 *    (without Authorization); images that are already https URLs are referenced as they are;
 * 3. `POST /inspirations` with the post and a `clientId` derived from the content, so running the same command again
 *    saves nothing twice.
 *
 * `--dry-run` needs no network and no key. Credentials and base URL are those of the popost channel: `POPOST_API_KEY`
 * (or the variable `popost.auth.envVar` names) and `popost.baseUrl` / `POPOST_BASE_URL`; the key is never printed. When the environment sets neither, the node runtime
 * supplies the values saved by `popost auth set` (`credentials.ts`).
 */
import { createHash } from 'node:crypto';
import { fileErrorText } from '../core/error-text';
import { printJson } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { DEFAULT_KEY_ENV, PopostClient } from './api';
import { isRecord, type JsonRecord } from './base';
import { loadConfig, providerConfig } from './cli-config';
import { AmbiguousSubmitError, CliReject, ImageProviderError, PopostApiError } from './errors';
import { InputError, planImport, type ImportPlan, type PlanImage, type PlanOptions } from './inspiration-plan';
import { resolvePath } from './paths';
import { scrub, secretValues } from './secrets';

/** Local problems (no request was made): exit 2 instead of 1. */
const LOCAL_ERROR_CODES = ['NO_API_KEY', 'BAD_URL', 'BAD_CONFIG', 'TOO_LARGE', 'BAD_ARGS'];

const imagePayload = (entry: PlanImage, url: string): JsonRecord => {
  const out: JsonRecord = { url, mimeType: entry.mimeType };
  for (const key of ['width', 'height', 'alt'] as const) if (entry[key]) out[key] = entry[key];
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null));
};

/** What would be uploaded and sent, with the key shown as `$ENV_NAME`; nothing is sent. */
export const dryRun = (client: PopostClient, plan: ImportPlan): JsonRecord => {
  const uploads: JsonRecord[] = [];
  const images: JsonRecord[] = [];
  for (const entry of plan.images) {
    if (entry.kind === 'local') {
      const body = { fileName: entry.fileName, mimeType: entry.mimeType, bytes: entry.bytes, purpose: 'inspiration', sha256: entry.sha256 };
      uploads.push({
        resourceId: entry.resourceId,
        path: entry.path,
        request: client.describeRequest('POST', '/uploads', body),
        then: msg('upload the file bytes as the returned method/uploadUrl/headers say (without Authorization)', '按返回的 method/uploadUrl/headers 上传文件字节（不带 Authorization）'),
      });
      images.push(imagePayload(entry, `<fileUrl of ${String(entry.resourceId)}>`));
    } else images.push(imagePayload(entry, entry.url as string));
  }
  const body = { ...plan.post, images, clientId: plan.clientId };
  const message = msg('dry run: nothing was sent, uploaded or saved', 'dry-run：未联网、未上传、未保存');
  return { ok: true, dryRun: true, uploads, request: client.describeRequest('POST', '/inspirations', body), skipped: plan.skipped, clientId: plan.clientId, message };
};

const upload = async (rt: Runtime, client: PopostClient, entry: PlanImage, uploaded: JsonRecord[]): Promise<string> => {
  const raw = await rt.fs.readFile(entry.path as string);
  if (createHash('sha256').update(raw).digest('hex') !== entry.sha256)
    throw new InputError(msg(`the picture ${String(entry.path)} changed during the import`, `图片 ${String(entry.path)} 在导入过程中被修改`));
  const up = await client.uploadBytes(raw, entry.fileName as string, entry.mimeType as string, 'inspiration');
  uploaded.push({ resourceId: entry.resourceId, fileUrl: up.fileUrl, uploadId: up.uploadId ?? null, bytes: up.bytes, sha256: up.sha256 });
  return up.fileUrl;
};

/** Uploads the local images, then creates the inspiration. `uploaded` is filled as files go up, so a failure can say what did. */
export const runImport = async (rt: Runtime, client: PopostClient, plan: ImportPlan, uploaded: JsonRecord[]): Promise<JsonRecord> => {
  const images: JsonRecord[] = [];
  for (const entry of plan.images) images.push(imagePayload(entry, entry.kind === 'local' ? await upload(rt, client, entry, uploaded) : (entry.url as string)));
  const data = await client.request('POST', '/inspirations', {
    body: { ...plan.post, images, clientId: plan.clientId },
    hint: msg(
      `It may have been saved; just run the same command again (the clientId ${plan.clientId} is the same, and the platform de-duplicates by clientId)`,
      `可能已保存；重跑同一命令即可（clientId ${plan.clientId} 相同，平台按 clientId 去重）`,
    ),
  });
  const inspiration = isRecord(data) ? data.inspiration : null;
  if (!isRecord(inspiration) || !inspiration.id)
    throw new PopostApiError(msg('the POST /inspirations answer has no inspiration.id', 'POST /inspirations 响应缺少 inspiration.id'), { code: 'BAD_RESPONSE' });
  const summary = {
    id: inspiration.id,
    createdAt: inspiration.createdAt ?? null,
    platform: inspiration.platform ?? null,
    title: inspiration.title ?? null,
    sourceUrl: inspiration.sourceUrl ?? null,
    imageCount: Array.isArray(inspiration.images) ? inspiration.images.length : 0,
  };
  return { ok: true, inspiration: summary, clientId: plan.clientId, uploaded, skipped: plan.skipped, note: msg('saved to My Inspirations on popost.ai', '已保存到 popost.ai「我的灵感」') };
};

export interface ImportCall {
  readonly file: string;
  readonly note?: string;
  readonly clientId?: string;
  readonly allowIncomplete: boolean;
  readonly dryRun: boolean;
  readonly config?: string;
}

interface Failure {
  readonly code: string;
  readonly exit: number;
  readonly message: string;
  readonly withUploaded: boolean;
}

/** Same classes of failure as the Python CLI, in the same precedence (`PopostApiError` and `AmbiguousSubmitError` are provider errors too). */
const failureOf = (error: unknown): Failure | null => {
  if (error instanceof CliReject) return { code: 'CONFIG', exit: error.code, message: error.message, withUploaded: false };
  if (error instanceof InputError) return { code: 'BAD_BUNDLE', exit: 2, message: error.message, withUploaded: true };
  if (error instanceof PopostApiError) return { code: error.code || 'API_ERROR', exit: error.code && LOCAL_ERROR_CODES.includes(error.code) ? 2 : 1, message: error.message, withUploaded: true };
  if (error instanceof AmbiguousSubmitError) return { code: 'UNCERTAIN', exit: 1, message: error.message, withUploaded: true };
  if (error instanceof ImageProviderError) return { code: 'ERROR', exit: 1, message: error.message, withUploaded: true };
  return null;
};

class FileProblem extends Error {
  constructor(
    readonly code: 'FILE_NOT_FOUND' | 'NOT_A_FILE' | 'BAD_JSON',
    message: string,
  ) {
    super(message);
  }
}

const readBundle = async (rt: Runtime, file: string): Promise<unknown> => {
  const path = resolvePath(rt, file);
  const stat = await rt.fs.stat(path);
  if (!stat) throw new FileProblem('FILE_NOT_FOUND', fileErrorText('ENOENT', file)!);
  if (stat.isDirectory) throw new FileProblem('NOT_A_FILE', fileErrorText('EISDIR', file)!);
  try {
    return JSON.parse(await rt.fs.readText(path));
  } catch (error) {
    const detail = (error as Error).message;
    throw new FileProblem('BAD_JSON', msg(`the PostBundle is not valid JSON: ${detail}`, `PostBundle 不是合法 JSON：${detail}`));
  }
};

/** Runs the whole import for one call; prints one JSON document and returns the exit code (0, 1 refused / network, 2 input / environment). */
export const importInspiration = async (rt: Runtime, call: ImportCall): Promise<number> => {
  const uploaded: JsonRecord[] = [];
  let secrets: string[] = [];
  const show = (value: JsonRecord, code: number): number => {
    printJson(rt, scrub(value, secrets), true);
    return code;
  };
  try {
    const cfg = await loadConfig(rt, call.config);
    secrets = secretValues(rt, cfg);
    const pcfg = providerConfig(cfg, 'popost');
    const auth = isRecord(pcfg.auth) ? pcfg.auth : {};
    const bundle = await readBundle(rt, call.file);
    const options: PlanOptions = { note: call.note, clientId: call.clientId, allowIncomplete: call.allowIncomplete };
    const plan = await planImport(rt, bundle, rt.path.dirname(resolvePath(rt, call.file)), options);
    const client = new PopostClient(rt, { baseUrl: pcfg.baseUrl as string | undefined, keyEnv: (auth.envVar as string | undefined) || DEFAULT_KEY_ENV, timeoutSec: Number(pcfg.timeoutSec || 60) });
    return show(call.dryRun ? dryRun(client, plan) : await runImport(rt, client, plan, uploaded), 0);
  } catch (error) {
    if (error instanceof FileProblem) return show({ ok: false, error: { code: error.code, msg: error.message } }, 2);
    const failure = failureOf(error);
    if (!failure) throw error;
    return show({ ok: false, error: { code: failure.code, msg: failure.message }, ...(failure.withUploaded ? { uploaded } : {}) }, failure.exit);
  }
};
