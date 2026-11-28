/**
 * The style of the captions a retarget draws: what the reference's caption lines looked like (text/look.ts) when that
 * was measured: white or coloured letters on a plate, with an outline, with a shadow, or plain. Without a measurement,
 * or with plain letters whose colour could not be told (the picture behind them kept changing), white letters with a
 * dark outline and a soft shadow, which stay legible on any picture: bare white letters vanish on a white page. The
 * plan's captionColor and captionOutline win over both.
 */
import type { CaptionLook } from '../text/types';
import type { TextStyle } from '../types';

const hexRgb = (hex: string): [number, number, number] | undefined => {
  const h = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  return h ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : undefined;
};

/** A plate as a TextStyle background: its colour with its opacity. */
const plateStyle = (p: NonNullable<CaptionLook['plate']>): NonNullable<TextStyle['background']> => {
  const rgb = hexRgb(p.color);
  const color = rgb && p.opacity < 1 ? 'rgba(' + rgb.join(', ') + ', ' + p.opacity + ')' : p.color;
  return { color, padding: p.padding, radius: p.radius };
};

const outlined = (color: string): Pick<TextStyle, 'stroke' | 'shadow'> => ({ stroke: { color, width: 0.16 }, shadow: { color, blur: 0.3, x: 0, y: 0.05 } });

export const captionStyle = (look: CaptionLook | undefined, plan: { captionColor?: string; captionOutline?: string }, size: number): TextStyle => {
  // Regular strokes when the reference's were measured as regular; heavy otherwise, which stays legible on any picture.
  const base: TextStyle = { size, weight: look?.weight === 'regular' ? 500 : 800, color: plan.captionColor ?? look?.color ?? '#ffffff', align: 'center' };
  const plate = look?.kind === 'plate' && look.plate ? { background: plateStyle(look.plate) } : {};
  // An outline the plan asks for is drawn whatever the reference had (on its plate, when it had one).
  if (plan.captionOutline) return { ...base, ...outlined(plan.captionOutline), ...plate };
  if (!look || (look.kind === 'plain' && !look.color)) return { ...base, ...outlined('#111111') };
  if (look.kind === 'plate') return { ...base, ...plate };
  if (look.kind === 'outline') return { ...base, ...outlined(look.outline?.color ?? '#111111') };
  if (look.kind === 'shadow') return { ...base, shadow: { color: look.shadow?.color ?? '#000000', blur: 0.12, x: 0.04, y: 0.06 } };
  return base;
};
