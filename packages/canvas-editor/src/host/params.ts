import type { HostParams, LocalBoot } from '../contracts';
import { sanitizeImageOrigins } from '../core/image-origins';

declare global {
  interface Window {
    __POPOST_PARAMS__?: unknown;
    __POPOST_LOCAL__?: unknown;
  }
}

/** The raw query string: `window.__POPOST_PARAMS__` (srcdoc / local injection) wins over `location.search`. */
export function rawQuery(): string {
  const injected = window.__POPOST_PARAMS__;
  if (typeof injected === 'string' && injected !== '') return injected;
  return window.location.search;
}

export function parseParams(query: string): HostParams {
  const q = new URLSearchParams(query);
  const theme = q.get('theme');
  return {
    popost: q.has('popost'),
    file: q.get('file') || null,
    ratio: q.get('ratio') || null,
    lang: q.get('lang') === 'en' ? 'en' : 'zh',
    name: q.get('name') || null,
    embedded: q.get('embedded') !== '0',
    theme: theme === 'dark' || theme === 'light' ? theme : null,
    store: q.get('store') === 'host' ? 'host' : 'browser',
  };
}

/** `imageOrigins` (comma separated, at most 4 valid `https:` origins); honoured in host mode (`store=host`) only. */
export function parseImageOrigins(query: string, store: HostParams['store']): string[] {
  if (store !== 'host') return [];
  return sanitizeImageOrigins((new URLSearchParams(query).get('imageOrigins') ?? '').split(','));
}

/** The image origins of the current page URL (empty outside host mode and in local mode). */
export function readImageOrigins(): string[] {
  const query = rawQuery();
  return window.__POPOST_LOCAL__ ? [] : parseImageOrigins(query, parseParams(query).store);
}

export function readParams(): HostParams {
  return parseParams(rawQuery());
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** `window.__POPOST_LOCAL__` injected by the skill server, or null in browser mode. */
export function readLocalBoot(): LocalBoot | null {
  const boot = window.__POPOST_LOCAL__;
  if (!boot || typeof boot !== 'object') return null;
  const { projectId, width, height, name, cloud, comparison } = boot as Record<string, unknown>;
  if (typeof projectId !== 'string' || !projectId) return null;
  if (!isPositiveNumber(width) || !isPositiveNumber(height)) return null;
  const mode = typeof cloud === 'object' && cloud ? (cloud as Record<string, unknown>).mode : undefined;
  return {
    projectId,
    width,
    height,
    ...(comparison === true ? { comparison: true } : {}),
    name: typeof name === 'string' && name ? name : 'Popost',
    ...(mode === 'keyed' || mode === 'anonymous' ? { cloud: { mode } } : {}),
  };
}

export interface CanvasSize {
  width: number;
  height: number;
}

const DEFAULT_SIZE: CanvasSize = { width: 1280, height: 720 };

/** Canvas size from the `ratio` parameter: width 1080 whenever a ratio is present. */
export function ratioToSize(ratio: string | null): CanvasSize {
  if (!ratio) return { ...DEFAULT_SIZE };
  const heights: Record<string, number> = { '1:1': 1080, '3:4': 1440, '9:16': 1920 };
  return { width: 1080, height: heights[ratio] ?? 1350 };
}

/** Size of the first page: local boot wins, then the ratio, then the 1280x720 default. */
export function initialCanvasSize(params: HostParams, boot: LocalBoot | null): CanvasSize {
  if (boot) return { width: boot.width, height: boot.height };
  return ratioToSize(params.ratio);
}
