import type { Runtime } from '../../runtime';
import { openRenderer, type Renderer } from '../render/index';

export const createThumbnails = (rt: Runtime, dir: string) => {
  let renderer: Promise<Renderer> | undefined; let generation = -1;
  let queue: Promise<unknown> = Promise.resolve(); let idle: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, Promise<Buffer>>();
  const close = async (): Promise<void> => { if (idle) clearTimeout(idle); const old = renderer; renderer = undefined; await old?.then((r) => r.close()).catch(() => undefined); };
  const get = (frame: number, current: number): Promise<Buffer> => {
    const key = current + ':' + frame; const known = cache.get(key); if (known) return known;
    const next = queue.then(async () => {
      if (current !== generation) { await close(); generation = current; }
      if (idle) clearTimeout(idle);
      if (!renderer) renderer = openRenderer(rt, dir, { scale: 0.2 });
      try {
        const r = await renderer;
        const png = await r.frame(Math.max(0, Math.min(r.frames - 1, frame)));
        idle = setTimeout(() => { void close(); }, 20_000); idle.unref();
        return png;
      } catch (e) { await close(); cache.delete(key); throw e; }
    });
    cache.set(key, next); if (cache.size > 100) cache.delete(cache.keys().next().value!);
    queue = next.catch(() => undefined);
    return next;
  };
  return { get, close };
};
