import type { Runtime } from '../../../runtime';
import { sha256 } from '../../../core/util';
import type { RenderInfo } from '../protocol';
import { exportScale, type VideoExportSettings } from '../export-settings';

export const RENDER_FILE = 'out.mp4';
export type { RenderInfo };
export interface RenderJob {
  start(settings?: VideoExportSettings, snapshot?: string): boolean;
  info(): RenderInfo;
  idle(): Promise<void>;
}
const PROGRESS_MS = 250;
export const createRenderJob = (rt: Runtime, dir: string, send: (info: RenderInfo) => void): RenderJob => {
  let info: RenderInfo = { state: 'idle' }; let running: Promise<void> | undefined; let lastSent = 0;
  const set = (next: RenderInfo, force = true): void => {
    info = next;
    const now = performance.now();
    if (!force && now - lastSent < PROGRESS_MS) return;
    lastSent = now; send(next);
  };
  const run = async (settings?: VideoExportSettings, snapshot?: string): Promise<void> => {
    const started = rt.now().getTime();
    set({ state: 'running', frame: 0, total: 0, started });
    try {
      const source = snapshot === undefined ? undefined : JSON.parse(snapshot) as { canvas: { width: number; height: number } };
      const file = settings ? '.studio/exports/' + started + '-' + settings.name + '.mp4' : RENDER_FILE;
      const { renderVideo } = await import('../../render/index');
      const r = await renderVideo(rt, {
        projectDir: dir, out: rt.path.join(dir, file), source,
        ...(settings && source ? { scale: exportScale(settings, source.canvas), outputFps: settings.fps ?? undefined, bitrate: settings.bitrate ?? undefined, audioEnabled: settings.audio, from: settings.from, to: settings.to } : {}),
        onProgress: (frame, total) => set({ state: 'running', frame, total, started }, frame === total),
      });
      const finished = rt.now().getTime();
      set({ state: 'done', frames: r.frames, seconds: Number((r.ms / 1000).toFixed(2)), file: rt.path.join(dir, file), url: '/project/' + file.split('/').map(encodeURIComponent).join('/') + '?t=' + finished, finished,
        ...(source ? { sourceHash: sha256(JSON.stringify(source)), width: r.width, height: r.height, fps: r.fps } : {}) });
      if (settings) await rt.fs.writeFile(rt.path.join(dir, '.studio', 'last-export.json'), JSON.stringify(info));
    } catch (e) {
      set({ state: 'failed', message: (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' '), finished: rt.now().getTime() });
    }
  };
  return {
    start: (settings, snapshot) => {
      if (running) return false;
      running = run(settings, snapshot).finally(() => { running = undefined; });
      return true;
    },
    info: () => info,
    idle: () => running ?? Promise.resolve(),
  };
};
