import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { EditorController, NodeId } from '../../contracts';
import { Icon } from '../icons';
import type { IconName } from '../icons';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { buildLayerRows, layerMoveOp, movedIndex } from '../logic/layers';
import type { LayerRow } from '../logic/layers';
import { useSnapshot } from '../use-snapshot';

const KIND_ICON: Record<LayerRow['kind'], IconName> = { text: 'text', image: 'image', svg: 'shape', video: 'play', box: 'block' };
const KIND_LABEL: Record<LayerRow['kind'], MessageKey> = {
  text: 'layers.kind.text',
  image: 'layers.kind.image',
  svg: 'layers.kind.svg',
  video: 'layers.kind.video',
  box: 'layers.kind.box',
};

interface DropMark {
  id: NodeId;
  where: 'before' | 'after';
}

/** Tree of the current page's selectable blocks. Click selects (Shift adds), hover highlights, drag reorders siblings. */
export function LayersPanel({ controller }: { controller: EditorController }) {
  const t = useT();
  const snap = useSnapshot(controller);
  const rows = useMemo(
    () => buildLayerRows(controller.index(), snap.currentPageId),
    [controller, snap.currentPageId, snap.sourceVersion],
  );
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const [mark, setMark] = useState<DropMark | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Leaving the panel clears the frame highlight.
  useEffect(() => () => controller.highlight([]), [controller]);
  // A selection made on the canvas scrolls into view here.
  const selKey = snap.selection.join(',');
  useEffect(() => {
    const id = snap.selection[0];
    if (id !== undefined) listRef.current?.querySelector(`[data-layer-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selKey, snap.selection]);

  const select = (e: ReactMouseEvent | ReactKeyboardEvent, id: NodeId): void => controller.select([id], { additive: e.shiftKey });

  const canDrop = (target: LayerRow): boolean => {
    if (!dragId || dragId === target.id) return false;
    return controller.index().elements.get(dragId)?.parent === target.parentId;
  };

  const over = (e: ReactDragEvent<HTMLDivElement>, row: LayerRow): void => {
    if (!canDrop(row)) {
      setMark(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = e.currentTarget.getBoundingClientRect();
    const where = e.clientY < box.top + box.height / 2 ? 'before' : 'after';
    if (mark?.id !== row.id || mark.where !== where) setMark({ id: row.id, where });
  };

  const drop = (e: ReactDragEvent<HTMLDivElement>, row: LayerRow): void => {
    e.preventDefault();
    const id = dragId;
    const where = mark?.id === row.id ? mark.where : 'after';
    setDragId(null);
    setMark(null);
    if (!id || !canDrop(row)) return;
    const index = controller.index();
    const op = layerMoveOp(index, id, row.id, where);
    if (!op) return;
    const parentId = index.elements.get(id)?.parent;
    const at = movedIndex(index, id, row.id, where);
    controller.apply(op, { label: 'reorder layer' });
    // A moved block gets a new id; follow it by its position among the siblings.
    if (parentId && at !== null) {
      const moved = controller.index().elements.get(parentId)?.children[at];
      if (moved !== undefined) controller.select([moved]);
    }
  };

  return (
    <div className="panel-body layers" data-panel-body="layers">
      {rows.length === 0 && <p className="p-hint">{t('layers.empty')}</p>}
      <div ref={listRef} className="layer-list" role="tree" aria-label={t('panel.layers')} onMouseLeave={() => controller.highlight([])}>
        {rows.map((row) => {
          const selected = snap.selection.includes(row.id);
          const cls = ['layer-row', selected ? 'selected' : '', dragId === row.id ? 'dragging' : '', mark?.id === row.id ? `drop-${mark.where}` : ''].filter(Boolean).join(' ');
          return (
            <div
              key={row.id}
              className={cls}
              role="treeitem"
              aria-selected={selected}
              tabIndex={0}
              draggable
              data-layer-id={row.id}
              data-kind={row.kind}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onClick={(e) => select(e, row.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select(e, row.id);
                }
              }}
              onMouseEnter={() => controller.highlight([row.id])}
              onDragStart={(e) => {
                setDragId(row.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.id);
              }}
              onDragOver={(e) => over(e, row)}
              onDrop={(e) => drop(e, row)}
              onDragEnd={() => {
                setDragId(null);
                setMark(null);
              }}
            >
              <span className="layer-icon" title={t(KIND_LABEL[row.kind])}>
                <Icon name={KIND_ICON[row.kind]} size={14} />
              </span>
              <span className="layer-kind">{t(KIND_LABEL[row.kind])}</span>
              <span className="layer-snippet">{row.snippet}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
