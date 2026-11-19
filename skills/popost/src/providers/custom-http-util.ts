/** Small helpers of the BYOK channel: dotted paths, `{name}` templates, file-name MIME types, the mock model list. */
import type { Runtime } from '../runtime';
import { isRecord, type JsonRecord, type ModelRow } from './base';
import { ImageProviderError } from './errors';

export type TemplateValues = { prompt: string; model: string; aspect: string; count: number; refs: string; baseUrl: string };

/** Value at a dotted path such as `a.b.0.c`; `undefined` when any step is missing. */
export const getPath = (obj: unknown, dotted: string): unknown => {
  let current: unknown = obj;
  for (const part of (dotted || '').split('.')) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(part) && Array.isArray(current)) current = current[Number(part)];
    else if (isRecord(current)) current = current[part];
    else return undefined;
  }
  return current;
};

/** Replaces every `{name}` in strings, recursively through lists and objects. */
export const fillTemplate = (value: unknown, values: Record<string, unknown>): unknown => {
  if (typeof value === 'string') return Object.entries(values).reduce((text, [k, v]) => text.split(`{${k}}`).join(String(v)), value);
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, values));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, values)]));
  return value;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
};

/** Python `mimetypes.guess_type(path)[0] or "image/png"`. */
export const imageMimeByName = (name: string): string => MIME_BY_EXTENSION[/\.[^./\\]*$/.exec(name.toLowerCase())?.[0] ?? ''] ?? 'image/png';

/** Model rows of a mock fixture: `imageModels` (`value`, `credits`) and the platform-shaped `models` (`id`, `creditsPerImage`). */
export const customMockModels = async (rt: Runtime, modelsPath: unknown, mockDir: string | null): Promise<ModelRow[]> => {
  const path = (typeof modelsPath === 'string' && modelsPath) || rt.path.join(mockDir ?? '', 'mock_models.json');
  if (!(await rt.fs.stat(path))?.isFile) throw new ImageProviderError(`mock 模式缺少模型清单: ${path}`);
  const data = JSON.parse(await rt.fs.readText(path)) as JsonRecord;
  const list = (key: string) => (Array.isArray(data[key]) ? (data[key] as JsonRecord[]) : []);
  const known = (credits: unknown) => credits !== undefined && credits !== null;
  return [
    ...list('imageModels').filter((r) => r.value).map((r) => ({ value: String(r.value), label: String(r.label ?? r.value), credits: (r.credits as number | undefined) ?? null, known: known(r.credits) })),
    ...list('models').filter((r) => r.id).map((r) => ({ value: String(r.id), label: String(r.name || r.id), credits: (r.creditsPerImage as number | undefined) ?? null, known: known(r.creditsPerImage) })),
  ];
};
