/**
 * Editing in the lanes: drag an item's bar to move it in time, its ends to change from / to, and the border after a
 * segment to make that segment longer or shorter (the video's length changes with it, and the readout says by how
 * many frames). Always whole frames; an edge within 4 pixels of the playhead, a segment border or a measured boundary
 * of the reference snaps to it, and the readout names it. One operation is sent when the pointer is released.
 */
import type { PreviewState } from '../../protocol';
import type { Store, View } from '../app';
import { h, placeAt, placeSpan } from '../dom';
import { t, type Key, type Lang } from '../i18n';
import { timelineFrames, type Selection } from '../model';
import type { EditActions } from './controller';
import { rawSpan, snapFrame, snapTargets, spanFor, spanPath, targetOf, type EditOp, type Obj, type SnapTarget, type Target } from './source';

type Mode = 'move' | 'start' | 'end' | 'border';

interface Drag {
  mode: Mode;
  x0: number;
  track: HTMLElement;
  /** Frames of the item (start .. end-1), or of the segment whose end is dragged. */
  start: number;
  end: number;
  target?: Target;
  border?: number;
  /** Placed on spoken words: not dragged (lead and hold are set in the panel). */
  phrase?: boolean;
  moved: boolean;
  result?: { start: number; end: number; snap: SnapTarget };
}

const SNAP_WORD: Readonly<Record<SnapTarget['kind'], Key | null>> = { frame: null, playhead: 'snapPlayhead', segment: 'snapSegment', reference: 'snapReference' };

/** Moves both edges by delta frames; the edge nearer to a snap target decides the shift. */
const moveBoth = (d: Drag, delta: number, targets: readonly SnapTarget[], pxPerFrame: number): { start: number; end: number; snap: SnapTarget } => {
  const a = snapFrame(d.start + delta, targets, pxPerFrame);
  const b = snapFrame(d.end + delta, targets, pxPerFrame);
  const da = a.kind === 'frame' ? Infinity : Math.abs(a.frame - (d.start + delta));
  const db = b.kind === 'frame' ? Infinity : Math.abs(b.frame - (d.end + delta));
  const shift = da <= db && da !== Infinity ? a.frame - d.start : db !== Infinity ? b.frame - d.end : Math.round(delta);
  const snap = da <= db && da !== Infinity ? a : db !== Infinity ? b : { frame: d.start + shift, kind: 'frame' as const };
  return { start: d.start + shift, end: d.end + shift, snap };
};

/** The frames a drag by delta gives, at least one frame long. */
export const dragResult = (d: Pick<Drag, 'mode' | 'start' | 'end'>, delta: number, targets: readonly SnapTarget[], pxPerFrame: number): { start: number; end: number; snap: SnapTarget } => {
  if (d.mode === 'move') return moveBoth(d as Drag, delta, targets, pxPerFrame);
  if (d.mode === 'start') {
    const s = snapFrame(d.start + delta, targets, pxPerFrame);
    return { start: Math.min(s.frame, d.end - 1), end: d.end, snap: s };
  }
  const e = snapFrame(d.end + delta, targets, pxPerFrame);
  return { start: d.start, end: Math.max(e.frame, d.start + 1), snap: e };
};

const readout = (lang: Lang, s: PreviewState, d: Drag, r: NonNullable<Drag['result']>): string => {
  const snapped = SNAP_WORD[r.snap.kind];
  const tail = snapped ? '  · ' + t(lang, 'snapped') + ' ' + t(lang, snapped) : '';
  if (d.mode === 'border') {
    const F = timelineFrames(s);
    const change = r.end - d.end;
    const seg = s.resolved?.segments.find((x) => x.end === d.end);
    return (seg?.id ?? '') + ': ' + (d.end - d.start) + ' → ' + (r.end - d.start) + ' ' + t(lang, 'framesWord') + '  · ' + t(lang, 'videoLength') + ' ' + F + ' → ' + (F + change) + ' (' + (change >= 0 ? '+' : '') + change + ')' + tail;
  }
  return t(lang, 'onFrames') + ' ' + r.start + '..' + (r.end - 1) + tail;
};

/** What a pointer press in the lanes would drag, or undefined (a click then seeks and selects as in the read-only preview). */
const dragOf = (s: PreviewState, target: HTMLElement, x0: number): Drag | undefined => {
  const track = target.closest<HTMLElement>('.lane-track');
  const r = s.resolved;
  if (!track || !r) return undefined;
  const border = target.closest<HTMLElement>('.seg-grip')?.dataset.border;
  if (border !== undefined) {
    const seg = r.segments[Number(border)];
    return seg ? { mode: 'border', x0, track, start: seg.start, end: seg.end, border: Number(border), moved: false } : undefined;
  }
  const picked = target.closest<HTMLElement>('[data-sel]')?.dataset.sel;
  const sel = picked ? (JSON.parse(picked) as Selection) : undefined;
  if (sel?.kind !== 'item') return undefined;
  const t0 = targetOf(s, sel);
  const path = t0 ? spanPath(t0) : undefined;
  const span = t0 && path ? spanOf(t0) : undefined;
  if (!t0 || !span) return undefined;
  const raw = rawSpan(r, span);
  if (!raw) return { mode: 'move', x0, track, start: 0, end: 0, target: t0, phrase: true, moved: false };
  const grip = target.closest<HTMLElement>('.grip')?.dataset.grip;
  return { mode: grip === 'start' || grip === 'end' ? grip : 'move', x0, track, start: raw.start, end: raw.end, target: t0, moved: false };
};

/** The span object of a target in video.json (a cue's own for a cue). */
const spanOf = (t0: Target): Obj | undefined => {
  const span = t0.kind === 'cue' ? (t0.track.cues as unknown[])[t0.cue] : t0.kind === 'track' ? t0.track : undefined;
  const during = span && typeof span === 'object' ? (span as Obj).during : undefined;
  return during && typeof during === 'object' && !Array.isArray(during) ? (during as Obj) : undefined;
};

interface Ui { ghost: HTMLElement; guide: HTMLElement; label: HTMLElement }

/** Follows the pointer: the frames it gives, the ghost of the bar, the guide at the edge and the readout. */
const follow = (lanes: HTMLElement, ui: Ui, drag: Drag, v: View, x: number): void => {
  const s = v.state;
  if (!s || drag.phrase) return;
  const F = timelineFrames(s);
  const pxPerFrame = drag.track.getBoundingClientRect().width / Math.max(1, F);
  const targets = snapTargets(s, v.frame, drag.mode !== 'border');
  const r = dragResult(drag.mode === 'border' ? { mode: 'end', start: drag.start, end: drag.end } : drag, (x - drag.x0) / pxPerFrame, targets, pxPerFrame);
  drag.result = r;
  if (drag.mode !== 'border') drag.track.append(placeSpan(ui.ghost, r.start, r.end, F));
  const layer = lanes.querySelector<HTMLElement>('.playhead-layer');
  if (!layer) return;
  const at = r.snap.kind !== 'frame' ? r.snap.frame : drag.mode === 'end' || drag.mode === 'border' ? r.end : r.start;
  layer.append(placeAt(ui.guide, at, F));
  ui.guide.classList.toggle('snapped', r.snap.kind !== 'frame');
  ui.label.textContent = readout(v.lang, s, drag, r);
  layer.append(placeAt(ui.label, Math.min(at, F * 0.6), F));
};

/** The operation a finished drag makes, or undefined when nothing changed. */
const dragOp = (d: Drag, s: PreviewState): EditOp | undefined => {
  const r = s.resolved;
  if (!r || !d.result) return undefined;
  if (d.mode === 'border') return d.border !== undefined && d.result.end !== d.end ? { op: 'set', path: ['segments', d.border, 'frames'], value: d.result.end - d.start } : undefined;
  const path = d.target ? spanPath(d.target) : undefined;
  const span = d.target ? spanOf(d.target) : undefined;
  if (!path || !span || (d.result.start === d.start && d.result.end === d.end)) return undefined;
  return { op: 'set', path, value: spanFor(r, span, d.result.start, d.result.end) };
};

export const mountLanesEdit = (lanes: HTMLElement, store: Store, edit: EditActions): void => {
  const ui: Ui = { ghost: h('div', { class: 'drag-ghost', id: 'drag-ghost' }), guide: h('div', { class: 'snap-guide', id: 'snap-guide' }), label: h('div', { class: 'lane-readout', id: 'lane-readout' }) };
  let drag: Drag | undefined;
  let swallow = false;

  lanes.addEventListener('pointerdown', (e) => {
    const s = store.get().state;
    if (e.button !== 0 || !s?.edit) return;
    // A field being typed in commits when it loses the focus; the press below keeps the focus, so it is taken here.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    drag = dragOf(s, e.target as HTMLElement, e.clientX);
    if (!drag) return;
    lanes.setPointerCapture(e.pointerId);
    // No text selection while dragging; the click that a press without a drag makes still comes.
    e.preventDefault();
  });
  lanes.addEventListener('pointermove', (e) => {
    if (!drag || (!drag.moved && Math.abs(e.clientX - drag.x0) < 3)) return;
    drag.moved = true;
    follow(lanes, ui, drag, store.get(), e.clientX);
  });
  const end = (): void => {
    const d = drag;
    drag = undefined;
    [ui.ghost, ui.guide, ui.label].forEach((el) => el.remove());
    if (!d?.moved) return;
    swallow = true;
    // The click that follows a drag comes in this same task, if at all.
    setTimeout(() => { swallow = false; }, 0);
    const s = store.get().state;
    if (d.phrase) return edit.note('phraseSpan');
    const op = s ? dragOp(d, s) : undefined;
    if (op) void edit.send(op);
  };
  lanes.addEventListener('pointerup', end);
  lanes.addEventListener('pointercancel', end);
  // A drag ends with a click on what was dragged; it must not seek or select as a click does.
  lanes.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopImmediatePropagation();
  }, true);
};
