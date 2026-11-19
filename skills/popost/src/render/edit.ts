/**
 * Draw an edited picture (`popost image edit`). There is no image library: the source is decoded by the same offline
 * Chromium that renders the pages, drawn onto a canvas the way the plan says (images/edit-plan.ts) and encoded there.
 * The size the plan works with is the one the browser decoded (EXIF rotation applied, an SVG at its own size), not the
 * one in the file header.
 */
import { ValueError } from '../core/errors';
import type { EditFormat, EditPlan } from '../images/edit-plan';
import type { Runtime } from '../runtime';
import { callInPage, openOfflineContext, settlePage, withBrowser } from './offline';

export interface EditSource {
  readonly mime: string;
  readonly data: Uint8Array;
}

export interface EditOutput {
  readonly format: EditFormat;
  /** 1-100, for JPEG and WebP. */
  readonly quality: number;
  /** A CSS colour painted under the picture, or `null` to keep transparency. */
  readonly background: string | null;
}

export interface EditResult {
  readonly bytes: Uint8Array;
  readonly plan: EditPlan;
  readonly source: { readonly width: number; readonly height: number };
}

const SIZE_SCRIPT = `() => {
  const image = document.getElementById('source');
  return { width: image.naturalWidth, height: image.naturalHeight };
}`;

// Canvas transforms apply to the picture in reverse order of the calls: it is rotated first, then mirrored, then moved.
const DRAW_SCRIPT = `({ plan, output }) => {
  const image = document.getElementById('source');
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (output.background) {
    context.fillStyle = output.background;
    context.fillRect(0, 0, plan.width, plan.height);
  }
  const turned = plan.rotate === 90 || plan.rotate === 270;
  const width = turned ? plan.draw.height : plan.draw.width;
  const height = turned ? plan.draw.width : plan.draw.height;
  context.translate(plan.draw.x + plan.draw.width / 2, plan.draw.y + plan.draw.height / 2);
  context.scale(plan.flip === 'h' ? -1 : 1, plan.flip === 'v' ? -1 : 1);
  context.rotate((plan.rotate * Math.PI) / 180);
  context.drawImage(image, plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height, -width / 2, -height / 2, width, height);
  if (plan.grid) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.max(11, Math.min(20, Math.round(Math.min(plan.width, plan.height) / 36)));
    context.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
    context.textBaseline = 'top';
    const line = (x0, y0, x1, y1) => {
      for (const [colour, width] of [['rgba(255,255,255,0.85)', 3], ['rgba(230,0,120,0.95)', 1]]) {
        context.strokeStyle = colour;
        context.lineWidth = width;
        context.beginPath();
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
        context.stroke();
      }
    };
    const label = (text, x, y) => {
      const w = context.measureText(text).width + 6;
      const left = Math.max(0, Math.min(plan.width - w, x));
      const top = Math.max(0, Math.min(plan.height - size - 4, y));
      context.fillStyle = 'rgba(20,20,24,0.88)';
      context.fillRect(left, top, w, size + 4);
      context.fillStyle = '#ffffff';
      context.fillText(text, left + 3, top + 2);
    };
    for (const x of plan.grid.xs) line(Math.round(x.at) + 0.5, 0, Math.round(x.at) + 0.5, plan.height);
    for (const y of plan.grid.ys) line(0, Math.round(y.at) + 0.5, plan.width, Math.round(y.at) + 0.5);
    for (const x of plan.grid.xs) label(x.label, x.at + 2, 0);
    for (const y of plan.grid.ys) label(y.label, 0, y.at + 2);
  }
  return canvas.toDataURL('image/' + output.format, output.quality / 100);
}`;

const sourceHtml = (source: EditSource): string =>
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  `<img id="source" alt="" src="data:${source.mime};base64,${Buffer.from(source.data).toString('base64')}"></body></html>`;

const decodeDataUrl = (url: string, format: EditFormat): Uint8Array => {
  const prefix = `data:image/${format};base64,`;
  if (!url.startsWith(prefix)) throw new ValueError(`this browser cannot write ${format} pictures; use another --out extension`);
  return new Uint8Array(Buffer.from(url.slice(prefix.length), 'base64'));
};

/**
 * Decode `source`, ask `plan` what to do with a picture of that size, and return the encoded result. `plan` may throw a
 * `ValueError` (a crop outside the picture, a result that is too large): nothing is drawn then.
 */
export const editPicture = (
  rt: Runtime,
  source: EditSource,
  plan: (width: number, height: number) => EditPlan,
  output: EditOutput,
): Promise<EditResult> =>
  withBrowser(rt, async (browser) => {
    // The page holds one data: URL; the offline context refuses everything else all the same (an SVG's external links too).
    const { context } = await openOfflineContext(rt, browser, rt.cwd, { scale: 1 });
    try {
      const page = await context.newPage();
      await page.setContent(sourceHtml(source), { waitUntil: 'load', timeout: 30_000 });
      await settlePage(page);
      const size = await callInPage<{ width: number; height: number }>(page, SIZE_SCRIPT);
      if (!size.width || !size.height) throw new ValueError('the picture could not be decoded');
      const planned = plan(size.width, size.height);
      const url = await callInPage<string>(page, DRAW_SCRIPT, { plan: planned, output });
      return { bytes: decodeDataUrl(url, output.format), plan: planned, source: size };
    } finally {
      await context.close();
    }
  });
