import { h } from '../dom';
import type { Store } from '../app';
import type { EditActions } from '../edit/controller';
import { button, download, note, title } from './ui';
import { copy } from './copy';

export const createCodeEditor = (store: Store, edit: EditActions): { root: HTMLElement; flush(): Promise<boolean> } => {
 const area = h('textarea', { id: 'studio-json', class: 'studio-json', attrs: { spellcheck: 'false', 'aria-label': 'video.json' } });
 const status = h('div', { class: 'studio-code-status', attrs: { role: 'status' } });
 let saving: Promise<void> | undefined;
 let base: unknown; let dirty = false; let busy = false; let timer: ReturnType<typeof setTimeout> | undefined;
 const load = (): void => { base = store.get().state?.source; area.value = JSON.stringify(base, null, 2) ?? ''; dirty = false; status.textContent = copy(store, 'autosave'); };
 const perform = async (): Promise<void> => {
   if (!dirty || busy) return;
   let source: unknown;
   try { source = JSON.parse(area.value); } catch (e) { status.textContent = copy(store, 'invalid') + ': ' + (e instanceof Error ? e.message : ''); return; }
   busy = true; status.textContent = copy(store, 'saving'); const sent = area.value;
   const ok = await edit.replace(source, base);
   busy = false;
   if (ok) { base = store.get().state?.source; dirty = sent !== area.value; status.textContent = copy(store, 'sourceChanged'); if (dirty) setTimeout(() => void save(), 0); }
   else { status.textContent = store.get().edit.problems[0]?.message ?? copy(store, 'conflict'); }
 };
 const save = (): Promise<void> => saving ??= perform().finally(() => { saving = undefined; });
 area.addEventListener('input', () => { dirty = true; if (timer) clearTimeout(timer); timer = setTimeout(() => void save(), 650); });
 area.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  if (e.key === 'Tab') { e.preventDefault(); area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end'); area.dispatchEvent(new Event('input')); }
 });
 window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
 const format = (): void => { try { area.value = JSON.stringify(JSON.parse(area.value), null, 2); area.dispatchEvent(new Event('input')); } catch { status.textContent = copy(store, 'invalid'); } };
 const root = h('div', { class: 'studio-code-wrap' }, [title(copy(store, 'sourceTitle'), 'video.json'), note(copy(store, 'codeHint')), h('div', { class: 'studio-actions' }, [button(copy(store, 'format'), format), button(copy(store, 'download'), () => download(area.value, 'video.json'))]), area, status, button(copy(store, 'reload'), load)]);
 store.subscribe((v, prev) => {
  if (v.state?.source === prev.state?.source) return;
  if (!dirty && !busy) load();
  else if (!busy && JSON.stringify(v.state?.source) !== JSON.stringify(base)) status.textContent = copy(store, 'conflict');
 });
 load(); return {root, flush: async () => { clearTimeout(timer); if (saving) await saving; if (dirty) await save(); return !dirty; }};
};
