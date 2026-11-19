/** FrameController: preview URL lifecycle around a Session. */
import type { DocIndex, DocStore, FrameController, FrameToShell, NodeId } from '../contracts';
import { buildPreview } from '../core/preview';
import { pageRoots } from '../core/pages';
import { FRAME_CSS } from './frame-css';
import { createSession } from './session';
import type { Session } from './session';

export interface FrameControllerOptions {
  store: Pick<DocStore, 'preview'>;
  /** Local mode: '/pages/' (becomes <base href> in the preview). */
  baseHref?: string;
  /** Host mode: extra `https:` image origins for the preview CSP. */
  imageOrigins?: readonly string[];
  /** Nonce passed to DocStore.preview (local server contract: 32 lowercase hex). Default: crypto-random 32 hex. */
  nonce?: () => string;
}

const LOAD_TIMEOUT_MS = 30_000;
const SUPERSEDED = Symbol('superseded');

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve with the loaded document once `url` has loaded in `iframe`; SUPERSEDED when `cancel` fires first. */
function loadFrame(
  iframe: HTMLIFrameElement,
  url: string,
  onCancel: (cancel: () => void) => void,
): Promise<Document | null | typeof SUPERSEDED> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readyPoll: ReturnType<typeof setInterval> | undefined;
    const finish = (): void => {
      iframe.removeEventListener('load', onLoad);
      clearTimeout(timer);
      clearInterval(readyPoll);
    };
    const onLoad = (): void => {
      let doc: Document | null = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        doc = null;
      }
      // The initial about:blank load of a fresh iframe is not ours.
      if (doc && doc.location?.href === 'about:blank' && url !== 'about:blank') return;
      finish();
      resolve(doc);
    };
    onCancel(() => {
      finish();
      resolve(SUPERSEDED);
    });
    timer = setTimeout(() => {
      finish();
      reject(new Error('Edit frame did not load in time'));
    }, LOAD_TIMEOUT_MS);
    iframe.addEventListener('load', onLoad);
    iframe.src = url;
    // Images can keep the load event pending long after the DOM is usable.
    // Attach page navigation now; the session already observes late image/font loads.
    const targetUrl = new URL(url, iframe.ownerDocument?.baseURI).href;
    readyPoll = setInterval(() => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.location.href === targetUrl && doc.readyState !== 'loading') onLoad();
      } catch {
        // The load handler reports an inaccessible document through the existing path.
      }
    }, 25);
  });
}

export function createFrameController(opts: FrameControllerOptions): FrameController {
  const listeners = new Set<(msg: FrameToShell) => void>();
  let generation = 0;
  let cancelPending: (() => void) | null = null;
  let session: Session | null = null;

  const emit = (msg: FrameToShell): void => {
    for (const l of Array.from(listeners)) {
      try {
        l(msg);
      } catch (err) {
        console.error('frame listener failed', err);
      }
    }
  };

  const teardown = (): void => {
    cancelPending?.();
    cancelPending = null;
    session?.dispose();
    session = null;
  };

  async function mount(
    iframe: HTMLIFrameElement,
    index: DocIndex,
    mountOpts: { currentPageId: NodeId | null },
  ): Promise<void> {
    const mine = ++generation;
    teardown();
    const pages = pageRoots(index).map((el) => el.id);
    const html = buildPreview(index, {
      frameCSS: FRAME_CSS,
      baseHref: opts.baseHref,
      imageOrigins: opts.imageOrigins,
      currentPageId: mountOpts.currentPageId ?? undefined,
    });
    const url = await opts.store.preview(html, (opts.nonce ?? randomNonce)());
    if (mine !== generation) return;
    const loaded = await loadFrame(iframe, url, (cancel) => {
      cancelPending = cancel;
    });
    if (loaded === SUPERSEDED || mine !== generation) return;
    cancelPending = null;
    if (!loaded) {
      throw new Error('Edit frame document is not accessible (it must be same-origin with the editor)');
    }
    session = createSession(loaded, pages, mountOpts.currentPageId, emit);
    session.start();
  }

  return {
    mount,
    send: (msg) => session?.send(msg),
    measure: (ids) => session?.measure(ids) ?? { rects: {}, overflow: [] },
    styles: (id, props) => session?.styles(id, props) ?? {},
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      generation++;
      teardown();
      listeners.clear();
    },
  };
}
