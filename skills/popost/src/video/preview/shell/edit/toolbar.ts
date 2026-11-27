/**
 * Edit mode's buttons (in the header), its status line (at the top of the side panel) and its keys: Ctrl+Z undo,
 * Shift+Ctrl+Z (or Ctrl+Y) redo, Delete removes the selection, Escape clears it, arrows nudge a selected item by one
 * pixel of the canvas (Shift: ten). Keys typed into a field belong to the field.
 */
import type { Store, View } from '../app';
import { h, icon, type IconName } from '../dom';
import { t, type Key, type Lang } from '../i18n';
import type { EditActions } from './controller';

interface Tool { id: string; icon: IconName; title: Key; run: () => void; enabled: (v: View) => boolean }

export const mountToolbar = (root: HTMLElement, store: Store, edit: EditActions): void => {
  const tools: Tool[] = [
    { id: 'edit-undo', icon: 'undo', title: 'undo', run: () => void edit.undo(), enabled: (v) => (v.state?.edit?.undo ?? 0) > 0 },
    { id: 'edit-redo', icon: 'redo', title: 'redo', run: () => void edit.redo(), enabled: (v) => (v.state?.edit?.redo ?? 0) > 0 },
    { id: 'edit-add-text', icon: 'addText', title: 'addText', run: () => void edit.addText(), enabled: (v) => Boolean(v.state?.resolved) },
    { id: 'edit-duplicate', icon: 'duplicate', title: 'duplicate', run: () => void edit.duplicate(), enabled: () => edit.target() !== undefined },
    { id: 'edit-delete', icon: 'remove', title: 'remove', run: () => void edit.remove(), enabled: (v) => {const target=edit.target();return Boolean(target && (target.kind !== 'segment' || (v.state?.resolved?.segments.length ?? 0)>1));} },
    { id: 'edit-render', icon: 'render', title: 'renderTool', run: () => void edit.render(), enabled: (v) => Boolean(v.state?.resolved) && v.edit.render?.state !== 'running' },
  ];
  const buttons = tools.map((tool) => {
    const el = h('button', { id: tool.id, class: 'tbtn', attrs: { type: 'button' } }, [icon(tool.icon)]);
    if (['edit-add-text','edit-duplicate','edit-delete'].includes(tool.id)) el.append(h('span',{class:'tool-label'}));
    el.addEventListener('click', () => {
      tool.run();
      el.blur();
    });
    return { tool, el };
  });
  const group = (from: number, to: number): HTMLElement => h('span', { class: 'tool-group' }, buttons.slice(from, to).map((b) => b.el));
  root.append(h('span', { class: 'edit-tools', id: 'edit-tools' }, [group(0, 2), group(2, 5), group(5, 6)]));
  const draw = (v: View): void => {
    for (const b of buttons) {
      b.el.title = t(v.lang, b.tool.title);
      const label = b.el.querySelector('.tool-label'); if(label) label.textContent = b.tool.id === 'edit-add-text' ? (v.lang==='zh'?'文字':'Text') : b.tool.id === 'edit-duplicate' ? (v.lang==='zh'?'复制':'Duplicate') : (v.lang==='zh'?'删除':'Delete');
      b.el.setAttribute('aria-label', t(v.lang, b.tool.title));
      b.el.disabled = Boolean(v.edit.saving) || !b.tool.enabled(v);
    }
  };
  draw(store.get());
  store.subscribe((v, prev) => { if (v.state !== prev.state || v.lang !== prev.lang || v.pinned !== prev.pinned || v.edit.render !== prev.edit.render || v.edit.saving !== prev.edit.saving) draw(v); });
};

const STEP_WORD: Readonly<Record<string, Key>> = { set: 'saved', insert: 'added', remove: 'removed', move: 'moved', outside: 'outside' };

/** The status line's text: what the last step did, or why it was not saved. */
export const statusText = (v: View): string => {
  const s = v.edit.status;
  const lang = v.lang;
  if (!s) return '';
  if (s.kind === 'note') return t(lang, s.key === 'phraseSpan' ? 'phraseSpan' : 'offlineEdit');
  if (s.kind === 'refused') return t(lang, 'notSaved') + ': ' + (s.problem.at.startsWith('(') ? '' : s.problem.at + ': ') + s.problem.message + (s.problem.fix ? ' ' + t(lang, 'fix') + ': ' + s.problem.fix : '');
  const what = s.step === 'outside' ? t(lang, 'outside') : s.label;
  if (s.op === 'undo' || s.op === 'redo') return t(lang, s.op === 'undo' ? 'undone' : 'redone') + ': ' + what;
  return t(lang, STEP_WORD[s.op] ?? 'saved') + ': ' + what;
};

const renderLine = (v: View, edit: EditActions, lang: Lang): (HTMLElement | string)[] => {
  const r = v.edit.render;
  if (!r || r.state === 'idle') return [];
  if (r.state === 'running') return [h('span', { text: t(lang, 'rendering') + ': ' + r.frame + ' / ' + (r.total || '?') })];
  if (r.state === 'failed') return [h('span', { class: 'bad', text: t(lang, 'renderFailed') + ': ' + r.message })];
  const play = h('button', { id: 'play-render', class: 'link', text: t(lang, v.edit.playRender ? 'showReference' : 'playRender'), attrs: { type: 'button' } });
  play.addEventListener('click', () => edit.togglePlayRender());
  return [h('span', { text: t(lang, 'rendered') + ': ' + r.frames + ' ' + t(lang, 'framesIn') + ' ' + r.seconds + ' s, ', title: r.file }), h('code', { text: r.file.split(/[\\/]/).pop() ?? r.file, title: r.file }), ' ', play];
};

/** The status line at the top of the panel: the last step, and the render. */
export const mountStatus = (panel: HTMLElement, store: Store, edit: EditActions): void => {
  const line = h('div', { id: 'edit-status', class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } });
  const render = h('div', { id: 'render-status', class: 'status-line render' });
  panel.prepend(h('div', { class: 'edit-status' }, [line, render]));
  const draw = (v: View): void => {
    line.textContent = statusText(v);
    line.classList.toggle('bad', v.edit.status?.kind === 'refused');
    render.replaceChildren(...renderLine(v, edit, v.lang));
  };
  draw(store.get());
  store.subscribe((v, prev) => { if (v.edit !== prev.edit || v.lang !== prev.lang) draw(v); });
};

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !['checkbox', 'range', 'button', 'color'].includes(target.type)) ||
  (target instanceof HTMLElement && target.isContentEditable);

/** Edit keys, before the transport's (capture phase): a handled key is not seen by the transport. */
export const editKeys = (store: Store, edit: EditActions, nudge: (dx: number, dy: number) => boolean): void => {
  document.addEventListener('keydown', (e) => {
    if(document.querySelector('[role="dialog"]'))return;
    if (typing(e.target)) {
      if ((e.target as HTMLElement).id === 'stage-text-editor') return;
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const run = (fn: () => void): void => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (mod && key === 'z') return run(() => void (e.shiftKey ? edit.redo() : edit.undo()));
    if (mod && key === 'y') return run(() => void edit.redo());
    if (mod && key === 'd') return run(() => void edit.duplicate());
    if (mod || e.altKey) return;
    if (key === 's') return run(() => void edit.split());
    if (e.key === 'Delete' || e.key === 'Backspace') return run(() => void edit.remove());
    if (e.key === 'Escape') return run(() => edit.select(null));
    const arrows: Readonly<Record<string, [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = arrows[e.key];
    if (!d || !store.get().pinned) return;
    const step = e.shiftKey ? 10 : 1;
    if (nudge(d[0] * step, d[1] * step)) run(() => undefined);
  }, true);
};
