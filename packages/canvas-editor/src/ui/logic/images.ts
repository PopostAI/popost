/** Image replacement helpers: documents' images, file/URL → data URI. */
import type { DocIndex, NodeId } from '../../contracts';
import { getAttr } from '../../core/source';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export type ImageError = 'notImage' | 'tooLarge' | 'fetch';

export class ImageLoadError extends Error {
  constructor(readonly reason: ImageError) {
    super(reason);
  }
}

export interface DocImage {
  src: string;
  /** First `img` carrying this source. */
  id: NodeId;
}

/** Distinct `img` sources of the document (in order), so one can be reused elsewhere. */
export function docImages(index: DocIndex): DocImage[] {
  const seen = new Set<string>();
  const out: DocImage[] = [];
  for (const id of index.order) {
    const el = index.elements.get(id);
    if (!el || el.tag.toLowerCase() !== 'img') continue;
    const src = getAttr(el, 'src');
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, id });
  }
  return out;
}

export function isImageType(type: string): boolean {
  return /^image\//i.test(type);
}

export function checkImageBlob(blob: Blob): void {
  if (!isImageType(blob.type)) throw new ImageLoadError('notImage');
  if (blob.size > MAX_IMAGE_BYTES) throw new ImageLoadError('tooLarge');
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ImageLoadError('fetch'));
    reader.readAsDataURL(blob);
  });
}

export async function fileToDataURL(file: Blob): Promise<string> {
  checkImageBlob(file);
  return blobToDataURL(file);
}

/** `http(s)` / `data:image` / `blob:` URL the user typed, or null when it cannot be an image URL. */
export function normalizeImageUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^data:image\//i.test(v)) return v;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Fetch an image URL and embed it. Fails with `ImageLoadError` (CORS and network errors are `fetch`). */
export async function urlToDataURL(raw: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = normalizeImageUrl(raw);
  if (!url) throw new ImageLoadError('fetch');
  if (url.startsWith('data:')) return url;
  let blob: Blob;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new ImageLoadError('fetch');
    blob = await response.blob();
  } catch (error) {
    throw error instanceof ImageLoadError ? error : new ImageLoadError('fetch');
  }
  return fileToDataURL(blob);
}
