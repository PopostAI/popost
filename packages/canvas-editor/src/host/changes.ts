import { hasHostWindow, isFromHost } from './messaging';

/** M8 `store-changed` for this project: the stored document changed outside this editor (another tab, an agent). */
export function isStoreChange(event: MessageEvent, id: string): boolean {
  if (!hasHostWindow() || !isFromHost(event, 'popost-workspace')) return false;
  const data = event.data as { type?: unknown; id?: unknown };
  return data.type === 'store-changed' && data.id === id;
}

/** Follow M8 messages for project `id` (`store=host` only). Returns a disposer. */
export function installStoreChanges(id: string, onChange: () => void): () => void {
  const listener = (event: MessageEvent): void => {
    if (isStoreChange(event, id)) onChange();
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
