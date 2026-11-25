import type { NativeDraftResult } from '../../../draft/native';
import type { DraftOpenResult } from '../../../draft/lifecycle';
import type { Store } from '../app';
import { h } from '../dom';
import { button, note, notify, request, title } from './ui';

export const showDraftImported = (store: Store, result: NativeDraftResult): void => {
  const zh = store.get().lang === 'zh';
  const text = (cn: string, en: string): string => zh ? cn : en;
  const label = result.target === 'jianying' ? text('剪映专业版', 'Jianying Pro') : 'CapCut';
  let busy = false;
  const close = (): void => {
    if (busy) return;
    dialog.remove(); scrim.remove(); document.getElementById('studio-export-open')?.focus();
  };
  const scrim = h('div', { class: 'studio-scrim', on: { click: close } });
  const dialog = h('aside', { class: 'studio-export studio-draft-success', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': text('已导入', 'Imported into ') + label } });
  const detail = note(result.productRunning
    ? text('重启' + label + '即可在本地草稿看到「' + result.name + '」。', 'Restart ' + label + ' to find “' + result.name + '” in local drafts.')
    : text('已保存到本机草稿，打开' + label + '即可查看「' + result.name + '」。', 'Open ' + label + ' to find “' + result.name + '” in local drafts.'));
  const status = h('div', { attrs: { role: 'status' } });
  const later = button(text('稍后', 'Later'), close);
  const cancel = button('×', close); cancel.setAttribute('aria-label', text('关闭', 'Close'));
  const labelOfOpen = result.productRunning ? text('重启', 'Restart ') + label : text('打开', 'Open ') + label;
  const open = button(labelOfOpen, () => { void (async () => {
    busy = true; open.disabled = later.disabled = cancel.disabled = true; open.textContent = text('正在打开…', 'Opening…'); status.replaceChildren();
    try {
      const response = await request<{ result: DraftOpenResult }>('/api/studio/draft-open', { receiptId: result.receiptId });
      if (!response.result.ok) {
        status.replaceChildren(note(response.result.quitPending
          ? text(label + '还未退出，请先在应用中保存或关闭弹窗，然后重试。草稿已经保存。', label + ' has not exited. Save your work or close its dialog, then retry. Your draft is already saved.')
          : response.result.message ?? text('应用未能打开，请重试。草稿已经保存。', 'The editor did not open. Retry; your draft is already saved.'), 'bad'));
        return;
      }
      busy = false; close();
      notify(store, response.result.restarted ? text('已重启', 'Restarted ') + label : text('已打开', 'Opened ') + label);
    } catch (error) { status.replaceChildren(note(String(error), 'bad')); }
    finally { busy = false; open.disabled = later.disabled = cancel.disabled = false; open.textContent = labelOfOpen; }
  })(); }, 'primary');
  if (!result.canOpen) status.append(note(text('未找到应用安装位置，可以稍后手动打开。草稿和素材已保存到本机。', 'The app location could not be found. Open it manually later; the draft and media are saved locally.')));
  dialog.append(h('div', { class: 'studio-export-header' }, [title(text('已导入', 'Imported into ') + label), cancel]), detail, status, h('div', { class: 'studio-draft-actions' }, [later, ...(result.canOpen ? [open] : [])]));
  document.body.append(scrim, dialog);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')), first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  (result.canOpen ? open : later).focus();
};
