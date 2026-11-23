/**
 * Named text styles. A text item's "style" is one of these names or a TextStyle object (merged over BASE_TEXT_STYLE).
 */
import type { ResolvedTextStyle, Shadow, TextSpanStyle, TextStyle } from '../types';

export const DEFAULT_FONT = '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

export type FullTextStyle = ResolvedTextStyle;

/** What a TextStyle object is merged over, and the style of a text item without one. */
export const BASE_TEXT_STYLE: FullTextStyle = { font: DEFAULT_FONT, size: 0.045, weight: 700, color: '#ffffff', align: 'center', italic: false };

/** Line height of text as a multiple of the font size, when the style does not say. */
export const DEFAULT_LINE_HEIGHT = 1.25;

/** A text shadow's blur and offset when the style gives only some of them, as fractions of the font size. */
export const TEXT_SHADOW_DEFAULTS = { blur: 0.12, x: 0.04, y: 0.06 } as const;

export const TEXT_STYLE_NAMES = ['headline', 'subtitle', 'label', 'caption'] as const;
export type TextStyleName = (typeof TEXT_STYLE_NAMES)[number];

/**
 * Sizes are fractions of the canvas height (0.065 = 125 px on a 1920 px tall canvas); stroke width, padding and radius
 * are fractions of the font size. The stroke is painted under the fill, so half of its width shows outside the glyphs.
 */
export const TEXT_STYLES: Readonly<Record<TextStyleName, FullTextStyle>> = {
  headline: { ...BASE_TEXT_STYLE, size: 0.065, weight: 800, stroke: { color: '#000000', width: 0.12 } },
  subtitle: { ...BASE_TEXT_STYLE, size: 0.04, weight: 700, stroke: { color: '#000000', width: 0.1 } },
  label: { ...BASE_TEXT_STYLE, size: 0.032, weight: 700, color: '#111111', background: { color: '#ffffff', padding: 0.35, radius: 0.3 } },
  caption: { ...BASE_TEXT_STYLE, size: 0.036, weight: 600, background: { color: 'rgba(0, 0, 0, 0.6)', padding: 0.3, radius: 0.2 } },
};

export const isTextStyleName = (s: string): s is TextStyleName => (TEXT_STYLE_NAMES as readonly string[]).includes(s);

/** A shadow with its blur and offsets filled in from defaults. */
export const fullShadow = (s: Shadow, d: { blur: number; x: number; y: number }): Required<Shadow> =>
  ({ color: s.color, blur: s.blur ?? d.blur, x: s.x ?? d.x, y: s.y ?? d.y });

/** The full style of a text item: a named style, or an object merged over the base style. */
export const textStyle = (style: string | TextStyle | undefined): FullTextStyle => {
  if (style === undefined) return BASE_TEXT_STYLE;
  if (typeof style === 'string') {
    if (!isTextStyleName(style)) throw new Error('Unknown text style "' + style + '". Use one of: ' + TEXT_STYLE_NAMES.join(', ') + '.');
    return TEXT_STYLES[style];
  }
  const { shadow, ...rest } = style;
  return { ...BASE_TEXT_STYLE, ...rest, ...(shadow ? { shadow: fullShadow(shadow, TEXT_SHADOW_DEFAULTS) } : {}) };
};

/** A run of text with the span that styles it (none: the item's own style). */
export interface TextPart { text: string; span?: TextSpanStyle }

/**
 * The text cut at the spans' edges, in order, counting by code point (Array.from), so a CJK character or an emoji is
 * one. Spans are assumed not to overlap (check refuses that); one that runs past the end is cut there.
 */
export const textParts = (text: string, spans: readonly TextSpanStyle[] | undefined): TextPart[] => {
  const chars = Array.from(text);
  const sorted = [...(spans ?? [])].sort((a, b) => a.from - b.from);
  const parts: TextPart[] = [];
  let at = 0;
  for (const span of sorted) {
    const from = Math.min(chars.length, Math.max(at, span.from));
    const to = Math.min(chars.length, span.to);
    if (from > at) parts.push({ text: chars.slice(at, from).join('') });
    if (to > from) {
      parts.push({ text: chars.slice(from, to).join(''), span });
      at = to;
    } else at = from;
  }
  if (at < chars.length) parts.push({ text: chars.slice(at).join('') });
  return parts;
};

/** A CSS font-family list with every family that names a font material quoted, so an id like "1brand" still matches. */
export const quoteFamilies = (font: string, families: ReadonlySet<string>): string =>
  font.split(',').map((f) => {
    const name = f.trim();
    return families.has(name) ? '"' + name.replace(/["\\]/g, '\\$&') + '"' : name;
  }).join(', ');
