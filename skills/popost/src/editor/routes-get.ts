import { PopostClient } from '../providers/api';
/** The read-only routes of the local editor service (`GET`), the editor's static files and the project's own files. */
import { exportAll, renderPagePng } from '../render/png';
import { listRoles } from '../fonts/palette';
import { mimeType } from '../render/mime';
import { readProjectFile } from '../render/offline';
import { canvasInitial, canvasNotes, canvasPayload, editorHtml, payloadRevision } from './canvas-state';
import { editorInfo } from './handoff';
import { CLOUD_DONE_PATH, cloudCallback, cloudDone, cloudStatus } from './routes-cloud';
import { errorMessage, fileResponse, jsonResponse, noStoreResponse, type ApiResponse, type Ctx } from './http-types';
import { localProjectAssets, localReferenceImage, localReferenceImages } from './project-tools';
import { hostAllowed } from './request-security';
import { runSubcommand } from './subcommand';

export const PREVIEW_TTL_MS = 600_000;

const notFound = (ctx: Ctx, error = 'not found'): ApiResponse => jsonResponse(ctx.req, 404, { ok: false, error });

const editorDir = (ctx: Ctx): string => ctx.rt.path.join(ctx.rt.skillRoot, 'assets', 'canvas');

const preview = (ctx: Ctx): ApiResponse => {
  const entry = ctx.state.previews.get(ctx.req.path);
  if (!entry || ctx.rt.now().getTime() - entry.at > PREVIEW_TTL_MS)
    return jsonResponse(ctx.req, 404, { ok: false, error: 'preview expired; reopen the document' });
  return noStoreResponse(entry.body, 'text/html; charset=utf-8', { 'Content-Security-Policy': entry.csp });
};

const projectJson = (ctx: Ctx): Promise<ApiResponse> =>
  ctx.locked(async () => {
    const payload = await canvasPayload(await ctx.load());
    return jsonResponse(ctx.req, 200, { ok: true, manifest: payload, canvasRev: payloadRevision(payload) });
  });

const exportPng = async (ctx: Ctx): Promise<ApiResponse> => {
  const page = ctx.req.query.get('page');
  try {
    const project = await ctx.load();
    const out = page === 'all' ? await exportAll(project) : await renderPagePng(project, page ?? '');
    const type = page === 'all' ? 'application/zip' : 'image/png';
    return fileResponse(await ctx.rt.fs.readFile(out), type, ctx.rt.path.basename(out));
  } catch (error) {
    return jsonResponse(ctx.req, 500, { ok: false, error: errorMessage(error) });
  }
};

const projectBundle = async (ctx: Ctx): Promise<ApiResponse> => {
  const project = await ctx.load();
  const result = await runSubcommand(ctx.rt, ['package', '--dir', project.root]);
  const zip = result.json?.zip;
  if (result.code !== 0 || typeof zip !== 'string')
    return jsonResponse(ctx.req, 400, { ok: false, error: String(result.json?.error ?? 'package failed') });
  return fileResponse(await ctx.rt.fs.readFile(zip), 'application/zip', ctx.rt.path.basename(zip));
};

const editorPage = async (ctx: Ctx): Promise<ApiResponse> => {
  const source = await ctx.rt.fs.readText(ctx.rt.path.join(editorDir(ctx), 'index.html'));
  const html = editorHtml(await ctx.load(), source, ctx.req.rawQuery, ctx.state.cloud.mode());
  return noStoreResponse(html, 'text/html; charset=utf-8');
};

const staticFile = async (ctx: Ctx, root: string, urlPath: string, missing: string): Promise<ApiResponse> => {
  const file = await readProjectFile(ctx.rt, root, urlPath);
  return file ? fileResponse(file.data, mimeType(file.path)) : notFound(ctx, missing);
};

const EXACT: Record<string, (ctx: Ctx) => Promise<ApiResponse> | ApiResponse> = {
  '/api/export-options': async (ctx) => {
    try {
      const account = await new PopostClient(ctx.rt).request('GET', '/me', { timeoutSec: 10 }) as { tier?: string; plan?: { tier?: string }; user?: { tier?: string } };
      const tier = account.tier ?? account.plan?.tier ?? account.user?.tier;
      return jsonResponse(ctx.req, 200, { premium: typeof tier === 'string' && ['basic', 'pro', 'max'].includes(tier) });
    } catch { return jsonResponse(ctx.req, 200, { premium: false }); }
  },
  '/api/editor-info': async (ctx) => jsonResponse(ctx.req, 200, { ok: true, ...editorInfo(await ctx.load()) }),
  '/api/project': projectJson,
  '/api/comparison': localReferenceImages,
  '/api/project-assets': localProjectAssets,
  '/api/canvas-initial': (ctx) => ctx.locked(async () => jsonResponse(ctx.req, 200, await canvasInitial(await ctx.load()))),
  '/api/canvas-notes': (ctx) => ctx.locked(async () => jsonResponse(ctx.req, 200, await canvasNotes(await ctx.load()))),
  '/api/export': exportPng,
  '/api/font-palette': async (ctx) => jsonResponse(ctx.req, 200, { ok: true, roles: await listRoles(ctx.rt) }),
  '/api/project-bundle': projectBundle,
  '/api/cloud/status': cloudStatus,
  '/api/cloud/callback': cloudCallback,
  [CLOUD_DONE_PATH]: cloudDone,
  '/': editorPage,
  '/editor.html': editorPage,
  '/index.html': editorPage,
};

export const handleGet = async (ctx: Ctx): Promise<ApiResponse> => {
  if (!hostAllowed(ctx.req.headers.host, ctx.req.port)) return jsonResponse(ctx.req, 403, { ok: false, error: 'host rejected' });
  const { path } = ctx.req;
  const exact = EXACT[path];
  if (exact) return exact(ctx);
  if (path.startsWith('/api/comparison/')) return localReferenceImage(ctx);
  if (path.startsWith('/_preview/')) return preview(ctx);
  if (path.startsWith('/_editor/'))
    return staticFile(ctx, editorDir(ctx), path.slice('/_editor/'.length), 'editor resource not found');
  const response = await staticFile(ctx, ctx.state.root, path, 'not found');
  // User files never share the editor's script privileges, even when opened directly.
  response.headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; base-uri 'none'";
  response.headers['X-Content-Type-Options'] = 'nosniff';
  return response;
};
