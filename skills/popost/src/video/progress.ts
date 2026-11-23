/**
 * Progress of a command that runs for minutes: its parts say what they are doing (onStage), and one line about all of
 * them goes to stderr every so often, so that a person or an agent watching sees which part is working and how far it
 * is, while stdout keeps the one JSON document. Nothing is written when the command ends before the first interval.
 */

/** What a part is doing now; done and total when it can count (shot 3 of 6). */
export type OnStage = (what: string, done?: number, total?: number) => void;

interface PartState { what: string; done?: number; total?: number; since: number; started: number; ended?: number }

export interface Progress {
  /** The reporter a part calls with what it is doing; the part counts as started now. */
  part(name: string): OnStage;
  /** The part has finished. */
  end(name: string): void;
  /** The part will start later, after the ones before it (a small CPU budget runs them one at a time). */
  wait(name: string): void;
  /** The line the timer writes, as it would be now. */
  line(): string;
  /** Stops the timer; call it when the command ends, also when it fails. */
  stop(): void;
}

const seconds = (ms: number): string => Math.round(ms / 1000) + ' s';

/**
 * label: the command, at the start of every line. everyMs: how often a line is written. now: the clock, for tests
 * (Date.now: it measures how long something took).
 */
export const watchProgress = (write: (line: string) => void, o: { label: string; everyMs: number; now?: () => number }): Progress => {
  const now = o.now ?? Date.now;
  const t0 = now();
  const parts = new Map<string, PartState>();
  const describe = (name: string, p: PartState, t: number): string =>
    p.ended !== undefined ? name + ': done in ' + seconds(p.ended - p.started)
      : name + ': ' + p.what + (p.done !== undefined && p.total !== undefined ? ' ' + p.done + ' of ' + p.total : '') + ' (' + seconds(t - p.since) + ')';
  const line = (): string => {
    const t = now();
    return o.label + ', ' + seconds(t - t0) + ': ' + [...parts.entries()].map(([name, p]) => describe(name, p, t)).join('; ');
  };
  const timer = setInterval(() => write(line()), o.everyMs);
  return {
    part: (name) => {
      const started = now();
      parts.set(name, { what: 'starting', since: started, started });
      return (what, done, total) => {
        const p = parts.get(name);
        if (!p || p.ended !== undefined) return;
        const since = p.what === what ? p.since : now();
        parts.set(name, { what, since, started: p.started, ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}) });
      };
    },
    end: (name) => {
      const p = parts.get(name);
      if (p) parts.set(name, { ...p, ended: now() });
    },
    wait: (name) => {
      const t = now();
      parts.set(name, { what: 'waiting its turn', since: t, started: t });
    },
    line,
    stop: () => clearInterval(timer),
  };
};
