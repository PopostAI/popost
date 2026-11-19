/** Local project inputs and artwork. Reference paths stay within this project's reference directory. */
import { sniffImage } from '../core/image';
import type { Project } from '../core/project';
import { readProjectFile } from '../render/offline';
import { fileResponse, jsonResponse, type ApiResponse, type Ctx } from './http-types';

const layoutPaths = (project: Project) =>
  project.manifest.sources.filter(
    (source): source is typeof source & { path: string } =>
      source.kind === 'local-reference' && source.role === 'layout' &&
      typeof source.path === 'string' && /^reference\/[\w.-]+$/.test(source.path),
  );

export const hasComparison = (project: Project): boolean =>
  project.manifest.mode === 'strict' || layoutPaths(project).length > 0;

const image = (path: string, base = '') => ({
  src: base + '/' + path.split('/').map(encodeURIComponent).join('/'),
  name: path.split('/').at(-1) ?? 'Image',
});

const readReference = async (project: Project, path: string) => {
  const file = await readProjectFile(project.rt, project.root, path);
  if (!file) return null;
  try {
    const { width, height, mime } = sniffImage(file.data);
    return { data: file.data, width, height, mime };
  } catch {
    return null;
  }
};

/** Match explicitly mapped pages first, then bind unassigned images in the order they were registered. */
export const localReferenceImages = async (ctx: Ctx): Promise<ApiResponse> => {
  const project = await ctx.load();
  const sources = layoutPaths(project);
  const fallback = sources.filter((source) => !source.pageId);
  let index = 0;
  const items = await Promise.all(project.manifest.pages.map(async (page) => {
    const source = sources.find((entry) => entry.pageId === page.id) ?? fallback[index++];
    if (!source) return null;
    const file = await readReference(project, source.path);
    if (!file) return null;
    return { ...image(source.path, '/api/comparison'), pageKey: page.id, width: file.width, height: file.height };
  }));
  return jsonResponse(ctx.req, 200, { ok: true, items: items.filter((item) => item !== null) });
};

export const localReferenceImage = async (ctx: Ctx): Promise<ApiResponse> => {
  const project = await ctx.load();
  const source = layoutPaths(project).find((entry) => image(entry.path, '/api/comparison').src === ctx.req.path);
  const file = source && await readReference(project, source.path);
  return file ? fileResponse(file.data, file.mime) : jsonResponse(ctx.req, 404, { ok: false, error: 'reference not found' });
};

export const localProjectAssets = async (ctx: Ctx): Promise<ApiResponse> => {
  const project = await ctx.load();
  const attached = project.manifest.assets.filter((asset) => asset.kind === 'image' && /^assets\/[\w.-]+$/.test(asset.path));
  const items = attached.map((asset) => image(asset.path));
  const historical = ctx.req.query.get('tab') === 'history';
  const raw = Number(ctx.req.query.get('page'));
  const page = Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
  const pageSize = 30;
  return jsonResponse(ctx.req, 200, {
    ok: true, items: historical ? items.reverse().slice((page - 1) * pageSize, page * pageSize) : items,
    more: historical && page * pageSize < items.length,
  });
};
