/** Read-only access to the edit frame's DOM (same-origin, SPEC section 6) for facts the controller does not expose. */
import { PP_ID_ATTR } from '../core/preview';

export function frameElement(id: string): HTMLElement | null {
  const frame = document.getElementById('frame') as HTMLIFrameElement | null;
  const doc = frame?.contentDocument;
  return doc ? doc.querySelector<HTMLElement>(`[${PP_ID_ATTR}="${id.replace(/["\\]/g, '\\$&')}"]`) : null;
}

/** Natural pixel size of an image block as the frame loaded it; null until it has loaded. */
export function naturalSizeOf(id: string): { width: number; height: number } | null {
  const el = frameElement(id);
  if (el?.tagName !== 'IMG') return null;
  const img = el as HTMLImageElement;
  return img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
}

/**
 * Resolve once the edit frame has laid out and its pending web fonts have loaded (capped at `maxMs`), so a font
 * choice only counts as done when the new family actually renders. When `family` is given, every declared face of
 * that family (e.g. the bold cut) is loaded too, so toggling weight afterwards does not flash a fallback. Never rejects.
 */
export async function frameFontsSettled(family?: string, maxMs = 8000): Promise<void> {
  const frame = document.getElementById('frame') as HTMLIFrameElement | null;
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument as (Document & { fonts?: FontFaceSet }) | null | undefined;
  if (!win || !doc?.fonts) return;
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
    await doc.fonts?.ready;
    if (!family) return;
    const faces = [...(doc.fonts as unknown as Iterable<FontFace>)].filter((f) => f.family.replace(/^["']|["']$/g, '') === family);
    await Promise.all(faces.map((f) => f.load().catch(() => undefined)));
  };
  await Promise.race([settle().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, maxMs))]);
}
