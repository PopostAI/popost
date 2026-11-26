/**
 * Editing on the stage: a click selects the nearest item under the pointer at the current frame; the selected item
 * shows its box with eight handles. Dragging the box moves it, a handle resizes it (Shift keeps the proportions),
 * always by whole pixels of the canvas, with the numbers shown while dragging. One operation is sent when the pointer
 * is released, so undo takes back the whole drag. While dragging, the item in the page is moved too, as a preview.
 */
import type { Store, View } from '../app';
import { h, placeBox } from '../dom';
import { slotFrame, visibleSlots } from '../studio/scene-selection';
import { itemsAt } from '../model';
import type { EditActions } from './controller';
import { boxOf, boxPath, roundBox, targetOf, type Target } from './source';

type Box4 = [number, number, number, number];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

interface Drag { mode: 'move' | (typeof HANDLES)[number]; x0: number; y0: number; box0: Box4; moved: boolean; target: Target }

export interface StageEdit {
  /** Moves the selected item by dx, dy pixels of the canvas; false when nothing with a box is selected. */
  nudge(dx: number, dy: number): boolean;
}

/** The ids of the page's elements that show a target: the item, or every cue of a caption track. */
const itemIds = (v: View, t: Target): string[] => {
  if (t.kind === 'segment') return [];
  const id = String(t.track.id);
  return (v.state?.resolved?.items ?? []).filter((it) => it.id === id || it.cue?.track === id).map((it) => it.id);
};

const onScreen = (v: View, t: Target): boolean => {
  const r = v.state?.resolved;
  if (!r || t.kind === 'segment') return false;
  const id = t.kind === 'cue' ? String(t.track.id) + '#' + t.cue : String(t.track.id);
  return itemsAt(r, v.frame).some((it) => it.id === id);
};

/** The box after a drag by dx, dy (fractions of the canvas), snapped to whole pixels of a W x H canvas. */
export const draggedBox = (d: Pick<Drag, 'mode' | 'box0'>, dx: number, dy: number, W: number, H: number, keep: boolean): Box4 => {
  const [x, y, w, hh] = d.box0;
  const px = (v: number, n: number): number => Math.round(v * n) / n;
  if (d.mode === 'move') return [px(x + dx, W), px(y + dy, H), w, hh];
  let [l, t, r, b] = [x, y, x + w, y + hh];
  if (d.mode.includes('w')) l += dx;
  if (d.mode.includes('e')) r += dx;
  if (d.mode.includes('n')) t += dy;
  if (d.mode.includes('s')) b += dy;
  if (keep) {
    const ratio = (w * W) / (hh * H);
    const nw = r - l;
    const nh = b - t;
    const byWidth = d.mode.length === 1 ? d.mode === 'e' || d.mode === 'w' : Math.abs(nw / w - 1) >= Math.abs(nh / hh - 1);
    if (byWidth) {
      const h2 = (nw * W) / ratio / H;
      if (d.mode.includes('n')) t = b - h2; else if (d.mode.includes('s')) b = t + h2; else { t = y + hh / 2 - h2 / 2; b = t + h2; }
    } else {
      const w2 = (nh * H * ratio) / W;
      if (d.mode.includes('w')) l = r - w2; else if (d.mode.includes('e')) r = l + w2; else { l = x + w / 2 - w2 / 2; r = l + w2; }
    }
  }
  const [L, T, R, B] = [px(l, W), px(t, H), px(r, W), px(b, H)];
  return [Math.min(L, R - 1 / W), Math.min(T, B - 1 / H), Math.max(1 / W, R - L), Math.max(1 / H, B - T)];
};

const readoutText = (b: Box4, W: number, H: number): string => {
  const p = (v: number, n: number): string => String(Math.round(v * n));
  const f = (v: number): string => v.toFixed(3);
  return 'x ' + p(b[0], W) + '  y ' + p(b[1], H) + '  ' + p(b[2], W) + '×' + p(b[3], H) + ' px   (' + [b[0], b[1], b[2], b[3]].map(f).join(', ') + ')';
};

/** Moves the page's elements of a target while dragging, and puts their style back when the edit is refused. */
const pagePreview = (iframe: HTMLIFrameElement, store: Store) => {
  let saved = new Map<HTMLElement, string>();
  return {
    move: (t: Target, box: Box4): void => {
      const doc = iframe.contentDocument;
      const { W, H } = canvasOf(store.get());
      for (const id of itemIds(store.get(), t)) {
        const el = doc?.querySelector<HTMLElement>('[data-item="' + CSS.escape(id) + '"]');
        if (!el) continue;
        if (!saved.has(el)) saved.set(el, el.style.cssText);
        Object.assign(el.style, { left: box[0] * W + 'px', top: box[1] * H + 'px', width: box[2] * W + 'px', height: box[3] * H + 'px' });
      }
    },
    restore: (): void => {
      saved.forEach((css, el) => { el.style.cssText = css; });
      saved = new Map();
    },
    /** The page was loaded again: the elements kept are gone. */
    forget: (): void => { saved = new Map(); },
  };
};

const canvasOf = (v: View): { W: number; H: number } => ({ W: v.state?.resolved?.canvas.width ?? 1, H: v.state?.resolved?.canvas.height ?? 1 });

/** The id of the nearest item under the point at the shell's frame (items are in drawing order, nearest last). */
const hitAt = (frameBox: HTMLElement, v: View, x: number, y: number): string | undefined => {
  const r = v.state?.resolved;
  if (!r) return undefined;
  const rect = frameBox.getBoundingClientRect();
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  return [...itemsAt(r, v.frame)].reverse().find((it) => fx >= it.box[0] && fx <= it.box[0] + it.box[2] && fy >= it.box[1] && fy <= it.box[1] + it.box[3])?.id;
};

interface Ui { layer: HTMLElement; sel: HTMLElement; readout: HTMLElement }

/** The selection's box (or the box being dragged or nudged) with its handles, and the numbers while it moves. */
const drawBox = (ui: Ui, v: View, moving: Box4 | undefined): void => {
  const t = v.state ? targetOf(v.state, v.pinned) : undefined;
  const box = moving ?? (t && v.state ? boxOf(v.state, t) : undefined);
  const shown = Boolean(box && t && (moving || onScreen(v, t)));
  ui.layer.classList.toggle('off', !v.state?.resolved);
  ui.sel.hidden = !shown;
  ui.readout.hidden = !moving;
  if (shown && box) { placeBox(ui.sel, box); ui.sel.classList.toggle('thin', ui.sel.getBoundingClientRect().height < 18); }
  if (moving) {
    const { W, H } = canvasOf(v);
    ui.readout.textContent = readoutText(moving, W, H);
  }
};

const selected = (v: View): { t: Target; box: Box4 } | undefined => {
  const t = v.state ? targetOf(v.state, v.pinned) : undefined;
  const box = t && v.state ? boxOf(v.state, t) : undefined;
  return t && box ? { t, box } : undefined;
};

export const mountStageEdit = (frameBox: HTMLElement, iframe: HTMLIFrameElement, store: Store, edit: EditActions): StageEdit => {
  const sel = h('div', { class: 'sel-box', id: 'sel-box' }, HANDLES.map((k) => h('div', { class: 'handle h-' + k, data: { h: k } })));
  const readout = h('div', { class: 'drag-readout', id: 'drag-readout' });
  const slotOutline = h('div', { class: 'studio-slot-outline', attrs: { hidden: '' } }, [h('span',{class:'studio-slot-name'})]);
  const ui: Ui = { layer: h('div', { class: 'edit-layer', id: 'edit-layer' }, [sel, readout]), sel, readout };
  ui.layer.append(slotOutline);
  frameBox.append(ui.layer);
  const page = pagePreview(iframe, store);
  let drag: Drag | undefined;
  let pending: { box: Box4; target: Target } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revealPending = true;
  const draw = (): void => {
    const v=store.get();drawBox(ui,v,drag && !drag.moved ? undefined : pending?.box);
    const picked=v.pinned; const slot=picked?.kind==='slot'?visibleSlots(iframe,store).find(s=>s.selection.id===picked.id&&s.selection.name===picked.name):undefined;
    if(picked?.kind==='slot'&&revealPending&&document.body.dataset.ready==='1'){
      revealPending=false;const frame=slotFrame(iframe,store,picked);if(frame===undefined){edit.select(null);return;}if(frame!==v.frame){edit.reveal(picked,frame);return;}
    }
    slotOutline.hidden=!slot;if(slot){placeBox(slotOutline,slot.box);slotOutline.firstElementChild!.textContent=slot.value.slice(0,40);}
  };
  const commit = (t: Target, box: Box4): void => {
    const path = boxPath(t);
    if (!path) return;
    void edit.send({ op: 'set', path, value: roundBox(box) }).then((ok) => {
      if (!ok) page.restore();
      pending = undefined;
      draw();
    });
  };
  const show = (t: Target, box: Box4): void => {
    pending = { box, target: t };
    page.move(t, box);
    draw();
  };

  ui.layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !store.get().state?.resolved) return;
    // A field being typed in commits when it loses the focus; preventDefault below would keep the focus where it is.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.handle')?.dataset.h as Drag['mode'] | undefined;
    if (!handle && !(e.target as HTMLElement).closest('.sel-box')) {
      const id = hitAt(frameBox, store.get(), e.clientX, e.clientY);
      if (!id) {
        const rect=frameBox.getBoundingClientRect();const x=(e.clientX-rect.left)/rect.width,y=(e.clientY-rect.top)/rect.height;
        const slot=visibleSlots(iframe,store).reverse().find(s=>x>=s.box[0]&&x<=s.box[0]+s.box[2]&&y>=s.box[1]&&y<=s.box[1]+s.box[3]);
        if(slot){edit.select(slot.selection);e.preventDefault();return;}
      }
      edit.select(id ? { kind: 'item', id } : null);
      if (!id) return;
    }
    const now = selected(store.get());
    if (!now) return;
    drag = { mode: handle ?? 'move', x0: e.clientX, y0: e.clientY, box0: pending?.box ?? now.box, moved: false, target: now.t };
    ui.layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ui.layer.addEventListener('pointermove', (e) => {
    if (!drag || (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 2)) return;
    drag.moved = true;
    const rect = frameBox.getBoundingClientRect();
    const { W, H } = canvasOf(store.get());
    show(drag.target, draggedBox(drag, (e.clientX - drag.x0) / rect.width, (e.clientY - drag.y0) / rect.height, W, H, e.shiftKey));
  });
  const end = (): void => {
    const d = drag;
    drag = undefined;
    if (d?.moved && pending) commit(d.target, pending.box);
    draw();
  };
  ui.layer.addEventListener('pointerup', end);
  ui.layer.addEventListener('pointercancel', end);

  store.subscribe((v, prev) => {
    if (v.state !== prev.state) page.forget();
    if(v.pinned!==prev.pinned||v.state!==prev.state)revealPending=true;
    if (!drag && (v.state !== prev.state || v.pinned !== prev.pinned || v.frame !== prev.frame)) draw();
  });
  iframe.addEventListener('frameapplied', draw);
  new ResizeObserver(draw).observe(frameBox);
  draw();
  return {
    nudge: (dx, dy) => {
      const now = selected(store.get());
      const box = pending?.box ?? now?.box;
      if (!now || !box || drag) return false;
      const { W, H } = canvasOf(store.get());
      const next: Box4 = [Math.round(box[0] * W + dx) / W, Math.round(box[1] * H + dy) / H, box[2], box[3]];
      show(now.t, next);
      if (timer) clearTimeout(timer);
      // Nudges a moment apart become one step of the history.
      timer = setTimeout(() => commit(now.t, next), 400);
      return true;
    },
  };
};
