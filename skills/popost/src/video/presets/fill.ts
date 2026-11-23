/**
 * Fills of shapes and colour bases: a flat colour or a gradient, as CSS, and one representative colour. Pure.
 */
import type { Fill, Gradient } from '../types';

const n4 = (v: number): string => String(Math.round(v * 1e4) / 1e4);

export const isGradient = (f: Fill): f is Gradient => typeof f !== 'string';

/** Default direction of a linear gradient, as in CSS: top to bottom. */
export const GRADIENT_ANGLE = 180;

/**
 * A gradient as a CSS image. linear: the angle as in CSS. radial: an ellipse centred in the box that reaches the
 * farthest corner, so stop 0 is the centre and stop 1 the corners.
 */
export const gradientCss = (g: Gradient): string => {
  const stops = g.stops.map((s) => s.color + ' ' + n4(s.at * 100) + '%').join(', ');
  return g.type === 'linear' ? 'linear-gradient(' + n4(g.angle ?? GRADIENT_ANGLE) + 'deg, ' + stops + ')' : 'radial-gradient(farthest-corner at 50% 50%, ' + stops + ')';
};

/** The CSS "background" value of a fill. */
export const fillCss = (f: Fill): string => (typeof f === 'string' ? f : gradientCss(f));

/** One colour for a fill: the colour itself, or the gradient stop nearest the middle (the first of two equally near). */
export const fillColor = (f: Fill): string => {
  if (typeof f === 'string') return f;
  const best = f.stops.reduce((a, s) => (Math.abs(s.at - 0.5) < Math.abs(a.at - 0.5) ? s : a));
  return best.color;
};
