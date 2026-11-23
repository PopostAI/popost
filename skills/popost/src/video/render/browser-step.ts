/** A browser protocol call has no implicit deadline, unlike navigation. Keep a stopped renderer observable. */
export class BrowserStepTimeoutError extends Error {
  override name = 'BrowserStepTimeoutError';
}

export const browserStep = async <T>(stage: string, run: () => Promise<T>, ms = 30_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserStepTimeoutError('Chrome did not finish ' + stage + ' within ' + ms / 1000 + ' seconds. Check the browser and project assets, then retry.')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
};
