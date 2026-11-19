/** Capability checks of a popost request, done before anything is sent (port of `validate_request` in popost.py). */
import type { Runtime } from '../runtime';
import { sniffImageMime } from './api';
import type { ModelRow, Ref } from './base';
import { CapabilityError } from './errors';

export const MAX_IMAGES_PER_REQUEST = 8; // the platform accepts n = 1..8
export const MAX_REFERENCE_IMAGES = 10;
const MAX_REF_BYTES = 10 * 1024 * 1024; // one local reference, sent inline as base64
const MAX_REF_TOTAL_BYTES = 30 * 1024 * 1024;
const ASPECT_RE = /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/;

const checkCount = (row: ModelRow | null, label: string, count: number) => {
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES_PER_REQUEST) throw new CapabilityError(`count 须在 1–${MAX_IMAGES_PER_REQUEST}（popost.ai 单次上限）`);
  if (row?.maxImagesPerRequest !== undefined && count > row.maxImagesPerRequest) throw new CapabilityError(`模型 ${label} 单次最多生成 ${row.maxImagesPerRequest} 张，收到 ${count}`);
};

const checkAspect = (row: ModelRow | null, label: string, aspect: string) => {
  if (!ASPECT_RE.test(String(aspect ?? ''))) throw new CapabilityError(`画幅须为 W:H，收到 ${JSON.stringify(aspect)}`);
  if (row?.aspectRatios?.length && !row.aspectRatios.includes(aspect))
    throw new CapabilityError(`模型 ${label} 不支持画幅 ${aspect}（可选 ${row.aspectRatios.join('/')}）；请选实际支持的比例，最终画幅由 HTML 裁切`);
};

const checkLocalRef = async (rt: Runtime, path: string): Promise<number> => {
  const stat = await rt.fs.stat(path);
  if (!stat?.isFile) throw new CapabilityError(`本地参考图不存在: ${path}`);
  const name = rt.path.basename(path);
  if (stat.size > MAX_REF_BYTES)
    throw new CapabilityError(`参考图 ${name} 为 ${(stat.size / 1048576).toFixed(1)} MiB，超过单张 ${MAX_REF_BYTES / 1048576} MiB 上限；请压缩或改用 https URL`);
  if (!sniffImageMime((await rt.fs.readFile(path)).subarray(0, 16))) throw new CapabilityError(`参考图 ${name} 不是 PNG/JPEG/WebP/GIF`);
  return stat.size;
};

/** `row` is the model's live capabilities; `null` checks only the platform's own limits (dry-run, no model known). */
export const validateRequest = async (rt: Runtime, row: ModelRow | null, aspect: string, count: number, refs: readonly Ref[]): Promise<void> => {
  const label = row?.value ?? 'popost';
  checkCount(row, label, count);
  checkAspect(row, label, aspect);
  const limit = Math.min(MAX_REFERENCE_IMAGES, row?.maxReferenceImages ?? MAX_REFERENCE_IMAGES);
  if (refs.length > limit) throw new CapabilityError(`模型 ${label} 最多接受 ${limit} 张参考图，收到 ${refs.length}`);
  let total = 0;
  for (const ref of refs) {
    if (ref.kind === 'url') {
      if (!String(ref.value).startsWith('https://')) throw new CapabilityError(`参考图 URL 必须是 https：${ref.value}`);
      continue;
    }
    total += await checkLocalRef(rt, ref.value);
  }
  if (total > MAX_REF_TOTAL_BYTES) throw new CapabilityError(`本地参考图合计 ${(total / 1048576).toFixed(1)} MiB，超过 ${MAX_REF_TOTAL_BYTES / 1048576} MiB 上限`);
};
