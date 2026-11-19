/** Toolbar state derived from computed styles and the frame's text state. */

export const STATE_PROPS: readonly string[] = [
  'font-weight',
  'font-style',
  'text-decoration-line',
  'text-transform',
  'text-align',
  'font-size',
  'font-family',
  'color',
  'line-height',
  'letter-spacing',
  'opacity',
];

export interface FormatActive {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  uppercase: boolean;
}

export type Align = 'left' | 'center' | 'right' | 'justify';

const isBold = (w: string | undefined): boolean => {
  if (!w) return false;
  if (w === 'bold' || w === 'bolder') return true;
  const n = Number.parseInt(w, 10);
  return Number.isFinite(n) && n >= 600;
};

/** Active toggles of a block from its computed styles; `live` (frame text state while editing) wins for the four marks. */
export function activeFromStyles(
  styles: Readonly<Record<string, string>>,
  live?: Partial<Record<'bold' | 'italic' | 'underline' | 'strike', boolean>> | null,
): FormatActive {
  const lines = (styles['text-decoration-line'] ?? '').split(/\s+/);
  return {
    bold: live ? !!live.bold : isBold(styles['font-weight']),
    italic: live ? !!live.italic : /^(italic|oblique)/.test(styles['font-style'] ?? ''),
    underline: live ? !!live.underline : lines.includes('underline'),
    strike: live ? !!live.strike : lines.includes('line-through'),
    uppercase: styles['text-transform'] === 'uppercase',
  };
}

export function alignOf(value: string | undefined): Align {
  switch (value) {
    case 'center':
    case 'right':
    case 'justify':
      return value;
    case 'end':
      return 'right';
    default:
      return 'left';
  }
}

const num = (v: string | undefined): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Computed font size in px (may be fractional); 0 when unknown. */
export const fontSizeOf = (styles: Readonly<Record<string, string>>): number => (Number.isFinite(num(styles['font-size'])) ? num(styles['font-size']) : 0);

/** Unitless line-height ratio from a computed value (`"43.2px"` with 36px font -> 1.2; `normal` -> 1.2). */
export function lineHeightRatio(styles: Readonly<Record<string, string>>): number {
  const lh = styles['line-height'];
  const size = fontSizeOf(styles);
  if (!lh || lh === 'normal' || size <= 0) return 1.2;
  const v = num(lh);
  if (!Number.isFinite(v)) return 1.2;
  return lh.endsWith('px') ? Math.round((v / size) * 100) / 100 : v;
}

/** Letter spacing in em (computed px / font size; `normal` -> 0). */
export function letterSpacingEm(styles: Readonly<Record<string, string>>): number {
  const ls = styles['letter-spacing'];
  const size = fontSizeOf(styles);
  if (!ls || ls === 'normal' || size <= 0) return 0;
  const v = num(ls);
  return Number.isFinite(v) ? Math.round((v / size) * 1000) / 1000 : 0;
}

export function opacityOf(styles: Readonly<Record<string, string>>): number {
  const v = num(styles.opacity);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** First family of a computed `font-family` list, unquoted. */
export function firstFamily(value: string | undefined): string {
  const first = (value ?? '').split(',')[0]?.trim() ?? '';
  return first.replace(/^["']|["']$/g, '');
}
