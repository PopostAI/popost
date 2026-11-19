/**
 * What `popost image info` tells about a picture file: format, pixel size and whether the file carries transparency, read
 * from the headers only (no decoding). Size and format of a PNG, JPEG, WebP or GIF come from `sniffImage`; this adds the
 * transparency flag of each of them and reads SVG.
 *
 * `hasAlpha` means the file has an alpha channel or a transparent colour, not that any pixel is actually transparent: an
 * RGBA PNG whose background is opaque white says `true` too, so the look of the picture is still checked on a render.
 */
import { ascii, ImageError, sniffImage, u32be, type ImageFormat } from './image';

export type PictureFormat = ImageFormat | 'svg';

export interface PictureInfo {
  readonly format: PictureFormat;
  /** Absent for an SVG that declares neither a usable size nor a viewBox. */
  readonly width?: number;
  readonly height?: number;
  /** Not reported for SVG: a vector drawing has no pixels to be transparent. */
  readonly hasAlpha?: boolean;
}

const PNG_COLOUR_TYPE = 25;
const PNG_FIRST_CHUNK = 8;

/** Colour types 4 and 6 have an alpha channel; 0, 2 and 3 are transparent only through a `tRNS` chunk before the image data. */
const pngAlpha = (b: Uint8Array): boolean => {
  const colourType = b[PNG_COLOUR_TYPE];
  if (colourType === 4 || colourType === 6) return true;
  for (let o = PNG_FIRST_CHUNK; o + 8 <= b.length; ) {
    const kind = ascii(b, o + 4, 4);
    if (kind === 'tRNS') return true;
    if (kind === 'IDAT' || kind === 'IEND') return false;
    o += 12 + u32be(b, o);
  }
  return false;
};

/** VP8X keeps the flag in its feature byte, VP8L in its header; plain VP8 (lossy) has no alpha. */
const webpAlpha = (b: Uint8Array): boolean => {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return (b[20]! & 0x10) !== 0;
  if (chunk === 'VP8L') return (((b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 28) & 1) === 1;
  return false;
};

/** Skips the sub-blocks that follow a block header, up to and including their zero-length terminator; returns the next offset. */
const skipSubBlocks = (b: Uint8Array, start: number): number => {
  let o = start;
  while (o < b.length && b[o] !== 0) o += 1 + b[o]!;
  return o + 1;
};

const GIF_HEADER = 13;

/** The offset of the first block after the header and the global colour table. */
const gifBlocksStart = (b: Uint8Array): number => (b[10]! & 0x80 ? GIF_HEADER + 3 * 2 ** ((b[10]! & 7) + 1) : GIF_HEADER);

/** A Graphic Control Extension with the transparent-colour flag set. */
const gifAlpha = (b: Uint8Array): boolean => {
  let o = gifBlocksStart(b);
  while (o < b.length) {
    const block = b[o];
    if (block === 0x3b || block === undefined) return false;
    if (block === 0x21) {
      if (b[o + 1] === 0xf9 && (b[o + 3]! & 1) === 1) return true;
      o = skipSubBlocks(b, o + 2);
    } else if (block === 0x2c) {
      const packed = b[o + 9]!;
      const table = packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
      o = skipSubBlocks(b, o + 10 + table + 1);
    } else return false;
  }
  return false;
};

const alphaOf = (format: ImageFormat, b: Uint8Array): boolean => {
  if (format === 'png') return pngAlpha(b);
  if (format === 'webp') return webpAlpha(b);
  if (format === 'gif') return gifAlpha(b);
  return false;
};

// ---------- SVG ----------

/** An SVG document is XML text whose root element is `<svg>`; only the start of the file is looked at. */
const SVG_HEAD_BYTES = 65536;
const SVG_ROOT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[^\]]*\])?\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*(<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>)/i;

/** CSS pixels per unit of the absolute lengths an SVG may use. */
const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
};

/** A length in pixels; `undefined` for percentages and font-relative units, which depend on the page the SVG is placed in. */
const lengthPx = (value: string | undefined): number | undefined => {
  const match = value === undefined ? null : /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value);
  if (!match) return undefined;
  const px = Number(match[1]) * UNIT_PX[(match[2] ?? '').toLowerCase()]!;
  return px > 0 ? Math.round(px * 100) / 100 : undefined;
};

const viewBoxSize = (tag: string): { width: number; height: number } | undefined => {
  const numbers = (attribute(tag, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const [width, height] = [numbers[2], numbers[3]];
  return numbers.length === 4 && width! > 0 && height! > 0 ? { width: width!, height: height! } : undefined;
};

const svgOf = (bytes: Uint8Array): PictureInfo | null => {
  const root = SVG_ROOT.exec(new TextDecoder().decode(bytes.subarray(0, SVG_HEAD_BYTES)));
  if (!root) return null;
  const tag = root[1]!;
  const box = viewBoxSize(tag);
  const width = lengthPx(attribute(tag, 'width')) ?? box?.width;
  const height = lengthPx(attribute(tag, 'height')) ?? box?.height;
  return { format: 'svg', ...(width !== undefined && height !== undefined ? { width, height } : {}) };
};

/**
 * Format, size and transparency of the picture in `bytes`. An `ImageError` (`not a readable picture file: name`) when the
 * bytes are not a readable PNG, JPEG, WebP, GIF or SVG.
 */
export const describePicture = (bytes: Uint8Array, name?: string): PictureInfo => {
  try {
    const { format, width, height } = sniffImage(bytes, name);
    return { format, width, height, hasAlpha: alphaOf(format, bytes) };
  } catch (error) {
    if (!(error instanceof ImageError)) throw error;
    const svg = svgOf(bytes);
    if (svg) return svg;
    throw error;
  }
};
