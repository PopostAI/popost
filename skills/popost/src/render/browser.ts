/**
 * A headless Chromium for rendering pages. The npm package does not download a browser: it uses the one named by
 * `POPOST_CHROME` (or `PLAYWRIGHT_CHROMIUM`), else an installed Chrome / Edge / Chromium, else a Playwright cache.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserServer } from 'playwright-core';
import { msg } from '../i18n';
import type { BrowserProfile } from '../runtime';

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
const OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND';
const LAUNCH_ARGS = ['--disable-gpu', '--font-render-hinting=none', OFFLINE];

/**
 * Video frames: the same pixels on every run. Software raster, sRGB, images decoded before they are drawn (never a
 * placeholder first), and every compositor stage finished before a screenshot.
 */
const FRAME_ARGS = [
  '--disable-gpu',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-checker-imaging',
  '--disable-partial-raster',
  '--run-all-compositor-stages-before-draw',
  '--disable-gpu-vsync',
];

const ARGS: Readonly<Record<BrowserProfile, readonly string[]>> = {
  pages: LAUNCH_ARGS,
  frames: [...FRAME_ARGS, OFFLINE],
  // Unlimited frame scheduling can starve screenshot commits when CSS or a scene library keeps a ticker alive.
  // Both profiles keep Chrome's normal cadence; video time is still set explicitly by the engine.
  web: FRAME_ARGS,
};

/** Chrome's own limit on raster threads. */
const MAX_RASTER_THREADS = 4;

/**
 * The arguments of a launch. rasterThreads: for video frames, Chrome's raster threads from the CPU budget (1 to 4).
 * Chrome sizes its pools by the machine's processor count; under a CPU quota of one processor on 8, the render of the
 * showcase cost 33 s of Chrome's CPU and took 75 to 78 s with Chrome's own count, and 28.6 s and 61 s with one raster
 * thread. Pinned to one processor it makes no difference (51 s either way).
 */
export const chromiumArgs = (profile: BrowserProfile, o: { rasterThreads?: number } = {}): string[] => [
  ...ARGS[profile],
  ...(profile === 'frames' && o.rasterThreads !== undefined ? ['--num-raster-threads=' + Math.max(1, Math.min(MAX_RASTER_THREADS, Math.floor(o.rasterThreads)))] : []),
];

/** Video jobs own an ephemeral browser process; a stalled graceful shutdown must not leave it behind. */
export const closeOwnedBrowser = async (server: Pick<BrowserServer, 'close' | 'kill'>, graceMs = 1_000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      server.close().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
    if (!closed) await server.kill();
  } finally { clearTimeout(timer); }
};

export const launchChromium = async (
  env: Readonly<Record<string, string | undefined>>,
  profile: BrowserProfile = 'pages',
  o: { rasterThreads?: number } = {},
): Promise<Browser> => {
  const executablePath = findChromium(env);
  if (!executablePath)
    throw new BrowserUnavailableError(
      msg(
        'No Chrome, Edge or Chromium found. Install Google Chrome, or set POPOST_CHROME to a Chromium executable.',
        '没有找到 Chrome、Edge 或 Chromium。请安装 Google Chrome，或把 POPOST_CHROME 设为某个 Chromium 可执行文件。',
      ),
    );
  const options = { executablePath, headless: true, args: chromiumArgs(profile, o) };
  if (profile !== 'frames') return chromium.launch(options);
  const server = await chromium.launchServer({ ...options, host: '127.0.0.1' });
  try {
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 });
    let closing: Promise<void> | undefined;
    browser.close = () => closing ??= closeOwnedBrowser(server);
    return browser;
  } catch (e) {
    await server.kill().catch(() => undefined);
    throw e;
  }
};
