import { h } from '../dom';
import type { Store } from '../app';
import type { PreviewState } from '../../protocol';
import { copy } from './copy';
export const button = (text: string, run: () => void, cls = ''): HTMLButtonElement => h('button', { class: 'studio-btn ' + cls, text, attrs: { type: 'button' }, on: { click: run } });
export const title = (text: string, sub?: string): HTMLElement => h('div', { class: 'studio-heading' }, [h('h2', { text }), ...(sub ? [h('small', { text: sub })] : [])]);
export const note = (text: string, cls = ''): HTMLElement => h('p', { class: 'studio-note ' + cls, text });
export const fileUrl = (file: string): string => '/project/' + file.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/');
export const download = (text: string, name: string): void => { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = h('a', { attrs: { href: url, download: name } }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
export const notify = (store: Store, message: string): void => { const root = document.getElementById('studio-message'); if (root) { root.textContent = message; root.classList.add('visible'); setTimeout(() => root.classList.remove('visible'), 6000); } else store.set({ pageError: message }); };
export const request = async <T>(url: string, body?: unknown): Promise<T> => {
 const r = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), cache: 'no-store' });
 const result = await r.json() as T & { ok?: boolean; problems?: { message: string }[] };
 if (!r.ok || result.ok === false) throw new Error(result.problems?.[0]?.message ?? 'Request failed: ' + r.status);
 return result;
};
export const mutate = async (store: Store, path: string, body: unknown): Promise<void> => {
 try { const r = await request<{ state: PreviewState }>(path, body); store.set({ state: r.state }); }
 catch (e) { notify(store, e instanceof Error ? e.message : copy(store, 'error')); }
};
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(object) : [];
export const input = (value: string, label: string, change?: (value: string) => void): HTMLInputElement => {
 const el = h('input', { attrs: { type: 'text', 'aria-label': label }, class: 'studio-input' }); el.value = value;
 if (change) el.addEventListener('change', () => change(el.value)); return el;
};
export const select = (values: readonly [string, string][], value: string, label: string, change: (v: string) => void): HTMLSelectElement => {
 const el = h('select', { class: 'studio-input', attrs: { 'aria-label': label } }, values.map(([v, text]) => h('option', { text, attrs: { value: v } }))); el.value = value;
 el.addEventListener('change', () => change(el.value)); return el;
};
export const field = (label: string, element: HTMLElement): HTMLElement => h('label', { class: 'studio-field' }, [h('span', { text: label }), element]);
export const thumbnail = (frame: number, generation: number): HTMLImageElement => h('img', { class: 'studio-thumb', attrs: { src: '/api/thumbnail?frame=' + Math.floor(frame) + '&g=' + generation, loading: 'lazy', alt: '' } });
export const timecode = (frame: number, fps: number): string => { const seconds = Math.floor(frame / fps); return [Math.floor(seconds / 60), seconds % 60, frame % Math.round(fps)].map(x => Math.floor(x).toString().padStart(2, '0')).join(':'); };
