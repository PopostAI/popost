/**
 * Rendering from the page (edit mode): one render at a time into <project-dir>/out.mp4 with renderVideo, its
 * progress sent over the event stream as "render" events. The renderer is loaded only when a render starts, so the
 * preview does not load Chrome's driver before it is needed.
 */
import type { Runtime } from '../../../runtime';
import type { RenderInfo } from '../protocol';

export const RENDER_FILE = 'out.mp4';
export type { RenderInfo };

export interface RenderJob {
  /** Starts a render; false when one is running. */
  start(): boolean;
  info(): RenderInfo;
  /** Resolves when the running render (if any) has ended; for tests and for closing the server. */
  idle(): Promise<void>;
}

/** Progress is sent at most this often, so a long render does not flood the event stream. */
const PROGRESS_MS = 250;

/** dir: the project directory, absolute. */
export const createRenderJob = (rt: Runtime, dir: string, send: (info: RenderInfo) => void): RenderJob => {
  let info: RenderInfo = { state: 'idle' };
  let running: Promise<void> | undefined;
  let lastSent = 0;
  const set = (next: RenderInfo, force = true): void => {
    info = next;
    const now = performance.now();
    if (!force && now - lastSent < PROGRESS_MS) return;
    lastSent = now;
    send(next);
  };
  const run = async (): Promise<void> => {
    const started = rt.now().getTime();
    set({ state: 'running', frame: 0, total: 0, started });
    try {
      const { renderVideo } = await import('../../render/index');
      const r = await renderVideo(rt, { projectDir: dir, out: rt.path.join(dir, RENDER_FILE), onProgress: (frame, total) => set({ state: 'running', frame, total, started }, frame === total) });
      const finished = rt.now().getTime();
      set({ state: 'done', frames: r.frames, seconds: Number((r.ms / 1000).toFixed(2)), file: rt.path.join(dir, RENDER_FILE), url: '/project/' + RENDER_FILE + '?t=' + finished, finished });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' ');
      set({ state: 'failed', message, finished: rt.now().getTime() });
    }
  };
  return {
    start: () => {
      if (running) return false;
      running = run().finally(() => { running = undefined; });
      return true;
    },
    info: () => info,
    idle: () => running ?? Promise.resolve(),
  };
};
