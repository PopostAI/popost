/** Editor actions shared by the keyboard map, the selection pill and the status bar. */
import type { EditOp, EditorController, NodeId } from '../contracts';
import { blockKind } from '../core/pages';
import { dismissTop } from './dismiss';
import type { Gestures } from './interaction/gestures';
import { reorderOp, topLevelIds } from './logic/blocks';
import { pasteStyleOps, pickCopiedStyle, STYLE_COPY_PROPS } from './logic/style-copy';
import type { CopiedStyle } from './logic/style-copy';
import { moveProps, NUDGE_STYLE_PROPS, readPlacement } from './logic/geometry';
import type { KeyAction } from './logic/keymap';
import type { MessageKey } from './i18n';
import type { ShowToast } from './toasts';

export interface ZoomControls {
  step(direction: 1 | -1): void;
  fit(): void;
}

export interface ActionDeps {
  controller: EditorController;
  gestures: Pick<Gestures, 'cancel'>;
  zoom: ZoomControls;
  toast: ShowToast;
  t: (key: MessageKey) => string;
}

export interface Actions {
  /** Run a keymap action; false when it did nothing (so the key keeps its default). */
  run(action: KeyAction): boolean;
  duplicateSelection(): void;
  deleteSelection(): void;
  reorderSelection(direction: 'up' | 'down'): void;
  nudgeSelection(dx: number, dy: number): void;
  copyStyle(): void;
  pasteStyle(): void;
  changePage(direction: 'prev' | 'next'): void;
  escape(): void;
}

export function createActions(deps: ActionDeps): Actions {
  const { controller: c, gestures, zoom, toast, t } = deps;

  const selected = (): NodeId[] => topLevelIds(c.index(), c.getSnapshot().selection);

  const duplicateSelection = (): void => {
    const ids = selected();
    if (ids.length) c.applyBatch(ids.map((id): EditOp => ({ kind: 'duplicate', id })), 'duplicate');
  };

  const deleteSelection = (): void => {
    const ids = selected();
    if (ids.length === 0) return;
    c.applyBatch(ids.map((id): EditOp => ({ kind: 'remove', id })), 'delete');
    toast(t('toast.deleted'));
  };

  const reorderSelection = (direction: 'up' | 'down'): void => {
    const { selection } = c.getSnapshot();
    const id = selection[0];
    if (selection.length !== 1 || id === undefined) return;
    const op = reorderOp(c.index(), id, direction);
    if (op) c.apply(op, { label: 'reorder' });
  };

  const nudgeSelection = (dx: number, dy: number): void => {
    const ids = selected();
    if (ids.length === 0) return;
    const ops = ids.map((id): EditOp => ({ kind: 'setStyle', id, props: moveProps(readPlacement(c.styles(id, NUDGE_STYLE_PROPS)), dx, dy) }));
    c.applyBatch(ops, 'nudge', { coalesceKey: `nudge:${ids.join(',')}` });
  };

  const scaleSelection = (direction: 1 | -1): boolean => {
    const id = selected()[0];
    if (!id || selected().length !== 1) return false;
    const kind = blockKind(c.index(), id);
    if (kind !== 'image' && kind !== 'svg' && kind !== 'video') return false;
    const style = c.styles(id, ['width', 'height']);
    const rect = c.getSnapshot().rects[id];
    const width = Number.parseFloat(style.width) || rect?.width;
    const height = Number.parseFloat(style.height) || rect?.height;
    if (!width || !height) return false;
    const factor = direction === 1 ? 1.1 : 1 / 1.1;
    c.applyBatch([{ kind: 'setStyle', id, props: {
      width: `${Math.max(8, Math.round(width * factor))}px`,
      height: `${Math.max(8, Math.round(height * factor))}px`,
    } }], 'resize', { coalesceKey: `keyboard-resize:${id}` });
    return true;
  };

  /** The block whose style is copied / pasted onto: the one being edited, else the (first) selected one. */
  const styleTargets = (): NodeId[] => {
    const snap = c.getSnapshot();
    return snap.editingTextId ? [snap.editingTextId] : [...snap.selection];
  };

  let copied: CopiedStyle | null = null;

  const copyStyle = (): void => {
    const id = styleTargets()[0];
    if (id === undefined) return;
    copied = pickCopiedStyle(c.styles(id, [...STYLE_COPY_PROPS]));
    toast(t('toast.styleCopied'));
  };

  const pasteStyle = (): void => {
    if (!copied) {
      toast(t('toast.styleNothing'));
      return;
    }
    const ids = styleTargets();
    if (ids.length === 0) return;
    c.applyBatch(pasteStyleOps(ids, copied), 'paste style');
    toast(t('toast.stylePasted'));
  };

  const changePage = (direction: 'prev' | 'next'): void => {
    const { pages, currentPageId } = c.getSnapshot();
    const at = pages.findIndex((p) => p.id === currentPageId);
    const target = pages[at + (direction === 'next' ? 1 : -1)];
    if (target) c.setCurrentPage(target.id);
  };

  /** Esc: running drag -> open popover -> text edit -> selection. */
  const escape = (): void => {
    if (gestures.cancel() || dismissTop()) return;
    const snap = c.getSnapshot();
    if (snap.editingTextId) c.endTextEdit(true);
    else if (snap.selection.length) c.select([]);
  };

  const run = (action: KeyAction): boolean => {
    const snap = c.getSnapshot();
    switch (action.type) {
      case 'save':
        void c.save();
        return true;
      case 'undo':
        gestures.cancel();
        c.undo();
        return true;
      case 'redo':
        gestures.cancel();
        c.redo();
        return true;
      case 'zoom':
        if (action.mode === 'fit') zoom.fit();
        else zoom.step(action.mode === 'in' ? 1 : -1);
        return true;
      case 'scaleSelection':
        return scaleSelection(action.direction);
      case 'duplicate':
        duplicateSelection();
        return true;
      case 'delete':
        deleteSelection();
        return true;
      case 'edit': {
        const id = snap.selection[0];
        if (id === undefined || blockKind(c.index(), id) !== 'text') return false;
        c.beginTextEdit(id, 'end');
        return true;
      }
      case 'escape':
        escape();
        return true;
      case 'nudge':
        nudgeSelection(action.dx, action.dy);
        return true;
      case 'reorder':
        reorderSelection(action.direction);
        return true;
      case 'page':
        changePage(action.direction);
        return true;
      case 'copyStyle':
        if (styleTargets().length === 0) return false;
        copyStyle();
        return true;
      case 'pasteStyle':
        if (styleTargets().length === 0) return false;
        pasteStyle();
        return true;
    }
  };

  return { run, duplicateSelection, deleteSelection, reorderSelection, nudgeSelection, copyStyle, pasteStyle, changePage, escape };
}
