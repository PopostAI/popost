/**
 * Image header checks in place of Pillow's `Image.open(...).verify()`: the format and pixel size of a PNG, JPEG, WebP or
 * GIF, read from the bytes. A file that is not one of these, or is cut short, is rejected.
 */
import { msg } from '../i18n';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly mime: string;
}

export class ImageError extends Error {
  override name = 'ImageError';
}

/** The message for bytes that are not a picture popost can read (or are a damaged one); `name` is the path the user typed. */
export const notPictureText = (name?: string): string =>
  name === undefined
    ? msg('not a readable picture file', '不是可读取的图片文件')
    : msg(`not a readable picture file: ${name}`, `不是可读取的图片文件：${name}`);

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
export const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
export const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

const png = (b: Uint8Array): ImageInfo | null => {
  if (b.length < 33 || u32be(b, 0) !== 0x89504e47 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { format: 'png', width: u32be(b, 16), height: u32be(b, 20), mime: MIME.png };
};

const gif = (b: Uint8Array): ImageInfo | null => {
  if (b.length < 13 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), mime: MIME.gif };
};

const webp = (b: Uint8Array): ImageInfo | null => {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, mime: MIME.webp };
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mime: MIME.webp };
  }
  if (chunk === 'VP8X') return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, mime: MIME.webp };
  return null;
};

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const jpeg = (b: Uint8Array): ImageInfo | null => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (SOF.has(marker)) return { format: 'jpeg', width: u16be(b, o + 7), height: u16be(b, o + 5), mime: MIME.jpeg };
    o += 2 + u16be(b, o + 2);
  }
  return null;
};

/**
 * Format and size of an image, or an `ImageError` when the bytes are not a readable PNG, JPEG, WebP or GIF. `name` (the
 * path the user typed) is named in the message: `not a readable picture file: x.png`.
 */
export const sniffImage = (bytes: Uint8Array, name?: string): ImageInfo => {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
  if (!info || info.width < 1 || info.height < 1)
    throw new ImageError(notPictureText(name));
  return info;
};

export const isImage = (bytes: Uint8Array): boolean => {
  try {
    sniffImage(bytes);
    return true;
  } catch {
    return false;
  }
};
