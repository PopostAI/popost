/**
 * The geometry of `popost image edit`: what to cut out of the source, how to turn it, and how large the result is. Pure
 * arithmetic, so the browser (render/edit.ts) only draws what is planned here. The steps always run in one order, whatever
 * the order of the options: crop, rotate, flip, resize.
 */
import { ValueError } from '../core/errors';

export type EditFit = 'cover' | 'contain';
export type EditFlip = 'h' | 'v';
export type EditFormat = 'png' | 'jpeg' | 'webp';

export interface EditRequest {
  /** `x,y,w,h`, each in source pixels or as a percentage of the source (`25%`). */
  readonly crop?: string;
  readonly rotate?: number;
  readonly flip?: string;
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  readonly fit?: string;
  /** Draw coordinate lines over the result, labelled in source pixels (a picture to look at, not an asset). */
  readonly grid?: boolean;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EditPlan {
  /** The part of the source that is used, in source pixels. */
  readonly crop: Box;
  readonly rotate: 0 | 90 | 180 | 270;
  readonly flip: EditFlip | null;
  /** The size of the result. */
  readonly width: number;
  readonly height: number;
  /** Where the cropped, turned picture lands in the result (larger than the result when `cover` cuts the overflow). */
  readonly draw: Box;
  /** Coordinate lines to draw over the result, or `null`. */
  readonly grid: EditGrid | null;
  /** What was done, in order, for the command's output. */
  readonly steps: readonly string[];
}

export interface GridLine {
  /** Where the line is in the result, in pixels. */
  readonly at: number;
  /** The source coordinate it stands for. */
  readonly label: string;
}

export interface EditGrid {
  /** Distance between two lines, in source pixels. */
  readonly step: number;
  readonly xs: readonly GridLine[];
  readonly ys: readonly GridLine[];
}

const GRID_LINES = 8;

/** A round distance (1, 2, 5 x 10^n source pixels) that puts about `GRID_LINES` lines along the longer side of the crop. */
export const gridStep = (crop: Box): number => {
  const raw = Math.max(crop.width, crop.height) / GRID_LINES;
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const nice = [1, 2, 5, 10].find((factor) => factor * power >= raw) ?? 10;
  return Math.max(1, nice * power);
};

const gridLines = (start: number, length: number, outLength: number, step: number): GridLine[] => {
  const lines: GridLine[] = [];
  for (let value = Math.ceil(start / step) * step; value <= start + length; value += step)
    lines.push({ at: ((value - start) * outLength) / length, label: String(value) });
  return lines;
};

export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;

const sizeText = (width: number, height: number): string => `${width}x${height}`;

const cropValue = (token: string, full: number, name: string): number => {
  const match = /^(\d+(?:\.\d+)?)(%?)$/.exec(token.trim());
  if (!match) throw new ValueError(`--crop ${name} is not a number or a percentage: ${token.trim() || '(empty)'}`);
  const value = Number(match[1]);
  return Math.round(match[2] ? (value / 100) * full : value);
};

/** `x,y,w,h` inside a `width` x `height` source; a percentage that rounds one pixel past the edge is pulled back in. */
export const parseCrop = (text: string, width: number, height: number): Box => {
  const tokens = text.split(',');
  if (tokens.length !== 4) throw new ValueError('--crop takes x,y,w,h (pixels of the source, or percentages such as 10%,0%,50%,100%)');
  const x = cropValue(tokens[0]!, width, 'x');
  const y = cropValue(tokens[1]!, height, 'y');
  const percent = text.includes('%');
  const w = Math.min(cropValue(tokens[2]!, width, 'w'), percent ? width - x : Infinity);
  const h = Math.min(cropValue(tokens[3]!, height, 'h'), percent ? height - y : Infinity);
  if (w < 1 || h < 1) throw new ValueError(`--crop ${text} leaves nothing: the box must be at least 1x1 px inside the ${sizeText(width, height)} source`);
  if (x + w > width || y + h > height)
    throw new ValueError(`--crop ${text} reaches outside the source, which is ${sizeText(width, height)} px (the box ends at ${x + w},${y + h})`);
  return { x, y, width: w, height: h };
};

const rotation = (value: number | undefined): 0 | 90 | 180 | 270 => {
  if (value === undefined || value === 0) return 0;
  if (value === 90 || value === 180 || value === 270) return value;
  throw new ValueError('--rotate takes 90, 180 or 270 (degrees clockwise)');
};

const positive = (value: number | undefined, name: string, integer: boolean): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    throw new ValueError(`${name} must be a positive ${integer ? 'whole number of pixels' : 'number'}`);
  return value;
};

interface Target {
  readonly width: number;
  readonly height: number;
  readonly draw: Box;
  readonly step: string | null;
}

/** The result size for a turned crop of `ow` x `oh`. */
const target = (ow: number, oh: number, request: EditRequest): Target => {
  const scale = positive(request.scale, '--scale', false);
  const width = positive(request.width, '--width', true);
  const height = positive(request.height, '--height', true);
  if (scale !== undefined && (width !== undefined || height !== undefined)) throw new ValueError('use --scale or --width / --height, not both');
  if (request.fit !== undefined && (width === undefined || height === undefined)) throw new ValueError('--fit only goes with both --width and --height');
  const whole = (w: number, h: number, step: string | null): Target => ({ width: w, height: h, draw: { x: 0, y: 0, width: w, height: h }, step });
  if (scale !== undefined) {
    const [w, h] = [Math.max(1, Math.round(ow * scale)), Math.max(1, Math.round(oh * scale))];
    return whole(w, h, `scale ${scale} -> ${sizeText(w, h)}`);
  }
  if (width === undefined && height === undefined) return whole(ow, oh, null);
  if (width === undefined || height === undefined) {
    const w = width ?? Math.max(1, Math.round((ow * height!) / oh));
    const h = height ?? Math.max(1, Math.round((oh * width!) / ow));
    return whole(w, h, `resize -> ${sizeText(w, h)}`);
  }
  const fit = request.fit ?? 'cover';
  if (fit !== 'cover' && fit !== 'contain') throw new ValueError('--fit takes cover or contain');
  const k = fit === 'cover' ? Math.max(width / ow, height / oh) : Math.min(width / ow, height / oh);
  const [dw, dh] = [ow * k, oh * k];
  return { width, height, draw: { x: (width - dw) / 2, y: (height - dh) / 2, width: dw, height: dh }, step: `resize ${fit} -> ${sizeText(width, height)}` };
};

/** The plan for a source of `sourceWidth` x `sourceHeight`; a `ValueError` says which option does not fit and why. */
export const planEdit = (sourceWidth: number, sourceHeight: number, request: EditRequest): EditPlan => {
  const crop = request.crop === undefined ? { x: 0, y: 0, width: sourceWidth, height: sourceHeight } : parseCrop(request.crop, sourceWidth, sourceHeight);
  const rotate = rotation(request.rotate);
  if (request.flip !== undefined && request.flip !== 'h' && request.flip !== 'v') throw new ValueError('--flip takes h (mirror left-right) or v (top-bottom)');
  const flip = request.flip ?? null;
  const turned = rotate === 90 || rotate === 270;
  const out = target(turned ? crop.height : crop.width, turned ? crop.width : crop.height, request);
  if (out.width > MAX_SIDE || out.height > MAX_SIDE || out.width * out.height > MAX_PIXELS)
    throw new ValueError(`the result would be ${sizeText(out.width, out.height)} px; the limit is ${MAX_SIDE} px a side and ${MAX_PIXELS / 1_000_000} megapixels`);
  const stretched = out.draw.width !== out.width || out.draw.height !== out.height;
  if (request.grid && (rotate || flip || stretched)) throw new ValueError('--grid goes with --crop and --scale (or one of --width / --height) only: its lines are source coordinates');
  const step = gridStep(crop);
  const grid = request.grid ? { step, xs: gridLines(crop.x, crop.width, out.width, step), ys: gridLines(crop.y, crop.height, out.height, step) } : null;
  const steps = [
    request.crop === undefined ? null : `crop ${crop.x},${crop.y},${crop.width},${crop.height}`,
    rotate ? `rotate ${rotate}` : null,
    flip ? `flip ${flip}` : null,
    out.step,
    grid ? `grid every ${grid.step} source px` : null,
  ].filter((step): step is string => step !== null);
  return { crop, rotate, flip, width: out.width, height: out.height, draw: out.draw, grid, steps };
};

/** The format a file name asks for, by its extension. */
export const formatOf = (path: string): EditFormat => {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === 'png' || ext === 'webp') return ext;
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  throw new ValueError('--out must end in .png, .jpg, .jpeg or .webp: the extension picks the format');
};

/** The ground under the picture: none for PNG / WebP (transparency is kept), white for JPEG, or the colour that was asked for. */
export const backgroundOf = (format: EditFormat, asked: string | undefined): string | null => {
  if (asked === undefined || asked === 'transparent') {
    if (format === 'jpeg') return '#ffffff';
    return null;
  }
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(asked)) throw new ValueError('--background takes a hex colour such as #ffffff, or transparent');
  return asked;
};
