/**
 * A headless Chromium for rendering pages. The npm package does not download a browser: it uses the one named by
 * `POPOST_CHROME` (or `PLAYWRIGHT_CHROMIUM`), else an installed Chrome / Edge / Chromium, else a Playwright cache.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

export class BrowserUnavailableError extends Error {
  override name = 'BrowserUnavailableError';
}

const playwrightCaches = (): string[] => {
  const roots = [
    path.join(homedir(), '.cache', 'ms-playwright'),
    path.join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(homedir(), 'AppData', 'Local', 'ms-playwright'),
  ];
  const tails = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe'],
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => /^chromium/.test(d)).sort().reverse())
      for (const tail of tails) out.push(path.join(root, dir, ...tail));
  }
  return out;
};

const SYSTEM_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/local/bin/chromium',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** The browser executable to use, or `null` when none is found. */
export const findChromium = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const explicit = env.POPOST_CHROME || env.PLAYWRIGHT_CHROMIUM;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return [...SYSTEM_BROWSERS, ...playwrightCaches()].find((p) => existsSync(p)) ?? null;
};

/**
 * `MAP * ~NOTFOUND`: no host name resolves. Pages are served by request interception (`offline.ts`), which never needs
 * DNS; this also closes what interception cannot see (`<link rel="preconnect">`, `dns-prefetch`).
 */
const LAUNCH_ARGS = ['--disable-gpu', '--font-render-hinting=none', '--host-resolver-rules=MAP * ~NOTFOUND'];

export const launchChromium = async (env: Readonly<Record<string, string | undefined>>): Promise<Browser> => {
  const executablePath = findChromium(env);
  if (!executablePath)
    throw new BrowserUnavailableError(
      'No Chrome, Edge or Chromium found. Install Google Chrome, or set POPOST_CHROME to a Chromium executable.',
    );
  return chromium.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
};
