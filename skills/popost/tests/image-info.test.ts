/**
 * `popost image info`: format, size and transparency of picture files from their headers, with tiny files built here
 * byte by byte (PNG colour types and tRNS, JPEG, the three WebP flavours, GIF with and without a transparent colour, SVG).
 */
import { describe, expect, it } from 'vitest';
import { describePicture } from '../src/core/image-info';
import { createTestRuntime, runCli } from '../src/testing/memory';
import { newScene, tinyPng } from './image-helpers';

const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : [...part])));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

const chunk = (kind: string, data: number[]): number[] => [...be32(data.length), ...bytes(kind), ...data, 0, 0, 0, 0];
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG whose chunks are only as valid as the header reader needs (no pixel data is decoded). */
const png = (width: number, height: number, colourType: number, extra: { trns?: boolean } = {}): Uint8Array =>
  bytes(SIGNATURE, chunk('IHDR', [...be32(width), ...be32(height), 8, colourType, 0, 0, 0]), extra.trns ? chunk('tRNS', [0, 0]) : [], chunk('IDAT', [1, 2, 3]), chunk('IEND', []));

const jpeg = (width: number, height: number): Uint8Array =>
  bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], [0xff, 0xc0, 0x00, 0x11, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);

const riff = (body: Uint8Array): Uint8Array => bytes('RIFF', le32(body.length + 4), 'WEBP', body);
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

const webpX = (width: number, height: number, flags: number): Uint8Array => riff(bytes('VP8X', le32(10), [flags, 0, 0, 0], le24(width - 1), le24(height - 1)));
const webpL = (width: number, height: number, alpha: boolean): Uint8Array => {
  const header = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
  return riff(bytes('VP8L', le32(13), [0x2f], le32(header >>> 0), new Array(8).fill(0)));
};
const webpLossy = (width: number, height: number): Uint8Array => riff(bytes('VP8 ', le32(10), [0, 0, 0, 0x9d, 0x01, 0x2a], le16(width), le16(height)));

/** A GIF with a global colour table of 2 entries, one frame, and optionally a transparent colour index. */
const gif = (width: number, height: number, transparent: boolean): Uint8Array =>
  bytes(
    'GIF89a', le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255],
    [0x21, 0xff, 0x0b], 'NETSCAPE2.0', [3, 1, 0, 0, 0],
    [0x21, 0xf9, 4, transparent ? 1 : 0, 0, 0, 0, 0],
    [0x2c, 0, 0, 0, 0], le16(width), le16(height), [0, 2, 2, 0x44, 0x01, 0],
    [0x3b],
  );

describe('describePicture', () => {
  it('reads the size of every format and the alpha channel of a PNG', () => {
    expect(describePicture(png(1024, 768, 6))).toEqual({ format: 'png', width: 1024, height: 768, hasAlpha: true });
    expect(describePicture(png(10, 20, 4))).toMatchObject({ hasAlpha: true });
    expect(describePicture(png(10, 20, 2))).toEqual({ format: 'png', width: 10, height: 20, hasAlpha: false });
    expect(describePicture(png(10, 20, 3))).toMatchObject({ hasAlpha: false });
    expect(describePicture(png(10, 20, 0))).toMatchObject({ hasAlpha: false });
  });

  it('finds the transparent colour of a palette, grey or RGB PNG in its tRNS chunk', () => {
    for (const colourType of [0, 2, 3]) expect(describePicture(png(4, 4, colourType, { trns: true }))).toMatchObject({ hasAlpha: true });
    expect(describePicture(tinyPng())).toMatchObject({ format: 'png', width: 2, height: 2, hasAlpha: false });
  });

  it('reads a JPEG from its first start-of-frame marker and reports no alpha', () => {
    expect(describePicture(jpeg(1200, 1600))).toEqual({ format: 'jpeg', width: 1200, height: 1600, hasAlpha: false });
  });

  it('reads the three kinds of WebP, with the alpha flag of VP8X and VP8L', () => {
    expect(describePicture(webpX(640, 480, 0x10))).toEqual({ format: 'webp', width: 640, height: 480, hasAlpha: true });
    expect(describePicture(webpX(640, 480, 0x00))).toMatchObject({ hasAlpha: false });
    expect(describePicture(webpX(640, 480, 0x20))).toMatchObject({ hasAlpha: false }); // an ICC profile, no alpha
    expect(describePicture(webpL(300, 200, true))).toEqual({ format: 'webp', width: 300, height: 200, hasAlpha: true });
    expect(describePicture(webpL(300, 200, false))).toMatchObject({ width: 300, height: 200, hasAlpha: false });
    expect(describePicture(webpLossy(320, 240))).toEqual({ format: 'webp', width: 320, height: 240, hasAlpha: false });
  });

  it('reads a GIF and its transparent colour, skipping the extensions in front of the frame', () => {
    expect(describePicture(gif(48, 32, true))).toEqual({ format: 'gif', width: 48, height: 32, hasAlpha: true });
    expect(describePicture(gif(48, 32, false))).toEqual({ format: 'gif', width: 48, height: 32, hasAlpha: false });
  });

  it('reads an SVG from width and height, else from the viewBox, with units converted to pixels', () => {
    const svg = (attributes: string, prolog = '') => new TextEncoder().encode(`${prolog}<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="5" height="5"/></svg>`);
    expect(describePicture(svg('width="120" height="80"'))).toEqual({ format: 'svg', width: 120, height: 80 });
    expect(describePicture(svg('width="64px" height="1in" viewBox="0 0 10 10"'))).toEqual({ format: 'svg', width: 64, height: 96 });
    expect(describePicture(svg('viewBox="0 0 24 24"'))).toEqual({ format: 'svg', width: 24, height: 24 });
    expect(describePicture(svg('width="100%" height="50%" viewBox="0 0 300 150" stroke-width="2"'))).toEqual({ format: 'svg', width: 300, height: 150 });
    expect(describePicture(svg(''))).toEqual({ format: 'svg' });
    expect(describePicture(svg('viewBox="0,0,16,9"', '\uFEFF<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'))).toEqual({ format: 'svg', width: 16, height: 9 });
  });

  it('rejects what is not a picture, a cut-off header, and an HTML page that mentions svg', () => {
    for (const data of [bytes('hello'), bytes(), png(4, 4, 6).slice(0, 20), new TextEncoder().encode('<html><body><svg width="1" height="1"></svg></body></html>')])
      expect(() => describePicture(data, 'x.bin')).toThrow('not a readable picture file: x.bin');
  });
});

const scene = async (files: Record<string, Uint8Array | string>) => {
  const { rt } = await newScene({ files });
  const run = async (...argv: string[]) => {
    const { code, stdout, stderr } = await runCli(rt, ['image', 'info', ...argv]);
    return { code, stderr, data: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null };
  };
  return { rt, run };
};

const svgFile = '<svg viewBox="0 0 8 4"></svg>';

describe('popost image info', () => {
  it('describes several files in one call, needs no project and no --dir, and prints one compact document', async () => {
    const { rt, run } = await scene({ '/work/a.png': png(1024, 1024, 6), '/work/inputs/p.jpg': jpeg(900, 1200), '/work/v.svg': svgFile });
    const r = await run('--file', 'a.png', 'inputs/p.jpg', 'v.svg');
    expect(r.code).toBe(0);
    expect(r.data).toEqual({
      ok: true,
      images: [
        { file: 'a.png', format: 'png', width: 1024, height: 1024, hasAlpha: true, bytes: png(1024, 1024, 6).length },
        { file: 'inputs/p.jpg', format: 'jpeg', width: 900, height: 1200, hasAlpha: false, bytes: jpeg(900, 1200).length },
        { file: 'v.svg', format: 'svg', width: 8, height: 4, bytes: svgFile.length },
      ],
    });
    expect(rt.stdoutText().trim().split('\n')).toHaveLength(1);
  });

  it('reports an unreadable or non-picture file on its own entry and still exits 0 while one file worked', async () => {
    const { run } = await scene({ '/work/a.png': png(8, 8, 2), '/work/notes.txt': 'not a picture', '/work/dir/x': 'x' });
    const r = await run('--file', 'a.png', 'notes.txt', 'missing.png', 'dir');
    expect(r.code).toBe(0);
    expect(r.data).toMatchObject({ ok: true });
    const images = r.data!.images as Record<string, unknown>[];
    expect(images[0]).toMatchObject({ file: 'a.png', format: 'png', width: 8 });
    expect(images[1]).toEqual({ file: 'notes.txt', ok: false, error: 'not a readable picture file: notes.txt' });
    expect(images[2]).toEqual({ file: 'missing.png', ok: false, error: 'file not found: missing.png' });
    expect(images[3]).toEqual({ file: 'dir', ok: false, error: 'dir is a folder, not a file' });
  });

  it('exits 2 when every file failed, and still lists them', async () => {
    const { run } = await scene({ '/work/notes.txt': 'text' });
    const r = await run('--file', 'notes.txt', 'nope.png');
    expect(r.code).toBe(2);
    expect(r.data).toMatchObject({ ok: false, error: 'none of the files is a readable picture' });
    expect((r.data!.images as unknown[]).length).toBe(2);
  });

  it('looks a relative path up inside --dir when it is not there from the working directory', async () => {
    const { run } = await scene({ '/work/proj/assets/a.png': png(5, 6, 6), '/work/a.png': png(1, 1, 2) });
    const inside = await run('--dir', 'proj', '--file', 'assets/a.png');
    expect(inside.data).toMatchObject({ ok: true, images: [{ file: 'assets/a.png', width: 5, height: 6 }] });
    const here = await run('--dir', 'proj', '--file', 'a.png'); // the working directory wins
    expect(here.data).toMatchObject({ images: [{ file: 'a.png', width: 1, height: 1 }] });
  });

  it('is a usage error without --file, and answers --help with its own usage', async () => {
    const { rt, run } = await scene({});
    const bare = await run();
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('the following arguments are required: --file');
    const help = await runCli(rt, ['image', 'info', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage: popost image info [-h] --file PATH [PATH ...] [--dir DIR]');
    expect(help.stdout).toContain('hasAlpha');
  });

  it('leaves the other actions as they were: --dir is still required, and info cannot be named after the options', async () => {
    const { rt } = await scene({});
    const noDir = await runCli(rt, ['image', 'prepare', '--prompt-file', 'p.md']);
    expect(noDir.code).toBe(2);
    expect(noDir.stderr).toBe('usage: popost image [-h] ...\npopost image: error: the following arguments are required: --dir\n');
    const neither = await runCli(rt, ['image']);
    expect(neither.stderr).toContain('the following arguments are required: action, --dir');
    const late = await runCli(rt, ['image', '--dir', 'P', 'info']);
    expect(late.code).toBe(2);
    expect(late.stdout).toContain('info comes first');
    const overview = await runCli(rt, ['image', '--help']);
    expect(overview.stdout).toContain('{prepare,quote,run,complete,status,info}');
  });

  it('is listed in the usage of a bare popost call', async () => {
    const rt = createTestRuntime();
    const { stdout } = await runCli(rt, ['--help']);
    expect(stdout).toContain('images:    image (prepare, quote, run, complete, status, info),');
    expect(stdout).toContain('project:   setup,');
  });
});
