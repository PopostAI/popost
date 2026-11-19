import type { PointerEvent as ReactPointerEvent } from 'react';
import type { EditorController, EditorSnapshot, NodeId } from '../contracts';
import { blockKind } from '../core/pages';
import type { Actions } from './actions';
import { Icon } from './icons';
import { useT } from './i18n';
import type { Gestures, GestureView } from './interaction/gestures';
import type { ResizeHandle } from './logic/geometry';
import { unionBox } from './logic/snap';
import type { Box } from './logic/snap';

const HANDLES: ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'w', 'e'];
const HANDLE_POS: Record<ResizeHandle, [number, number]> = {
  nw: [0, 0],
  ne: [100, 0],
  sw: [0, 100],
  se: [100, 100],
  w: [0, 50],
  e: [100, 50],
};
const CURSOR: Record<ResizeHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', w: 'ew-resize', e: 'ew-resize' };
const PILL_WIDTH = 236;
const PILL_HEIGHT = 36;

interface Props {
  controller: EditorController;
  snap: EditorSnapshot;
  /** Scale (zoom / 100). */
  scale: number;
  width: number;
  gestures: Gestures;
  view: GestureView;
  actions: Actions;
}

const boxStyle = (b: Box, s: number) => ({ left: b.x * s, top: b.y * s, width: b.width * s, height: b.height * s });

/** Selection chrome over the frame: hover outline, selection box + handles, pill, guides, tooltip, marquee. */
export function Overlay({ controller, snap, scale: s, width, gestures, view, actions }: Props) {
  const t = useT();
  const { rects, selection, hoverId, editingTextId } = snap;
  const selected = selection.filter((id) => rects[id]);
  const group = unionBox(selected.map((id) => rects[id] as Box));
  const single = selected.length === 1 ? (selected[0] as NodeId) : null;
  const editing = editingTextId !== null;
  const dragging = view.active === 'move' || view.active === 'resize';
  const hover = hoverId !== null && !selection.includes(hoverId) && !editing && !dragging ? rects[hoverId] : undefined;

  /** Pointer wiring for overlay elements that start a gesture (pointer capture keeps events coming). */
  const drag = (start: (e: ReactPointerEvent) => void) => ({
    'data-keepfocus': '',
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      start(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) gestures.overlayMove(e.clientX, e.clientY, e.altKey);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      gestures.overlayUp();
    },
    onPointerCancel: () => {
      gestures.cancel();
    },
  });

  const pillTop = group ? (group.y * s >= PILL_HEIGHT + 12 ? group.y * s - PILL_HEIGHT - 8 : (group.y + group.height) * s + 8) : 0;
  const pillLeft = group ? Math.max(0, Math.min(group.x * s, width - PILL_WIDTH)) : 0;
  const kind = single ? blockKind(controller.index(), single) : null;

  return (
    <div className="overlay" aria-hidden={false}>
      {hover && <div className="ov-hover" style={boxStyle(hover, s)} />}

      {selected.map((id) => (
        <div key={id} className={`ov-sel${selected.length > 1 ? ' multi' : ''}${editing ? ' editing' : ''}`} style={boxStyle(rects[id] as Box, s)} data-sel-id={id} />
      ))}

      {group && selected.length > 1 && <div className="ov-group" style={boxStyle(group, s)} />}

      {group && single && !editing && (
        <div className="ov-handles" style={boxStyle(group, s)}>
          {HANDLES.map((h) => (
            <span
              key={h}
              className={`ov-handle h-${h}`}
              data-handle={h}
              style={{ left: `${HANDLE_POS[h][0]}%`, top: `${HANDLE_POS[h][1]}%`, cursor: CURSOR[h] }}
              {...drag((e) => gestures.startResize(h, e.clientX, e.clientY))}
            />
          ))}
        </div>
      )}

      {group && !editing && (
        <div className={`ov-pill${dragging ? ' hidden' : ''}`} style={{ left: pillLeft, top: pillTop }} role="toolbar" data-keepfocus="">
          <span className="pill-grip" title={t('pill.move')} {...drag((e) => gestures.startPillMove(e.clientX, e.clientY))}>
            <Icon name="grip" />
          </span>
          {selected.length > 1 && <span className="pill-count">{t('pill.selected', { n: selected.length })}</span>}
          {single && kind !== null && (
            <button type="button" className="pill-btn" data-act="parent" title={t('pill.selectParent')} onClick={() => controller.selectParent()}>
              <Icon name="parent" />
            </button>
          )}
          <button type="button" className="pill-btn" data-act="duplicate" title={t('pill.duplicate')} onClick={actions.duplicateSelection}>
            <Icon name="duplicate" />
          </button>
          <button type="button" className="pill-btn danger" data-act="delete" title={t('pill.delete')} onClick={actions.deleteSelection}>
            <Icon name="trash" />
          </button>
          {single && (
            <>
              <button type="button" className="pill-btn" data-act="forward" title={t('pill.forward')} onClick={() => actions.reorderSelection('down')}>
                <Icon name="forward" />
              </button>
              <button type="button" className="pill-btn" data-act="backward" title={t('pill.backward')} onClick={() => actions.reorderSelection('up')}>
                <Icon name="backward" />
              </button>
            </>
          )}
        </div>
      )}

      {view.guides.map((g, i) =>
        g.axis === 'x' ? (
          <div key={i} className="ov-guide v" style={{ left: g.pos * s, top: g.from * s, height: (g.to - g.from) * s }} />
        ) : (
          <div key={i} className="ov-guide h" style={{ top: g.pos * s, left: g.from * s, width: (g.to - g.from) * s }} />
        ),
      )}
      {view.marquee && <div className="ov-marquee" style={boxStyle(view.marquee, s)} />}
      {view.tip && (
        <div className="ov-tip" style={{ left: view.tip.x * s, top: view.tip.y * s + 8 }}>
          {view.tip.text}
        </div>
      )}
    </div>
  );
}
