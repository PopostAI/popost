import { useRef, useState, type PointerEvent } from 'react';
import type { EditorController } from '../contracts';
import type { CropRequest } from './PageDesign';
import { frameElement } from './frame-dom';
import { useT } from './i18n';
import { useDismissable } from './dismiss';

async function preservedBackground(node: HTMLElement | null, size: { width: number; height: number }, offset: { x: number; y: number }): Promise<Record<string, string>> {
  const style = node?.ownerDocument.defaultView?.getComputedStyle(node);
  const match = /^url\(["']?(.*?)["']?\)$/.exec(style?.backgroundImage ?? '');
  if (!style || !match?.[1]) return {};
  if (!['cover', 'contain'].includes(style.backgroundSize)) {
    if (!/^[-.\d]+px$/.test(style.backgroundPositionX) || !/^[-.\d]+px$/.test(style.backgroundPositionY)) return {};
    return { 'background-position': `${parseFloat(style.backgroundPositionX) - offset.x}px ${parseFloat(style.backgroundPositionY) - offset.y}px` };
  }
  const image = new Image();
  image.src = match[1];
  try { await image.decode(); } catch { return {}; }
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) return {};
  const ratio = (style.backgroundSize === 'cover' ? Math.max : Math.min)(size.width / naturalWidth, size.height / naturalHeight);
  const width = naturalWidth * ratio;
  const height = naturalHeight * ratio;
  const position = (value: string, space: number) => value.endsWith('%') ? space * parseFloat(value) / 100 : parseFloat(value) || 0;
  return {
    'background-size': `${width}px ${height}px`,
    'background-position': `${position(style.backgroundPositionX, size.width - width) - offset.x}px ${position(style.backgroundPositionY, size.height - height) - offset.y}px`,
  };
}

export function PageResize({ request, controller, scale, onClose }: {
  request: CropRequest; controller: EditorController; scale: number; onClose(): void;
}) {
  const t = useT();
  const current = controller.pageSize();
  const maxX = Math.max(0, current.width - request.width);
  const maxY = Math.max(0, current.height - request.height);
  const [offset, setOffset] = useState({ x: Math.round(maxX / 2), y: Math.round(maxY / 2) });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useDismissable(true, onClose);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !drag.current) return;
    const start = drag.current;
    setOffset({
      x: Math.round(Math.max(0, Math.min(maxX, start.left + (event.clientX - start.x) / scale))),
      y: Math.round(Math.max(0, Math.min(maxY, start.top + (event.clientY - start.y) / scale))),
    });
  };
  const [applying, setApplying] = useState(false);
  const apply = async () => {
    if (applying) return;
    setApplying(true);
    const { pageId, width, height } = request;
    const children = controller.index().elements.get(pageId)?.children ?? [];
    const shifts = offset.x === 0 && offset.y === 0 ? [] : children.flatMap((id) => {
      const node = frameElement(id);
      const css = node?.ownerDocument.defaultView?.getComputedStyle(node);
      if (!css || css.display === 'none' || node?.tagName === 'STYLE') return [];
      const transform = css.transform === 'none' ? '' : ` ${css.transform}`;
      return [{ kind: 'setStyle' as const, id, props: { transform: `translate(${-offset.x}px, ${-offset.y}px)${transform}` } }];
    });
    const background = await preservedBackground(frameElement(pageId), current, offset);
    if (controller.getSnapshot().currentPageId !== pageId) { onClose(); return; }
    controller.applyBatch([
      { kind: 'setAttr', id: pageId, name: 'data-popost-width', value: String(width) },
      { kind: 'setAttr', id: pageId, name: 'data-popost-height', value: String(height) },
      { kind: 'setStyle', id: pageId, props: { width: `${width}px`, height: `${height}px`, overflow: 'hidden', ...background } },
      ...shifts,
    ], 'resize page');
    onClose();
  };
  return (
    <div className="page-resize-layer">
      <div className="page-resize-actions">
        <button type="button" className="btn" onClick={onClose}>{t('design.cancel')}</button>
        <button type="button" className="btn primary" disabled={applying} onClick={() => void apply()}>{t('design.apply')}</button>
        <span>{request.width} × {request.height} px</span>
      </div>
      <div className="page-resize-hit" onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={move}>
        <div className="page-resize-frame" style={{ width: request.width * scale, height: request.height * scale, left: offset.x * scale, top: offset.y * scale }} />
      </div>
    </div>
  );
}
