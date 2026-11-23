/**
 * Watches the files the preview shows (video.json, the materials, the measurements, the notes) for changes. The
 * runtime has no file watcher, so their size and modification time are read every POLL_MS: a few stats per round,
 * because only the files the preview reads are looked at, not the whole directory. Every file that changed between
 * two rounds is reported in one call, so an editor's save (a temporary file renamed over the old one) is one reload.
 */
import type { Runtime } from '../../runtime';

/**
 * Half a second: a save shows in the page about as fast as one can switch to it, and a round costs a stat per file
 * (a project names a few dozen at most).
 */
export const POLL_MS = 500;

export interface WatchOptions {
  /** The absolute paths to watch, asked again every round (the list follows video.json). */
  paths: () => Iterable<string>;
  /** The absolute paths that changed since the last call. */
  onChange: (changed: ReadonlySet<string>) => void;
  intervalMs?: number;
}

export interface Watcher { close(): void }

/** Size and modification time, or "none" for a file that does not exist (its appearing is a change too). */
const signature = async (rt: Runtime, file: string): Promise<string> => {
  const info = await rt.fs.stat(file).catch(() => null);
  return info ? info.size + ':' + info.mtimeMs : 'none';
};

export const watchSources = (rt: Runtime, o: WatchOptions): Watcher => {
  const seen = new Map<string, string>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One round: a path seen for the first time is only recorded, a known one that differs is reported. */
  const round = async (): Promise<Set<string>> => {
    const changed = new Set<string>();
    await Promise.all([...new Set(o.paths())].map(async (file) => {
      const now = await signature(rt, file);
      const before = seen.get(file);
      seen.set(file, now);
      if (before !== undefined && before !== now) changed.add(file);
    }));
    return changed;
  };
  const next = (): void => {
    if (closed) return;
    timer = setTimeout(() => {
      void round().then((changed) => {
        if (!closed && changed.size) o.onChange(changed);
      }, () => undefined).finally(next);
    }, o.intervalMs ?? POLL_MS);
  };
  void round().finally(next);
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
};
