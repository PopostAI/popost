import type { EditorController } from '../contracts';

/** Keep the test-contract attributes on `body` in sync: `data-doc-state|path|seq` and `data-slide-count`. */
export function bindTestHooks(controller: EditorController, body: HTMLElement): () => void {
  const sync = (): void => {
    const s = controller.getSnapshot();
    const values: Record<string, string> = {
      'data-doc-state': s.docState,
      'data-doc-path': s.path,
      'data-doc-seq': String(s.sourceVersion),
      'data-slide-count': String(s.pages.length),
    };
    for (const [name, value] of Object.entries(values)) if (body.getAttribute(name) !== value) body.setAttribute(name, value);
  };
  sync();
  return controller.subscribe(sync);
}
