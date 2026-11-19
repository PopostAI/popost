import { useSyncExternalStore } from 'react';
import type { EditorController, EditorSnapshot } from '../contracts';

/** Re-render on every controller snapshot change. */
export function useSnapshot(controller: EditorController): EditorSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
