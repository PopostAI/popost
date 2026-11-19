/** Crop & align math: `object-position` while dragging an image inside its box. */

export interface Size {
  width: number;
  height: number;
}
export interface Pos {
  x: number;
  y: number;
}
export type CropFit = 'cover' | 'contain';

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const KEYWORD: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

function axis(token: string | undefined): number {
  if (token === undefined) return 0.5;
  if (token in KEYWORD) return KEYWORD[token] as number;
  if (token.endsWith('%')) {
    const n = Number.parseFloat(token);
    if (Number.isFinite(n)) return clamp01(n / 100);
  }
  return 0.5; // lengths cannot be expressed as a fraction without the sizes; start from the centre
}

/** `object-position` value as fractions 0..1 (`"50% 20%"`, `left top`, a single keyword, or empty). */
export function parseObjectPosition(value: string | null | undefined): Pos {
  const tokens = (value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && (tokens[0] === 'top' || tokens[0] === 'bottom')) return { x: 0.5, y: axis(tokens[0]) };
  return { x: axis(tokens[0]), y: axis(tokens[1]) };
}

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

export function formatObjectPosition(pos: Pos): string {
  return `${pct(pos.x)} ${pct(pos.y)}`;
}

/** Size of the image as drawn by `object-fit` inside `box`. */
export function drawnSize(natural: Size, box: Size, fit: CropFit): Size {
  const sx = box.width / natural.width;
  const sy = box.height / natural.height;
  const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  return { width: natural.width * s, height: natural.height * s };
}

/**
 * New `object-position` after dragging by (`dx`, `dy`) document px from `start`. The image offset along an axis is
 * `(box - drawn) * p`, so a drag moves p by `-d / (drawn - box)`; an axis with no slack stays where it is.
 */
export function dragPosition(args: { natural: Size; box: Size; fit: CropFit; start: Pos; dx: number; dy: number }): Pos {
  const { natural, box, fit, start, dx, dy } = args;
  if (!(natural.width > 0 && natural.height > 0 && box.width > 0 && box.height > 0)) return start;
  const drawn = drawnSize(natural, box, fit);
  const along = (p: number, d: number, boxLen: number, drawnLen: number): number => {
    const slack = boxLen - drawnLen;
    return Math.abs(slack) < 0.5 ? p : clamp01(p + d / slack);
  };
  return { x: along(start.x, dx, box.width, drawn.width), y: along(start.y, dy, box.height, drawn.height) };
}

/** `object-fit` value as one of the two crop modes (anything else counts as not set). */
export function cropFitOf(value: string | null | undefined): CropFit | null {
  return value === 'cover' || value === 'contain' ? value : null;
}
