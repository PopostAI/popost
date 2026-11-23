/**
 * Resolved -> one self-contained HTML page: the page runtime (page/main.ts, bundled ahead of time into page-bundle.ts by
 * bundles/build-video.mjs), the timeline as JSON, minimal CSS. Image src values stay relative URLs; whoever serves the
 * page serves the project directory next to it.
 */
import type { Resolved } from '../types';
import type { PageData } from '../page/contract';
import { PAGE_BUNDLE } from './page-bundle';

/** JSON that is safe inside a <script> element: no "</script", no line separators that end a JS string. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const CSS = 'html,body{margin:0;padding:0;background:#000;overflow:hidden}*{box-sizing:border-box}img{user-select:none}';

/** opts.scale (0 < scale <= 4, default 1) renders the same picture at width*scale x height*scale pixels. */
export const compilePage = async (resolved: Resolved, opts: { scale?: number } = {}): Promise<string> => {
  const scale = opts.scale ?? 1;
  if (!(scale > 0 && scale <= 4)) throw new Error('compilePage: scale is ' + scale + '; it must be greater than 0 and at most 4. Use 1 for full size or 0.5 for half.');
  const js = PAGE_BUNDLE.replace(/<\/script/gi, '<\\/script');
  const data: PageData = { resolved, scale };
  return '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>popost video</title><style>' + CSS + '</style></head><body>' +
    '<script type="application/json" id="popost-data">' + scriptJson(data) + '</script>' +
    '<script>' + js + '</script></body></html>\n';
};
