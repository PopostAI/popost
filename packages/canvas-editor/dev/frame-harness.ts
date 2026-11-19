/**
 * Dev-only harness for the edit-frame controller: mounts a realistic two-page post in an iframe through a fake store
 * (blob: preview URL) and exposes `window.__harness` for browser-driven checks. Not part of the editor build.
 */
import type { DocIndex, FrameToShell } from '../src/contracts';
import { blockKind, pageRoots, selectableBlocks } from '../src/core/pages';
import { PP_ID_ATTR } from '../src/core/preview';
import { parseIndex } from '../src/core/source';
import { createFrameController } from '../src/frame';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const SOURCE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Harness post</title>
<style>
  body { margin: 0; padding: 60px; min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column;
         align-items: center; justify-content: center; gap: 40px; background: #ddd; font-family: Georgia, serif; }
  .slide { position: relative; width: 1080px; height: 1440px; background: #fff; overflow: hidden; flex: none; }
  h1 { position: absolute; left: 80px; top: 100px; margin: 0; font-size: 72px; width: 800px; }
  .copy { position: absolute; left: 80px; top: 300px; width: 600px; font-size: 32px; margin: 0; }
  .tight { position: absolute; left: 80px; top: 500px; width: 300px; height: 40px; font-size: 32px; margin: 0; line-height: 1.2; }
  img.photo { position: absolute; left: 700px; top: 300px; width: 200px; height: 200px; image-rendering: pixelated; }
  svg.mark { position: absolute; left: 80px; top: 700px; width: 160px; height: 160px; }
  .layer { position: absolute; left: 400px; top: 700px; width: 300px; height: 200px; background: #fc6; }
</style>
</head>
<body>
<section class="slide" data-popost-page="p-aaaaaaaaaaaa">
  <h1>Harness heading</h1>
  <p class="copy">First paragraph with <b>bold</b> and plain words to edit.</p>
  <p class="tight">This paragraph has far more text than its tiny box can hold, so it overflows.</p>
  <img class="photo" src="${PNG}" alt="dot">
  <svg class="mark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#e33"></circle><text x="30" y="55">Hi</text></svg>
  <div class="layer" data-layer-id="layer-1"><span>Layer text</span></div>
</section>
<section class="slide" data-popost-page="p-bbbbbbbbbbbb">
  <h1>Second page</h1>
  <p class="copy">Page two body.</p>
</section>
</body>
</html>`;

/** Mirror of the `data-pp-sel` marks in `buildPreview` for cores that do not write them yet. */
function ensureSelMarks(html: string, index: DocIndex): string {
  if (html.includes('data-pp-sel')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const id of selectableBlocks(index)) {
    doc.querySelector(`[${PP_ID_ATTR}="${id}"]`)?.setAttribute('data-pp-sel', blockKind(index, id));
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

const index = parseIndex(SOURCE);
const events: FrameToShell[] = [];
const blobs: string[] = [];
const store = {
  async preview(html: string): Promise<string> {
    const url = URL.createObjectURL(new Blob([ensureSelMarks(html, index)], { type: 'text/html' }));
    blobs.push(url);
    return url;
  },
};

const controller = createFrameController({ store });
controller.on((e) => events.push(e));
const iframe = document.getElementById('frame') as HTMLIFrameElement;
// `?w=1280&h=1700` makes the frame larger than the page so the centring compensation is exercised.
const q = new URLSearchParams(location.search);
if (q.get('w')) iframe.style.width = `${q.get('w')}px`;
if (q.get('h')) iframe.style.height = `${q.get('h')}px`;
const pages = pageRoots(index).map((p) => p.id);

const api = {
  controller,
  events,
  index,
  pages,
  iframe,
  blobs: () => blobs,
  mount: (currentPageId: string | null = pages[0]) => controller.mount(iframe, index, { currentPageId }),
  /** First block id matching a CSS selector in the frame (by its data-pp-id). */
  idOf: (selector: string): string | null =>
    iframe.contentDocument?.querySelector(selector)?.getAttribute(PP_ID_ATTR) ?? null,
};
(window as unknown as { __harness: typeof api }).__harness = api;
void api.mount().then(
  () => document.body.setAttribute('data-harness', 'mounted'),
  (err: unknown) => document.body.setAttribute('data-harness', `error: ${String(err)}`),
);
