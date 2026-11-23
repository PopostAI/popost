import type { CDPSession, Page } from 'playwright-core';

/** Pin the layout viewport on the capture session so Chrome restores it after a clipped shot, including fixed items. */
export const createScreenshotSession = async (page: Page, viewport: { width: number; height: number }, deviceScaleFactor: number): Promise<CDPSession> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor, mobile: false });
  return cdp;
};

interface ScreenshotOptions {
  format: 'png' | 'jpeg';
  clip: { x: number; y: number; width: number; height: number; scale: number };
  quality?: number;
  optimizeForSpeed?: boolean;
}

/**
 * An emulated viewport can extend below Chrome's native window surface. Capturing only that surface returns black
 * pixels there even though layout and image decoding are correct. Render the entire explicit clip in every path.
 */
export const captureScreenshot = (cdp: CDPSession, options: ScreenshotOptions): Promise<{ data: string }> =>
  cdp.send('Page.captureScreenshot', { ...options, captureBeyondViewport: true });
