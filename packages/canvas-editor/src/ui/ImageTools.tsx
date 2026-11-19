/** Image tools: replace popover content, file drop onto an image, crop & align mode. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { EditOp, EditorController, EditorSnapshot, NodeId } from '../contracts';
import { getAttr } from '../core/source';
import { useDismissable } from './dismiss';
import { naturalSizeOf } from './frame-dom';
import { Icon } from './icons';
import { useT } from './i18n';
import type { MessageKey } from './i18n';
import { cropFitOf, dragPosition, formatObjectPosition, parseObjectPosition } from './logic/crop';
import type { CropFit } from './logic/crop';
import { docImages, fileToDataURL, ImageLoadError, isImageType, MAX_IMAGE_BYTES, urlToDataURL } from './logic/images';
import type { ImageError } from './logic/images';
import { useToast } from './toasts';

const REASON_TEXT: Record<ImageError, MessageKey> = {
  notImage: 'image.err.notImage',
  tooLarge: 'image.err.tooLarge',
  fetch: 'image.err.fetch',
};

/** Show the "could not use the image" toast with the reason. */
export function useImageError(): (error: unknown) => void {
  const t = useT();
  const toast = useToast();
  return useCallback(
    (error: unknown) => {
      const reason = error instanceof ImageLoadError ? t(REASON_TEXT[error.reason]) : error instanceof Error ? error.message : '';
      toast(reason ? `${t('notice.imageFailed')}: ${reason}` : t('notice.imageFailed'), 'error');
    },
    [t, toast],
  );
}

/** Replace the source of an `img` (one undo step; a `srcset` would override the new source, so it goes). */
export function applyImageSrc(controller: EditorController, id: NodeId, src: string): void {
  const el = controller.index().elements.get(id);
  if (!el) return;
  const ops: EditOp[] = [{ kind: 'setAttr', id, name: 'src', value: src }];
  if (getAttr(el, 'srcset') !== null) ops.push({ kind: 'setAttr', id, name: 'srcset', value: null });
  controller.applyBatch(ops, 'replace image');
}

export const isImgBlock = (controller: EditorController, id: NodeId): boolean => controller.index().elements.get(id)?.tag.toLowerCase() === 'img';

/** Files dropped onto an `img` in the frame replace its source. */
export function useImageDrop(controller: EditorController): void {
  const fail = useImageError();
  useEffect(
    () =>
      controller.onFrameEvent((m) => {
        if (m.type !== 'drop' || m.id === null || !isImgBlock(controller, m.id)) return;
        const file = m.files.find((f) => isImageType(f.type));
        if (!file) return;
        if ((file.dataURL.length * 3) / 4 > MAX_IMAGE_BYTES) {
          fail(new ImageLoadError('tooLarge'));
          return;
        }
        applyImageSrc(controller, m.id, file.dataURL);
        controller.select([m.id]);
      }),
    [controller, fail],
  );
}

/** Content of the replace popover: upload, an image already in the document, a pasted URL. */
export function ImagePicker({ controller, id, onDone }: { controller: EditorController; id: NodeId; onDone(): void }) {
  const t = useT();
  const fail = useImageError();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const images = docImages(controller.index());
  const el = controller.index().elements.get(id);
  const current = el ? getAttr(el, 'src') : null;

  const run = async (get: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      applyImageSrc(controller, id, await get());
      onDone();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="image-picker">
      <button type="button" id="img-upload" className="btn wide" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Icon name="upload" /> {t('image.upload')}
      </button>
      <input
        ref={fileRef}
        id="img-file"
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void run(() => fileToDataURL(file));
        }}
      />
      {images.length > 0 && (
        <>
          <div className="swatch-title">{t('image.inDocument')}</div>
          <div className="img-grid" id="img-doc-grid">
            {images.map((im) => (
              <button key={im.src} type="button" className={`img-thumb${im.src === current ? ' current' : ''}`} title={t('image.use')} disabled={busy || im.src === current} onClick={() => void run(async () => im.src)}>
                <img src={im.src} alt="" />
              </button>
            ))}
          </div>
        </>
      )}
      <div className="swatch-title">{t('image.fromUrl')}</div>
      <form
        className="img-url"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void run(() => urlToDataURL(url));
        }}
      >
        <input id="img-url" type="text" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t('image.fromUrl')} />
        <button type="submit" id="img-url-apply" className="btn" disabled={busy || !url.trim()}>
          {busy ? t('image.loading') : t('image.apply')}
        </button>
      </form>
    </div>
  );
}

interface CropProps {
  controller: EditorController;
  snap: EditorSnapshot;
  id: NodeId;
  /** Scale (zoom / 100). */
  scale: number;
  onExit(): void;
}

interface CropDrag {
  startX: number;
  startY: number;
  start: { x: number; y: number };
  fit: CropFit;
  last: string | null;
}

/** Crop & align: dark scrim, drag inside the image box to set `object-position`, cover / contain, Done / Esc. */
export function CropLayer({ controller, snap, id, scale, onExit }: CropProps) {
  const t = useT();
  const drag = useRef<CropDrag | null>(null);
  const dragging = useRef(false);
  const rect = snap.rects[id];
  const exit = useCallback(() => {
    if (dragging.current) controller.cancelLivePreview([id]);
    dragging.current = false;
    drag.current = null;
    onExit();
  }, [controller, id, onExit]);
  useDismissable(true, exit);

  // Leave crop mode when the selection moves on or the image disappears.
  const stillSelected = snap.selection.length === 1 && snap.selection[0] === id && controller.index().elements.has(id);
  useEffect(() => {
    if (!stillSelected) onExit();
  }, [stillSelected, onExit]);

  if (!rect) return null;
  const styles = controller.styles(id, ['object-fit', 'object-position']);
  const fit = cropFitOf(styles['object-fit']);
  const box = { left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale };

  const setFit = (value: CropFit): void => controller.apply({ kind: 'setStyle', id, props: { 'object-fit': value } }, { label: 'crop' });

  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, start: parseObjectPosition(styles['object-position']), fit: fit ?? 'cover', last: null };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const natural = naturalSizeOf(id);
    if (!d || !natural) return;
    const pos = dragPosition({
      natural,
      box: { width: rect.width, height: rect.height },
      fit: d.fit,
      start: d.start,
      dx: (e.clientX - d.startX) / scale,
      dy: (e.clientY - d.startY) / scale,
    });
    d.last = formatObjectPosition(pos);
    dragging.current = true;
    controller.livePreview([{ kind: 'style', id, props: { 'object-position': d.last, 'object-fit': d.fit } }]);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.last) controller.apply({ kind: 'setStyle', id, props: { 'object-position': d.last, 'object-fit': d.fit } }, { label: 'crop' });
  };

  const barTop = Math.max(4, Math.min(box.top + box.height + 10, controller.pageSize().height * scale - 44));
  return (
    <div className="crop-layer" data-keepfocus="" onPointerDown={(e) => e.target === e.currentTarget && exit()}>
      <div id="crop-box" className="crop-box" style={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => exit()}>
        <span className="crop-hint">{t('crop.hint')}</span>
      </div>
      <div className="crop-bar" style={{ left: box.left, top: barTop }} role="toolbar">
        <button type="button" id="crop-fill" className={`btn${fit === 'cover' ? ' on' : ''}`} onClick={() => setFit('cover')}>
          {t('crop.fill')}
        </button>
        <button type="button" id="crop-whole" className={`btn${fit === 'contain' ? ' on' : ''}`} onClick={() => setFit('contain')}>
          {t('crop.whole')}
        </button>
        <button type="button" id="crop-done" className="btn primary" onClick={exit}>
          {t('crop.done')}
        </button>
      </div>
    </div>
  );
}

