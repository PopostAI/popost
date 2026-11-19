/** The writing routes of the local editor service (`POST`): save, previews, fonts, imports, notes. */
import { sniffImage } from '../core/image';
import { msg } from '../i18n';
import { installFontsIntoProject } from '../fonts/project-fonts';
import {
  canvasBackup,
  canvasInitial,
  canvasNotes,
  canvasRevision,
  STATE_DIR,
  type NoteOperation,
} from './canvas-state';
import {
  errorMessage,
  isBadRequest,
  jsonResponse,
  parseJsonObject,
  type ApiResponse,
  type Ctx,
} from './http-types';
import { cloudPush, cloudStart } from './routes-cloud';
import { previewHtml } from './sanitize';
import { savePayload } from './save';
import { runSubcommand } from './subcommand';

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEWS = 16;
const staleProject = () =>
  msg('The project was changed by another window or by the agent. Reload it, or resolve the conflict.', '工程已被另一窗口或 Agent 修改，请重新加载或处理冲突。');
const staleFonts = () =>
  msg('The project was changed by another window or by the agent. Reload it, then choose the fonts.', '工程已被另一窗口或 Agent 修改，请重新加载后选择字体。');

import { originAllowed } from './request-security';
export { originAllowed } from './request-security';

const failure = (ctx: Ctx, error: unknown, kind: 'bad-or-server' | 'bad-only' = 'bad-or-server'): ApiResponse =>
  jsonResponse(ctx.req, isBadRequest(error) || kind === 'bad-only' ? 400 : 500, { ok: false, error: errorMessage(error) });

const canvasPreview = async (ctx: Ctx): Promise<ApiResponse> => {
  const size = ctx.req.body.byteLength;
  if (!(size > 0 && size <= MAX_PREVIEW_BYTES))
    return jsonResponse(ctx.req, 413, { ok: false, error: msg('preview is empty or too large', '预览内容为空或过大') });
  try {
    const data = parseJsonObject(ctx.req);
    const nonce = data.nonce ?? null;
    if (typeof data.content !== 'string' || (nonce !== null && typeof nonce !== 'string'))
      return jsonResponse(ctx.req, 400, { ok: false, error: msg('content and nonce must be strings', 'content 和 nonce 必须是字符串') });
    const { body, csp } = previewHtml(data.content, nonce);
    const route = `/_preview/${ctx.rt.randomUUID().replaceAll('-', '')}.html`;
    const now = ctx.rt.now().getTime();
    for (const [key, entry] of ctx.state.previews) if (now - entry.at > 600_000) ctx.state.previews.delete(key);
    while (ctx.state.previews.size >= MAX_PREVIEWS) ctx.state.previews.delete(ctx.state.previews.keys().next().value!);
    ctx.state.previews.set(route, { at: now, body, csp });
    return jsonResponse(ctx.req, 200, { ok: true, url: route });
  } catch (error) {
    return failure(ctx, error, 'bad-only');
  }
};

const importProject = async (ctx: Ctx): Promise<ApiResponse> => {
  const { rt } = ctx;
  const id = rt.randomUUID().replaceAll('-', '').slice(0, 10);
  const dest = rt.path.join(rt.path.dirname(ctx.state.root), `popost-import-${id}`);
  const zip = rt.path.join(ctx.state.root, STATE_DIR, `import-${id}.zip`);
  try {
    await rt.fs.writeFile(zip, ctx.req.body);
    const result = await runSubcommand(rt, ['unpack', '--file', zip, '--dir', dest]);
    if (result.code !== 0) return jsonResponse(ctx.req, 400, { ok: false, error: String(result.json?.error ?? msg('unpack failed', '解包失败')) });
    ctx.state.root = dest;
    return jsonResponse(ctx.req, 200, { ok: true, project: dest });
  } catch (error) {
    return failure(ctx, error, 'bad-only');
  } finally {
    await rt.fs.rm(zip);
  }
};

const importImage = (ctx: Ctx): Promise<ApiResponse> =>
  ctx.locked(async () => {
    try {
      let data = ctx.req.body;
      if (ctx.req.headers['content-type'] === 'application/json') {
        const match = /^data:image\/(\w+);base64,(.*)$/s.exec(String(parseJsonObject(ctx.req).dataUri));
        if (!match) throw new Error(msg('bad dataUri', 'dataUri 无效'));
        data = new Uint8Array(Buffer.from(match[2]!, 'base64'));
      }
      const { format, width, height } = sniffImage(data);
      const project = await ctx.load();
      const canvasRev = ctx.req.headers['x-popost-canvas-rev'];
      if (canvasRev && canvasRev !== await canvasRevision(project))
        return jsonResponse(ctx.req, 409, { ok: false, error: staleProject() });
      const base = canvasRev ? `import-${ctx.rt.randomUUID().replaceAll('-', '')}` :
        `import${String(project.manifest.assets.length + 1).padStart(3, '0')}`;
      const name = `${base}.${format === 'jpeg' ? 'jpg' : format}`;
      const asset = await project.addAssetBytes(data, name);
      return jsonResponse(ctx.req, 200, { ok: true, asset, width, height, canvasRev: await canvasRevision(project) });
    } catch (error) {
      return jsonResponse(ctx.req, 500, { ok: false, error: errorMessage(error) });
    }
  });

const fontInstall = (ctx: Ctx): Promise<ApiResponse> =>
  ctx.locked(async () => {
    try {
      const body = parseJsonObject(ctx.req);
      const project = await ctx.load();
      if (body.canvasRev && body.canvasRev !== (await canvasRevision(project)))
        return jsonResponse(ctx.req, 409, { ok: false, error: staleFonts() });
      const resourceOnly = Boolean(body.resourceOnly);
      const roles = typeof body.roles === 'string' ? body.roles : '';
      const installed = await installFontsIntoProject(ctx.rt, project, roles, !resourceOnly);
      const canvasRev = await canvasRevision(project);
      return jsonResponse(ctx.req, 200, { ok: true, installed, cssInjected: !resourceOnly, canvasRev });
    } catch (error) {
      return failure(ctx, error);
    }
  });

const saveProject = (ctx: Ctx): Promise<ApiResponse> =>
  ctx.locked(async () => {
    try {
      const data = parseJsonObject(ctx.req);
      const project = await ctx.load();
      if (data.canvasRev && data.canvasRev !== (await canvasRevision(project)) && !data.force)
        return jsonResponse(ctx.req, 409, { ok: false, error: staleProject() });
      await canvasInitial(project);
      await canvasBackup(project);
      const saved = await savePayload(project, data);
      const canvasRev = await canvasRevision(project);
      ctx.state.cloud.scheduleAutoPush();
      return jsonResponse(ctx.req, 200, { ok: true, saved, revision: project.manifest.revision, canvasRev });
    } catch (error) {
      return failure(ctx, error);
    }
  });

const notes = (ctx: Ctx): Promise<ApiResponse> =>
  ctx.locked(async () => {
    try {
      const ops = parseJsonObject(ctx.req).ops ?? [];
      if (!Array.isArray(ops)) throw new SyntaxError(msg('ops must be a list', 'ops 必须是列表'));
      return jsonResponse(ctx.req, 200, await canvasNotes(await ctx.load(), ops as NoteOperation[]));
    } catch (error) {
      return failure(ctx, error, 'bad-only');
    }
  });

const ROUTES: Record<string, (ctx: Ctx) => Promise<ApiResponse>> = {
  '/api/canvas-preview': canvasPreview,
  '/api/import-project': importProject,
  '/api/import-image': importImage,
  '/api/font-install': fontInstall,
  '/api/project': saveProject,
  '/api/canvas-notes': notes,
  '/api/cloud/start': cloudStart,
  '/api/cloud/push': cloudPush,
};

export const handlePost = async (ctx: Ctx): Promise<ApiResponse> => {
  if (!originAllowed(ctx.req.headers, ctx.req.port))
    return jsonResponse(ctx.req, 403, { ok: false, error: msg('origin/csrf rejected', '来源校验（origin/csrf）未通过') });
  const route = Object.hasOwn(ROUTES, ctx.req.path) ? ROUTES[ctx.req.path] : undefined;
  return route ? route(ctx) : jsonResponse(ctx.req, 404, { ok: false, error: msg('not found', '未找到') });
};
