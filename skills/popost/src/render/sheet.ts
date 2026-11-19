/**
 * Draw an overview sheet (`popost sheet`) as one JPEG. There is no image library: the grid is an HTML page, built from
 * the layout of `sheet-layout.ts` with every picture embedded as a `data:` URL, and screenshotted in the same offline
 * Chromium that renders the pages. Pictures are read by the caller through the runtime's file system.
 */
import { ValueError } from '../core/errors';
import { escapeHtml } from '../core/util';
import type { Runtime } from '../runtime';
import { hasBrokenImage, openOfflineContext, settlePage, withBrowser } from './offline';
import type { PlacedTile, SheetImage, SheetLayout } from './sheet-layout';

/** A picture that is ready to draw: its bytes and the mime type its header says it has. */
export interface SheetPicture extends SheetImage {
  readonly mime: string;
  readonly data: Uint8Array;
}

export const SHEET_JPEG_QUALITY = 80;

const BACKGROUND = '#24262a';
const BOX = '#7b7f86';
const BAR = '#0b0c0e';
const FONTS = '"Helvetica Neue", Arial, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

const dataUrl = (picture: SheetPicture): string => `data:${picture.mime};base64,${Buffer.from(picture.data).toString('base64')}`;

const tileHtml = (tile: PlacedTile<SheetPicture>, layout: SheetLayout<SheetPicture>): string => {
  const { cell } = layout;
  const pad = Math.round(cell.fontSize * 0.6);
  return (
    `<div class="t" style="left:${tile.x}px;top:${tile.y}px;width:${cell.width}px;height:${cell.height}px">` +
    `<div class="bar" style="height:${cell.barHeight}px;line-height:${cell.barHeight}px;font-size:${cell.fontSize}px;padding:0 ${pad}px">` +
    `${escapeHtml(tile.text)}</div>` +
    `<div class="box" style="top:${cell.barHeight}px;height:${cell.boxHeight}px"><img alt="" src="${dataUrl(tile)}"></div></div>`
  );
};

/** The page of the sheet: absolutely positioned cells on a dark ground, no scripts, no external requests. */
export const sheetHtml = (layout: SheetLayout<SheetPicture>): string =>
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  '*{margin:0;padding:0;box-sizing:border-box}' +
  `html,body{width:${layout.width}px;height:${layout.height}px;overflow:hidden;background:${BACKGROUND}}` +
  `body{position:relative;font-family:${FONTS};font-weight:700}` +
  '.t{position:absolute;overflow:hidden}' +
  `.bar{position:absolute;left:0;top:0;width:100%;background:${BAR};color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` +
  `.box{position:absolute;left:0;width:100%;background:${BOX}}` +
  '.box img{display:block;width:100%;height:100%;object-fit:contain}' +
  `</style></head><body>${layout.tiles.map((tile) => tileHtml(tile, layout)).join('')}</body></html>`;

/** The sheet as JPEG bytes, at exactly `layout.width` x `layout.height`. */
export const renderSheet = (rt: Runtime, layout: SheetLayout<SheetPicture>): Promise<Uint8Array> =>
  withBrowser(rt, async (browser) => {
    // The page holds only data: URLs; the offline context refuses everything else all the same.
    const { context } = await openOfflineContext(rt, browser, rt.cwd, { scale: 1 });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.setContent(sheetHtml(layout), { waitUntil: 'load', timeout: 30_000 });
      await settlePage(page);
      if (await hasBrokenImage(page)) throw new ValueError('a picture on the sheet could not be decoded');
      return await page.screenshot({ type: 'jpeg', quality: SHEET_JPEG_QUALITY, animations: 'disabled' });
    } finally {
      await context.close();
    }
  });
