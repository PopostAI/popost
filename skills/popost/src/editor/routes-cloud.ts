/**
 * The cloud-save routes of the local editor service: `GET /api/cloud/status`, `POST /api/cloud/start`, `POST
 * /api/cloud/push` and the login's return address `GET /api/cloud/callback`, plus the page it ends on. The POST routes are
 * origin-checked like every write (`routes-post.ts`); the callback is the one state-changing GET and is guarded by `state`.
 * Pushes never hold the project lock: a save is never made to wait for an upload.
 */
import type { CloudLang } from '../cloud/service';
import { CloudError } from '../cloud/errors';
import { msg } from '../i18n';
import { errorMessage, isBadRequest, jsonResponse, parseJsonObject, type ApiResponse, type Ctx } from './http-types';

/** The callback carries a one-time code in its URL: keep it out of caches and Referer headers. */
const SENSITIVE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

export const CLOUD_DONE_PATH = '/cloud-done.html';

const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Popost</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#16181d}p{color:#555c66}@media(prefers-color-scheme:dark){body{background:#16181d;color:#f1f2f4}p{color:#a3a9b3}}</style></head><body><h1>Saved to Popost</h1><p>The project is being uploaded to your popost.ai account. You can close this tab and go back to the editor.</p><h1>已发送到 Popost</h1><p>作品正在上传到你的 popost.ai 账号。可以关闭这个页面，回到编辑器。</p></body></html>`;

const langOf = (value: unknown): CloudLang | undefined => (value === 'en' || value === 'zh' ? value : undefined);

/** A JSON body that may be empty (the editor sends none for a plain status poll or an unforced push). */
const optionalBody = (ctx: Ctx): Record<string, unknown> => (ctx.req.body.byteLength ? parseJsonObject(ctx.req) : {});

const refuse = (ctx: Ctx, status: number, error: string): ApiResponse => jsonResponse(ctx.req, status, { ok: false, error });

const cloudOff = (): string => msg('cloud save is turned off', '云端保存已关闭');

export const cloudStatus = async (ctx: Ctx): Promise<ApiResponse> => {
  try {
    return jsonResponse(ctx.req, 200, await ctx.state.cloud.status());
  } catch (error) {
    return refuse(ctx, 500, errorMessage(error));
  }
};

export const cloudStart = async (ctx: Ctx): Promise<ApiResponse> => {
  const { cloud } = ctx.state;
  const mode = cloud.mode();
  if (mode !== 'anonymous')
    return refuse(
      ctx,
      409,
      mode === 'off' ? cloudOff() : msg('a popost key is configured; the project syncs without a login', '已配置 popost Key；工程会自动同步，无需登录'),
    );
  try {
    const body = optionalBody(ctx);
    const started = await cloud.start(langOf(body.lang) ?? 'en', ctx.req.port);
    return jsonResponse(ctx.req, 200, { ok: true, ...started });
  } catch (error) {
    return refuse(ctx, isBadRequest(error) || error instanceof CloudError ? 400 : 500, errorMessage(error));
  }
};

export const cloudPush = async (ctx: Ctx): Promise<ApiResponse> => {
  const { cloud } = ctx.state;
  if (cloud.mode() === 'off') return refuse(ctx, 409, cloudOff());
  try {
    const body = optionalBody(ctx);
    const status = await cloud.push({ force: body.force === true, lang: langOf(body.lang) });
    return jsonResponse(ctx.req, status.ok ? 200 : 409, status);
  } catch (error) {
    return refuse(ctx, isBadRequest(error) ? 400 : 500, errorMessage(error));
  }
};

export const cloudCallback = (ctx: Ctx): ApiResponse => {
  const result = ctx.state.cloud.callback(ctx.req.query.get('code'), ctx.req.query.get('state'));
  const response = result.ok
    ? ({ status: 303, headers: { Location: CLOUD_DONE_PATH }, body: '' } satisfies ApiResponse)
    : jsonResponse(ctx.req, 400, { ok: false, error: result.error });
  return { ...response, headers: { ...response.headers, ...SENSITIVE } };
};

export const cloudDone = (): ApiResponse => ({
  status: 200,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    ...SENSITIVE,
  },
  body: DONE_PAGE,
});
