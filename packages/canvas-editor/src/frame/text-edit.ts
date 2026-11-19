/** Inline text editing of one block via `contenteditable` (SPEC section 6). */
import type { FrameToShell, NodeId, TextFormat } from '../contracts';
import { cleanHTML } from './clean';
import { applyFormat, selectedRange } from './format';
import { findById } from './marks';
import type { FrameState } from './marks';

type TextState = Extract<FrameToShell, { type: 'textState' }>;

interface Active {
  id: NodeId;
  el: HTMLElement;
  originalHTML: string;
  cleanOriginal: string;
  contenteditable: string | null;
  spellcheck: string | null;
  composing: boolean;
  teardown: () => void;
}

export interface TextEditorDeps {
  state: FrameState;
  emit: (msg: FrameToShell) => void;
  /** Frame client coordinates of the page root's top-left (to turn page px into client px). */
  origin: () => { x: number; y: number };
  resetScroll: () => void;
}

function exec(doc: Document, command: string, value?: string): boolean {
  try {
    return typeof doc.execCommand === 'function' ? doc.execCommand(command, false, value) : false;
  } catch {
    return false;
  }
}

function insertLineBreak(doc: Document): void {
  if (exec(doc, 'insertLineBreak')) return;
  const range = doc.getSelection()?.rangeCount ? doc.getSelection()!.getRangeAt(0) : null;
  if (!range) return;
  range.deleteContents();
  const br = doc.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
}

/** Insert plain text (newlines become line breaks) at the caret. */
export function insertPlainText(doc: Document, text: string): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) insertLineBreak(doc);
    if (!line) return;
    if (exec(doc, 'insertText', line)) return;
    const sel = doc.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range) return;
    range.deleteContents();
    const node = doc.createTextNode(line);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
  });
}

function caretFromPoint(doc: Document, x: number, y: number): Range | null {
  const d = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof d.caretRangeFromPoint === 'function') return d.caretRangeFromPoint(x, y);
  const pos = typeof d.caretPositionFromPoint === 'function' ? d.caretPositionFromPoint(x, y) : null;
  if (!pos) return null;
  const range = doc.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  range.collapse(true);
  return range;
}

export class TextEditor {
  private cur: Active | null = null;

  constructor(private readonly deps: TextEditorDeps) {}

  get editingId(): NodeId | null {
    return this.cur?.id ?? null;
  }

  /** True when `node` is inside the edited block. */
  contains(node: Node | null): boolean {
    return !!this.cur && !!node && this.cur.el.contains(node);
  }

  begin(id: NodeId, caret: 'end' | 'all' | 'point', x?: number, y?: number): void {
    const doc = this.deps.state.doc;
    if (this.cur && this.cur.id !== id) this.end(true);
    const el = findById(doc, id);
    if (!el) return;
    if (!this.cur) this.activate(id, el);
    el.focus({ preventScroll: true });
    this.placeCaret(el, caret, x, y);
    this.deps.resetScroll();
    this.emitState();
  }

  /** Leave edit mode; emits `textCommit` (changed) or `textCancel`. */
  end(commit: boolean): void {
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    cur.teardown();
    const doc = this.deps.state.doc;
    const html = cleanHTML(doc, cur.el.innerHTML);
    const changed = commit && html !== cur.cleanOriginal;
    if (!changed && cur.el.innerHTML !== cur.originalHTML) cur.el.innerHTML = cur.originalHTML;
    this.restoreAttr(cur.el, 'contenteditable', cur.contenteditable);
    this.restoreAttr(cur.el, 'spellcheck', cur.spellcheck);
    doc.getSelection()?.removeAllRanges();
    cur.el.blur();
    this.deps.resetScroll();
    this.deps.emit(changed ? { type: 'textCommit', id: cur.id, html } : { type: 'textCancel', id: cur.id });
  }

  format(format: TextFormat): void {
    const cur = this.cur;
    if (!cur) return;
    if (applyFormat(this.deps.state.doc, cur.el, format)) this.emitState();
  }

  /** Forget the edit without emitting (remount / dispose / block removed). */
  discard(): void {
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    cur.teardown();
  }

  /** Drop the edit silently when its element left the document (live update replaced it). */
  checkConnected(): void {
    if (this.cur && !this.cur.el.isConnected) this.discard();
  }

  emitState(): void {
    const cur = this.cur;
    if (!cur) return;
    const doc = this.deps.state.doc;
    const query = (c: string): boolean => {
      try {
        return typeof doc.queryCommandState === 'function' && doc.queryCommandState(c);
      } catch {
        return false;
      }
    };
    const msg: TextState = {
      type: 'textState',
      id: cur.id,
      range: selectedRange(doc, cur.el) !== null,
      active: {
        bold: query('bold'),
        italic: query('italic'),
        underline: query('underline'),
        strike: query('strikeThrough'),
      },
    };
    this.deps.emit(msg);
  }

  private restoreAttr(el: Element, name: string, value: string | null): void {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  private activate(id: NodeId, el: HTMLElement): void {
    const doc = this.deps.state.doc;
    const originalHTML = el.innerHTML;
    const cur: Active = {
      id,
      el,
      originalHTML,
      cleanOriginal: cleanHTML(doc, originalHTML),
      contenteditable: el.getAttribute('contenteditable'),
      spellcheck: el.getAttribute('spellcheck'),
      composing: false,
      teardown: () => undefined,
    };
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');

    const onKeyDown = (e: KeyboardEvent): void => {
      if (cur.composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        this.end(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertLineBreak(doc);
      }
    };
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault();
      insertPlainText(doc, e.clipboardData?.getData('text/plain') ?? '');
    };
    const onBlur = (): void => this.end(true);
    const onCompStart = (): void => void (cur.composing = true);
    const onCompEnd = (): void => void (cur.composing = false);
    const onSelection = (): void => {
      const sel = doc.getSelection();
      if (sel?.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) this.emitState();
    };
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('paste', onPaste);
    el.addEventListener('blur', onBlur);
    el.addEventListener('compositionstart', onCompStart);
    el.addEventListener('compositionend', onCompEnd);
    doc.addEventListener('selectionchange', onSelection);
    cur.teardown = () => {
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('compositionstart', onCompStart);
      el.removeEventListener('compositionend', onCompEnd);
      doc.removeEventListener('selectionchange', onSelection);
    };
    this.cur = cur;
  }

  private placeCaret(el: HTMLElement, caret: 'end' | 'all' | 'point', x?: number, y?: number): void {
    const doc = this.deps.state.doc;
    const sel = doc.getSelection();
    if (!sel) return;
    let range: Range | null = null;
    if (caret === 'point' && x !== undefined && y !== undefined) {
      const o = this.deps.origin();
      const r = caretFromPoint(doc, x + o.x, y + o.y);
      if (r && el.contains(r.startContainer)) range = r;
    }
    if (!range) {
      range = doc.createRange();
      range.selectNodeContents(el);
      if (caret !== 'all') range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
