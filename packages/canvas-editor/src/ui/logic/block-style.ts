/** Block panel: presets, value readers and the style props each control writes. */

export const RADIUS_PRESETS = [
  { id: 'none', px: 0 },
  { id: 'subtle', px: 8 },
  { id: 'medium', px: 16 },
  { id: 'large', px: 32 },
  { id: 'full', px: 9999 },
] as const;
export const PADDING_PRESETS = [
  { id: 'none', px: 0 },
  { id: 'narrow', px: 12 },
  { id: 'medium', px: 24 },
  { id: 'wide', px: 48 },
] as const;
export const MARGIN_PRESETS = [
  { id: 'none', px: 0 },
  { id: 'small', px: 12 },
  { id: 'medium', px: 24 },
  { id: 'large', px: 48 },
] as const;
export const SHADOW_PRESETS = [
  { id: 'none', css: 'none' },
  { id: 'soft', css: '0 4px 14px rgba(0,0,0,0.12)' },
  { id: 'medium', css: '0 8px 24px rgba(0,0,0,0.22)' },
  { id: 'strong', css: '0 14px 40px rgba(0,0,0,0.38)' },
] as const;
export const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted'] as const;
export const BORDER_WIDTHS = [
  { id: 'thin', px: 1 },
  { id: 'medium', px: 3 },
  { id: 'thick', px: 6 },
] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

type Props = Record<string, string | null>;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

/** First number of a computed length (`"24px"` -> 24, `"8px 4px"` -> 8); 0 when absent. */
export function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cleared longhands plus the shorthand, so a per-side declaration cannot override the new value. The longhands come
 * first: the live frame applies props in order and removing a longhand after setting the shorthand would undo it.
 */
export function boxProps(base: 'padding' | 'margin', value: number): Props {
  return { ...Object.fromEntries(SIDES.map((s) => [`${base}-${s}`, null])), [base]: `${Math.round(value)}px` };
}

export function radiusProps(value: number): Props {
  return { ...Object.fromEntries(CORNERS.map((c) => [`border-${c}-radius`, null])), 'border-radius': `${Math.round(value)}px` };
}

export function borderProps(style: BorderStyle, widthPx: number): Props {
  return style === 'none' ? { 'border-style': 'none' } : { 'border-style': style, 'border-width': `${Math.max(1, Math.round(widthPx))}px` };
}

export function shadowProps(css: string): Props {
  return { 'box-shadow': css };
}

/** Slider value for a radius (`full` presets are huge; the slider is capped). */
export const RADIUS_SLIDER_MAX = 120;

export function shadowPresetId(inline: string | null | undefined): string | null {
  const v = (inline ?? '').replace(/\s+/g, '').toLowerCase();
  if (v === '') return null;
  return SHADOW_PRESETS.find((p) => p.css.replace(/\s+/g, '').toLowerCase() === v)?.id ?? null;
}

export function borderStyleOf(computed: string | undefined): BorderStyle {
  return (BORDER_STYLES as readonly string[]).includes(computed ?? '') ? (computed as BorderStyle) : 'none';
}
