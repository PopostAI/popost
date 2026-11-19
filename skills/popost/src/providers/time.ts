/** Timestamps and sleeping for the providers; time always comes from the runtime. */
import type { Runtime } from '../runtime';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Python `time.strftime("%Y%m%d%H%M%S")` in local time. */
export const stamp = (date: Date): string =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** Python `time.strftime("%Y-%m-%dT%H:%M:%S%z")`: local time with a colon-less offset, e.g. `+0800`. */
export const stampWithOffset = (date: Date): string => {
  const offset = -date.getTimezoneOffset();
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
};

export const sleep = (rt: Runtime, ms: number): Promise<void> =>
  rt.sleep ? rt.sleep(ms) : new Promise((resolve, reject) => {
    if (rt.signal?.aborted) return reject(rt.signal.reason);
    const timer = setTimeout(resolve, Math.max(0, ms));
    rt.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(rt.signal?.reason);
    }, { once: true });
  });

/** A runtime whose clock reads `date`, to reuse `isoNow` for another instant. */
export const atTime = (rt: Runtime, date: Date): Runtime => ({ ...rt, now: () => date });

/** A signal that fires after `ms`, or when the runtime's own (the host ending the turn) fires first. */
export const timeoutSignal = (rt: Runtime, ms: number): AbortSignal => (rt.signal ? AbortSignal.any([rt.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
