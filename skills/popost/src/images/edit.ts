/**
 * `image edit --file in --out out [...]`: crop, rotate, flip, resize and convert one picture into a new file, so that
 * nobody builds a scratch page (or looks for ImageMagick, Pillow or sharp) to cut a region out or to look at a detail
 * enlarged. The source file is never changed.
 */
import type { ParsedArgs } from '../args';
import { ValueError } from '../core/errors';
import { describePicture } from '../core/image-info';
import { writeAtomic } from '../core/util';
import { editPicture } from '../render/edit';
import { mimeType } from '../render/mime';
import type { Runtime } from '../runtime';
import { readUserBytes } from '../workflow/io';
import { backgroundOf, formatOf, planEdit, type EditRequest } from './edit-plan';

const DEFAULT_QUALITY = 90;

const requestOf = (args: ParsedArgs): EditRequest => ({
  crop: args.string('crop'),
  rotate: args.number('rotate'),
  flip: args.string('flip'),
  width: args.number('width'),
  height: args.number('height'),
  scale: args.number('scale'),
  fit: args.string('fit'),
  grid: args.flag('grid'),
});

const qualityOf = (args: ParsedArgs): number => {
  const quality = args.number('quality') ?? DEFAULT_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new ValueError('--quality takes a whole number from 1 to 100');
  return quality;
};

/** The result object the command prints. Throws the expected failures (`ValueError`, a missing file, not a picture). */
export const editFile = async (rt: Runtime, args: ParsedArgs): Promise<Record<string, unknown>> => {
  const file = args.req('file');
  const out = args.req('out');
  const format = formatOf(out);
  const output = { format, quality: qualityOf(args), background: backgroundOf(format, args.string('background')) };
  const request = requestOf(args);
  const target = rt.path.resolve(rt.cwd, out);
  if (target === rt.path.resolve(rt.cwd, file)) throw new ValueError('--out is the source file: write the result to a new file, the source stays as it is');
  const data = await readUserBytes(rt, file);
  const info = describePicture(data, file);
  const mime = info.format === 'svg' ? 'image/svg+xml' : mimeType(`x.${info.format}`);
  // Checked against the header size first, so a wrong option fails before a browser starts; the browser's size decides.
  if (info.width !== undefined && info.height !== undefined && info.format !== 'jpeg') planEdit(info.width, info.height, request);
  const result = await editPicture(rt, { mime, data }, (width, height) => planEdit(width, height, request), output);
  await rt.fs.mkdir(rt.path.dirname(target));
  await writeAtomic(rt, target, result.bytes);
  return {
    ok: true,
    path: out,
    format,
    width: result.plan.width,
    height: result.plan.height,
    bytes: result.bytes.byteLength,
    source: { file, format: info.format, width: result.source.width, height: result.source.height },
    steps: result.plan.steps,
    ...(result.plan.grid ? { grid: { step: result.plan.grid.step, unit: 'source px', note: 'a picture to look at, not an asset: read the box off the lines, then crop the source again without --grid' } } : {}),
  };
};
