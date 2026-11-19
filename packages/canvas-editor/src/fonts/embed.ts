import type { PaletteRole } from './palette';

const URL_PATTERN = /url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g;
const CONCURRENCY = 8;

export function fontUrls(css: string): string[] {
  return [...new Set([...css.matchAll(URL_PATTERN)].map((m) => m[1] as string))];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

/** Replace every `url(...)` by the embedded data URI of the same source URL. */
export function replaceFontUrls(css: string, embedded: ReadonlyMap<string, string>): string {
  return css.replace(URL_PATTERN, (_all, url: string) => `url("${embedded.get(url)}")`);
}

/** Prepend the licence comment block (package id and version, then the licence text) to the CSS. */
export function withLicenseComment(role: PaletteRole, license: string, css: string): string {
  return `/* ${role.package}@${role.packageVersion}\n${license}\n*/\n${css}`;
}

async function fetchOk(fetchImpl: typeof fetch, url: URL, message: string): Promise<Response> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(message);
  return response;
}

async function embedAll(fetchImpl: typeof fetch, urls: string[], cssUrl: URL, label: string): Promise<Map<string, string>> {
  const embedded = new Map<string, string>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const url = urls[next++] as string;
      const response = await fetchOk(fetchImpl, new URL(url, cssUrl), '字体文件缺失：' + label);
      embedded.set(url, 'data:font/woff2;base64,' + bytesToBase64(new Uint8Array(await response.arrayBuffer())));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return embedded;
}

/** Browser mode: self-contained CSS (licence comment + `@font-face` with base64 woff2 data URIs). */
export async function inlineFontCSS(role: PaletteRole, base: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cssUrl = new URL(role.cssPath ?? `css/${role.id}.css`, base);
  const css = await (await fetchOk(fetchImpl, cssUrl, '字体样式缺失：' + role.label)).text();
  const embedded = await embedAll(fetchImpl, fontUrls(css), cssUrl, role.label);
  return withLicenseComment(role, await fetchLicense(role, base, fetchImpl), replaceFontUrls(css, embedded));
}

/**
 * Host mode: licence comment + `@font-face` pointing at the font files on the host by root-relative path. Nothing is
 * inlined, so a document that uses a multi-megabyte CJK family stays small; it renders wherever the host serves the
 * library at the same path.
 */
export async function linkedFontCSS(role: PaletteRole, base: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cssUrl = new URL(role.cssPath ?? `css/${role.id}.css`, base);
  const css = await (await fetchOk(fetchImpl, cssUrl, '字体样式缺失：' + role.label)).text();
  const linked = new Map(fontUrls(css).map((url) => [url, new URL(url, cssUrl).pathname]));
  return withLicenseComment(role, await fetchLicense(role, base, fetchImpl), replaceFontUrls(css, linked));
}

async function fetchLicense(role: PaletteRole, base: URL, fetchImpl: typeof fetch): Promise<string> {
  const licenseUrl = new URL(role.licensePath ?? `${role.id}/LICENSE`, base);
  return (await fetchOk(fetchImpl, licenseUrl, '字体授权文件缺失：' + role.label)).text();
}

/** Caches font CSS per role (inlined by default, or linked); a failed role is dropped from the cache so it can be retried. */
export function createInlineFontCache(
  base: URL,
  fetchImpl: typeof fetch = fetch,
  build: (role: PaletteRole, base: URL, fetchImpl: typeof fetch) => Promise<string> = inlineFontCSS,
): (role: PaletteRole) => Promise<string> {
  const prepared = new Map<string, Promise<string>>();
  return (role) => {
    let entry = prepared.get(role.id);
    if (!entry) {
      entry = build(role, base, fetchImpl).catch((error: unknown) => {
        prepared.delete(role.id);
        throw error;
      });
      prepared.set(role.id, entry);
    }
    return entry;
  };
}
