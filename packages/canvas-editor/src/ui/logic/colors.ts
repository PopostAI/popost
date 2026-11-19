/** Colour helpers for the swatches: presets, colours found in the document, computed-colour conversion. */

/** 28 preset swatches (4 rows of 7): neutrals, warm, cool, soft tints. */
export const PRESET_COLORS: readonly string[] = [
  '#000000', '#333333', '#666666', '#999999', '#cccccc', '#eeeeee', '#ffffff',
  '#d64545', '#ff7a1a', '#f5b700', '#ffd966', '#8bc34a', '#2e9e6b', '#00a99d',
  '#1e88e5', '#3949ab', '#7e57c2', '#e8369a', '#8d6e63', '#37474f', '#b71c1c',
  '#ffcdd2', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b3e5fc', '#d1c4e9', '#f8bbd0',
];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)$/i;

/** CSSOM serializes fully transparent colors with an explicit zero alpha. */
export function isTransparentColor(value: string | undefined): boolean {
  if (!value || value === 'transparent') return true;
  const alpha = RGB.exec(value)?.[4] ?? /\/\s*([\d.]+%?)\s*\)$/.exec(value)?.[1];
  return alpha !== undefined && Number.parseFloat(alpha) === 0;
}

const two = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** `#rrggbb` for an opaque CSS colour (hex, rgb(), rgba() with alpha 1), else null (named, transparent, translucent). */
export function toHex(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  const hex = HEX.exec(v);
  if (hex) {
    const h = (hex[1] as string).toLowerCase();
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 8) return h.slice(6) === 'ff' ? `#${h.slice(0, 6)}` : null;
    return `#${h}`;
  }
  const rgb = RGB.exec(v);
  if (rgb) {
    const a = rgb[4];
    if (a !== undefined) {
      const alpha = a.endsWith('%') ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
      if (!(alpha >= 1)) return null;
    }
    return `#${two(Number(rgb[1]))}${two(Number(rgb[2]))}${two(Number(rgb[3]))}`;
  }
  return null;
}

const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_BLOCK = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const COLOR_TOKEN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z_-])|rgba?\([^)]*\)/gi;
const DATA_URI = /data:[^"')\s]{64,}/gi;

/**
 * Opaque colours used by the document's inline styles and `<style>` blocks (embedded font styles and data URIs are
 * skipped), most used first, as `#rrggbb`.
 */
export function extractDocColors(source: string, limit = 14): string[] {
  const counts = new Map<string, number>();
  const scan = (text: string): void => {
    for (const m of text.replace(DATA_URI, '').matchAll(COLOR_TOKEN)) {
      const hex = toHex(m[0]);
      if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  };
  for (const m of source.matchAll(STYLE_ATTR)) scan((m[1] ?? m[2]) as string);
  for (const m of source.matchAll(STYLE_BLOCK)) {
    if (!/data-popost-font/i.test(m[1] as string)) scan(m[2] as string);
  }
  return [...counts.entries()]
    .map(([hex, n], at) => ({ hex, n, at }))
    .sort((a, b) => b.n - a.n || a.at - b.at)
    .slice(0, limit)
    .map((e) => e.hex);
}
