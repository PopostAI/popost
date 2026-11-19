import type { HostParams } from '../contracts';
import { isFromHost, hasHostWindow } from './messaging';

export function applyTheme(mode: 'dark' | 'light'): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

/** M1 `popost-theme` (mode dark|light), or null for anything else. */
export function themeFromMessage(event: MessageEvent): 'dark' | 'light' | null {
  if (!hasHostWindow() || !isFromHost(event, 'popost-workspace')) return null;
  const data = event.data as { type?: unknown; mode?: unknown };
  if (data.type !== 'popost-theme') return null;
  return data.mode === 'dark' || data.mode === 'light' ? data.mode : null;
}

/** Apply the `theme` parameter and follow M1 messages. Returns a disposer. */
export function installTheme(params: Pick<HostParams, 'theme'>, onChange?: (mode: 'dark' | 'light') => void): () => void {
  if (params.theme) applyTheme(params.theme);
  const listener = (event: MessageEvent): void => {
    const mode = themeFromMessage(event);
    if (!mode) return;
    applyTheme(mode);
    onChange?.(mode);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
