/**
 * Pointer gestures on the canvas: click/press, drag-move with snapping, resize, marquee.
 * Input comes from the edit frame (document px) or from overlay elements (screen px, scaled by 1/zoom);
 * both are normalised to document-px deltas. Drags show live previews and commit as ONE undo step.
 */
import type { EditOp, EditorController, FrameToShell, NodeId } from '../../contracts';
import { blockKind } from '../../core/pages';
import { isDescendant, topLevelIds } from '../logic/blocks';
import { MIN_SIZE, moveProps, NUDGE_STYLE_PROPS, readPlacement, resizeBlock } from '../logic/geometry';
import type { Placement, ResizeHandle } from '../logic/geometry';
import { boxBetween, boxesIntersect, snapBox, unionBox } from '../logic/snap';
import type { Box, Guide } from '../logic/snap';

/** Pointer travel (screen px) before a press becomes a drag. */
export const DRAG_THRESHOLD = 3;
/** Snap distance in screen px (SPEC §5). */
export const SNAP_SCREEN_PX = 6;

export interface GestureView {
  active: 'move' | 'resize' | 'marquee' | null;
  guides: Guide[];
  /** Size / offset label, anchored below the box (document px). */
  tip: { x: number; y: number; text: string } | null;
  marquee: Box | null;
}

export const IDLE_VIEW: GestureView = { active: null, guides: [], tip: null, marquee: null };

export interface GestureDeps {
  controller: EditorController;
  getZoom(): number;
  onView(view: GestureView): void;
}

interface Origin {
  x: number;
  y: number;
  /** Document px per input unit (1 for frame input, 1/zoom for overlay input). */
  scale: number;
}

interface MoveItem {
  id: NodeId;
  place: Placement;
}

type Gesture =
  | { kind: 'press'; origin: Origin; items: NodeId[]; collapseTo: NodeId | null }
  | { kind: 'move'; origin: Origin; items: MoveItem[]; start: Box; others: Box[]; dx: number; dy: number }
  | {
      kind: 'resize';
      origin: Origin;
      id: NodeId;
      handle: ResizeHandle;
      start: Box;
      place: Placement;
      fontSize: number;
      extra: { width: number; height: number };
      dx: number;
      dy: number;
      changed: boolean;
    }
  | { kind: 'marquee'; origin: Origin; base: NodeId[]; additive: boolean; box: Box | null };

const SIZE_PROPS = [
  ...NUDGE_STYLE_PROPS,
  'font-size',
  'box-sizing',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'border-left-width',
  'border-right-width',
  'border-top-width',
  'border-bottom-width',
];

const num = (v: string | undefined): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

export class Gestures {
  private g: Gesture | null = null;
  private view: GestureView = IDLE_VIEW;

  constructor(private readonly deps: GestureDeps) {}

  /** Listen to the frame's pointer events; returns the detach function (also cancels a running gesture). */
  attach(): () => void {
    const off = this.deps.controller.onFrameEvent((e) => this.onFrame(e));
    return () => {
      off();
      this.cancel();
    };
  }

  get active(): boolean {
    return this.g !== null;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Frame input                                                                              */
  /* ---------------------------------------------------------------------------------------- */

  private onFrame(e: FrameToShell): void {
    if (e.type !== 'pointer') return;
    const c = this.deps.controller;
    switch (e.action) {
      case 'down':
        this.down(e);
        break;
      case 'move':
        this.update({ x: e.x, y: e.y }, e.alt);
        break;
      case 'up':
        this.finish();
        break;
      case 'dblclick':
        this.cancel();
        if (e.id !== null && blockKind(c.index(), e.id) === 'text') c.beginTextEdit(e.id, { x: e.x, y: e.y });
        break;
      case 'contextmenu':
        if (e.id !== null && !c.getSnapshot().selection.includes(e.id)) c.select([e.id]);
        break;
    }
  }

  private down(e: Extract<FrameToShell, { type: 'pointer' }>): void {
    const c = this.deps.controller;
    if (this.g) this.cancel();
    const origin: Origin = { x: e.x, y: e.y, scale: 1 };
    const id = (e.alt || e.meta) && e.deepId !== null ? e.deepId : e.id;
    if (id === null) {
      const base = e.shift ? [...c.getSnapshot().selection] : [];
      this.g = { kind: 'marquee', origin, base, additive: e.shift, box: null };
      return;
    }
    if (e.shift) {
      c.select([id], { additive: true });
      return;
    }
    const before = c.getSnapshot().selection;
    const inSelection = before.includes(id);
    if (!inSelection) c.select([id]);
    this.g = { kind: 'press', origin, items: [...c.getSnapshot().selection], collapseTo: inSelection && before.length > 1 ? id : null };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Overlay input (selection box handles, pill)                                              */
  /* ---------------------------------------------------------------------------------------- */

  startPillMove(clientX: number, clientY: number): void {
    const items = [...this.deps.controller.getSnapshot().selection];
    if (items.length === 0) return;
    this.g = { kind: 'press', origin: { x: clientX, y: clientY, scale: 1 / this.deps.getZoom() }, items, collapseTo: null };
  }

  startResize(handle: ResizeHandle, clientX: number, clientY: number): void {
    const c = this.deps.controller;
    const id = c.getSnapshot().selection[0];
    if (id === undefined || c.getSnapshot().selection.length !== 1) return;
    const start = this.rectOf(id);
    if (!start) return;
    const style = c.styles(id, SIZE_PROPS);
    const borderBox = style['box-sizing'] === 'border-box';
    this.g = {
      kind: 'resize',
      origin: { x: clientX, y: clientY, scale: 1 / this.deps.getZoom() },
      id,
      handle,
      start,
      place: readPlacement(style),
      fontSize: num(style['font-size']) || 16,
      extra: borderBox
        ? { width: 0, height: 0 }
        : {
            width: num(style['padding-left']) + num(style['padding-right']) + num(style['border-left-width']) + num(style['border-right-width']),
            height: num(style['padding-top']) + num(style['padding-bottom']) + num(style['border-top-width']) + num(style['border-bottom-width']),
          },
      dx: 0,
      dy: 0,
      changed: false,
    };
  }

  /** Pointer move / up of a gesture started from an overlay element. */
  overlayMove(clientX: number, clientY: number, alt: boolean): void {
    this.update({ x: clientX, y: clientY }, alt);
  }

  overlayUp(): void {
    this.finish();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Gesture engine                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  private rectOf(id: NodeId): Box | null {
    const c = this.deps.controller;
    let r = c.getSnapshot().rects[id];
    if (!r) {
      c.measure([id]);
      r = c.getSnapshot().rects[id];
    }
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  }

  private setView(view: GestureView): void {
    this.view = view;
    this.deps.onView(view);
  }

  private update(point: { x: number; y: number }, alt: boolean): void {
    const g = this.g;
    if (!g) return;
    const dx = (point.x - g.origin.x) * g.origin.scale;
    const dy = (point.y - g.origin.y) * g.origin.scale;
    const zoom = this.deps.getZoom();
    const travelled = Math.hypot(dx, dy) * zoom >= DRAG_THRESHOLD;

    switch (g.kind) {
      case 'press':
        if (travelled && this.beginMove(g)) this.update(point, alt);
        break;
      case 'move':
        this.updateMove(g, dx, dy, alt, zoom);
        break;
      case 'resize':
        this.updateResize(g, dx, dy);
        break;
      case 'marquee':
        if (g.box !== null || travelled) {
          g.box = boxBetween(g.origin.x, g.origin.y, point.x, point.y);
          this.setView({ active: 'marquee', guides: [], tip: null, marquee: g.box });
        }
        break;
    }
  }

  /** Turn a press into a move gesture; false when nothing can be moved. */
  private beginMove(g: Extract<Gesture, { kind: 'press' }>): boolean {
    const c = this.deps.controller;
    const index = c.index();
    const ids = topLevelIds(index, g.items);
    const boxes = ids.map((id) => this.rectOf(id));
    if (ids.length === 0 || boxes.some((b) => b === null)) return false;
    const start = unionBox(boxes as Box[]);
    if (!start) return false;
    const moving = new Set(ids);
    const others: Box[] = [];
    for (const [id, r] of Object.entries(c.getSnapshot().rects)) {
      if (moving.has(id) || ids.some((m) => isDescendant(index, id, m))) continue;
      others.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    }
    this.g = {
      kind: 'move',
      origin: g.origin,
      items: ids.map((id) => ({ id, place: readPlacement(c.styles(id, NUDGE_STYLE_PROPS)) })),
      start,
      others,
      dx: 0,
      dy: 0,
    };
    return true;
  }

  private moveUpdates(g: Extract<Gesture, { kind: 'move' }>): Array<{ kind: 'style'; id: NodeId; props: Record<string, string> }> {
    return g.items.map((i) => ({ kind: 'style', id: i.id, props: moveProps(i.place, g.dx, g.dy) }));
  }

  private updateMove(g: Extract<Gesture, { kind: 'move' }>, rawDx: number, rawDy: number, alt: boolean, zoom: number): void {
    const c = this.deps.controller;
    let dx = rawDx;
    let dy = rawDy;
    let guides: Guide[] = [];
    if (!alt) {
      const moved: Box = { ...g.start, x: g.start.x + dx, y: g.start.y + dy };
      const snap = snapBox(moved, g.others, c.pageSize(), SNAP_SCREEN_PX / zoom);
      dx += snap.dx;
      dy += snap.dy;
      guides = snap.guides;
    }
    g.dx = Math.round(dx);
    g.dy = Math.round(dy);
    c.livePreview(this.moveUpdates(g));
    c.measure(g.items.map((i) => i.id));
    const x = Math.round(g.start.x + g.dx);
    const y = Math.round(g.start.y + g.dy);
    this.setView({
      active: 'move',
      guides,
      tip: { x, y: y + g.start.height, text: `${Math.round(g.start.width)} × ${Math.round(g.start.height)}  ·  ${g.dx >= 0 ? '+' : ''}${g.dx}, ${g.dy >= 0 ? '+' : ''}${g.dy}` },
      marquee: null,
    });
  }

  private resizeProps(g: Extract<Gesture, { kind: 'resize' }>, dx: number, dy: number): { props: Record<string, string>; width: number; height: number } {
    const kind = blockKind(this.deps.controller.index(), g.id);
    const r = resizeBlock({ handle: g.handle, kind, start: g.start, dx, dy, fontSize: g.fontSize, extra: g.extra });
    const props = { ...r.props };
    if (r.shift.x !== 0 || r.shift.y !== 0) Object.assign(props, moveProps(g.place, r.shift.x, r.shift.y));
    return { props, width: r.width, height: r.height };
  }

  private updateResize(g: Extract<Gesture, { kind: 'resize' }>, dx: number, dy: number): void {
    const c = this.deps.controller;
    g.changed = true;
    g.dx = dx;
    g.dy = dy;
    const { props } = this.resizeProps(g, dx, dy);
    c.livePreview([{ kind: 'style', id: g.id, props }]);
    c.measure([g.id]);
    const r = c.getSnapshot().rects[g.id] ?? g.start;
    this.setView({
      active: 'resize',
      guides: [],
      tip: { x: r.x, y: r.y + r.height, text: `${Math.max(MIN_SIZE, Math.round(r.width))} × ${Math.round(r.height)}` },
      marquee: null,
    });
  }

  private finish(): void {
    const g = this.g;
    if (!g) return;
    this.g = null;
    const c = this.deps.controller;
    this.setView(IDLE_VIEW);
    switch (g.kind) {
      case 'press':
        if (g.collapseTo !== null) c.select([g.collapseTo]);
        break;
      case 'move': {
        const ops: EditOp[] = g.dx === 0 && g.dy === 0 ? [] : g.items.map((i) => ({ kind: 'setStyle', id: i.id, props: moveProps(i.place, g.dx, g.dy) }));
        if (ops.length === 0) c.cancelLivePreview(g.items.map((i) => i.id));
        else c.applyBatch(ops, 'move');
        break;
      }
      case 'resize':
        if (!g.changed) break;
        c.applyBatch([{ kind: 'setStyle', id: g.id, props: this.resizeProps(g, g.dx, g.dy).props }], 'resize');
        break;
      case 'marquee':
        this.finishMarquee(g);
        break;
    }
  }

  private finishMarquee(g: Extract<Gesture, { kind: 'marquee' }>): void {
    const c = this.deps.controller;
    if (g.box === null) {
      if (!g.additive) c.select([]);
      return;
    }
    const box = g.box;
    const index = c.index();
    const hits = Object.entries(c.getSnapshot().rects)
      .filter(([, r]) => boxesIntersect(box, r))
      .map(([id]) => id);
    // A container is dropped when something inside it is hit as well (the marquee wants the leaves).
    const leaves = hits.filter((id) => !hits.some((other) => other !== id && isDescendant(index, other, id)));
    c.select(g.additive ? [...new Set([...g.base, ...leaves])] : leaves);
  }

  /** Abort the running gesture (Esc): live changes are reverted. Returns whether one was running. */
  cancel(): boolean {
    const g = this.g;
    if (!g) return false;
    this.g = null;
    if (g.kind === 'move') this.deps.controller.cancelLivePreview(g.items.map((i) => i.id));
    else if (g.kind === 'resize') this.deps.controller.cancelLivePreview([g.id]);
    if (this.view !== IDLE_VIEW) this.setView(IDLE_VIEW);
    return true;
  }
}
