import type { DocStore, FontPalette } from '../contracts';
import { createInlineFontCache, defaultLibraryBase, inlineFontCSS, linkedFontCSS, loadPalette, BROWSER_PALETTE_PATH } from '../fonts';
import type { PaletteRole } from '../fonts';

const PREVIEW_TTL_MS = 600_000;

export interface LibraryOptions {
  /** Font library root (`<site base>/fonts/popost/`); defaults to `../fonts/popost/` relative to the editor page. */
  fontBase?: string | URL;
  fetch?: typeof fetch;
  /** `inline` (default) embeds the font files as data URIs; `link` points at the library by root-relative path. */
  fonts?: 'inline' | 'link';
}

/**
 * Font menu and font CSS served from the static font library next to the editor (browser and host mode).
 * The palette is fetched once; a failed fetch is retried on the next call.
 */
export function createLibraryFonts(options: LibraryOptions = {}): Pick<DocStore, 'fontPalette' | 'fontCSS'> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const fontBase = options.fontBase ? new URL(String(options.fontBase), document.baseURI) : defaultLibraryBase();
  const inlineFont = createInlineFontCache(fontBase, fetchImpl, options.fonts === 'link' ? linkedFontCSS : inlineFontCSS);
  let palette: Promise<FontPalette> | undefined;

  function fontPalette(): Promise<FontPalette> {
    palette ??= loadPalette(new URL(BROWSER_PALETTE_PATH, fontBase), fetchImpl);
    palette.catch(() => {
      palette = undefined;
    });
    return palette;
  }

  async function fontCSS(roleIds: string[], ctx: { rev: string }): Promise<{ css: Record<string, string>; rev: string }> {
    const roles = (await fontPalette()).roles as PaletteRole[];
    const css: Record<string, string> = {};
    for (const roleId of roleIds) {
      const role = roles.find((r) => r.id === roleId);
      if (!role) throw new Error('该字体不在公共字体库中');
      css[roleId] = await inlineFont(role);
    }
    return { css, rev: ctx.rev };
  }

  return { fontPalette, fontCSS };
}

/** Preview through a short-lived blob URL (browser and host mode have no preview endpoint). */
export async function blobPreview(html: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  setTimeout(() => URL.revokeObjectURL(url), PREVIEW_TTL_MS);
  return url;
}
