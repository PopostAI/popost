export type EditorMessageType = 'saved' | 'notes' | 'download-images' | 'store';

export interface EditorMessage {
  source: 'popost-editor';
  type: EditorMessageType;
  id: string;
  [extra: string]: unknown;
}

/** True when the editor is nested in another window (the web app); standalone pages never post. */
export function hasHostWindow(): boolean {
  return window.parent !== window;
}

/** Post to the embedding web app with `targetOrigin = location.origin`. Returns false when not embedded. */
export function postToHost(message: EditorMessage): boolean {
  if (!hasHostWindow()) return false;
  window.parent.postMessage(message, window.location.origin);
  return true;
}

/** Accept only messages from the embedding window, same origin, with the expected `source`. */
export function isFromHost(event: MessageEvent, source: string): boolean {
  if (event.source !== window.parent || event.origin !== window.location.origin) return false;
  const data: unknown = event.data;
  return typeof data === 'object' && data !== null && (data as { source?: unknown }).source === source;
}
