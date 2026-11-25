/**
 * Entry of the page runtime (bundled by compile/page.ts). Reads the embedded timeline, builds the DOM once and
 * exposes window.__popostVideo. No timers, no animation frames, no CSS animations: a frame is set only by applyFrame.
 */
import { applyFrame } from './apply';
import type { PageData, PopostVideoPage } from './contract';
import { buildStage, type StageNodes } from './dom';
import { sceneFacts } from './fit';
import { layoutOf } from './layout';
import { prepareScene, SceneLoadError } from './scene';

const readData = (): PageData => {
  const el = document.getElementById('popost-data');
  if (!el?.textContent) throw new Error('popost video page: the <script id="popost-data"> element with the timeline is missing. Build the page with compilePage.');
  return JSON.parse(el.textContent) as PageData;
};

/** The CSS font shorthand of every text item (and of its spoken weight, when it follows the words), without repeats. */
const fontsOf = (data: PageData): string[] => [
  ...new Set(data.resolved.items.flatMap((item) => {
    const s = item.style;
    if (item.type !== 'text' || !s) return [];
    const weights = [s.weight, ...(item.words && s.spoken?.weight ? [s.spoken.weight] : [])];
    return weights.map((w) => (s.italic ? 'italic ' : '') + w + ' ' + Math.round(s.size * data.resolved.canvas.height) + 'px ' + s.font);
  })),
];

const unquote = (family: string): string => family.replace(/^["']|["']$/g, '');

/**
 * Loads every face the page declares for a font material; rejects naming the first that fails. The faces come from
 * the @font-face rules dom.ts wrote, which the document lists in document.fonts.
 */
const loadDeclaredFonts = async (data: PageData): Promise<void> => {
  const declared = data.resolved.fonts ?? [];
  if (declared.length === 0) return;
  const faces: FontFace[] = [];
  document.fonts.forEach((f) => { faces.push(f); });
  await Promise.all(declared.map(async (font) => {
    const mine = faces.filter((f) => unquote(f.family) === font.family);
    const fail = (): Error => new Error('Font "' + font.family + '" (' + font.src + ') could not be loaded. Check that the file exists in the project directory and is a WOFF2, WOFF, TTF or OTF font.');
    if (mine.length === 0) throw fail();
    await Promise.all(mine.map((f) => f.load())).catch(() => { throw fail(); });
  }));
};

const prepareStatic = async (nodes: StageNodes, data: PageData): Promise<void> => {
  const missing = Object.entries(data.resolved.footage ?? {}).filter(([, f]) => f.dir === undefined).map(([id]) => '"' + id + '"');
  if (missing.length > 0)
    throw new Error('Video material ' + missing.join(', ') + ' has no extracted frames: the page was compiled from resolve() alone. Build it with buildPage, which extracts them into the project\'s .cache directory.');
  await Promise.all(nodes.images.map((img) => img.decode().catch(() => {
    throw new Error('Image "' + (img.getAttribute('src') ?? '') + '" could not be loaded. Check that the file exists in the project directory and is a PNG, JPEG or WebP picture.');
  })));
  // Every scene is waited for, so that the failures of all of them are reported together, each at its own segment.
  const scenes = await Promise.allSettled(nodes.segments.flatMap((s) => (s.scene ? [prepareScene(s.scene)] : [])));
  const failures = scenes.flatMap((r) => (r.status === 'rejected' && r.reason instanceof SceneLoadError ? r.reason.failures : []));
  if (failures.length > 0) throw new SceneLoadError(failures);
  const other = scenes.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (other) throw other.reason;
  await loadDeclaredFonts(data);
  const texts = data.resolved.items.map((i) => i.text ?? '').join('');
  // Fonts are matched while text is laid out; asking for each text font with the text makes the browser load them now.
  await Promise.all(fontsOf(data).map((font) => document.fonts.load(font, texts).catch(() => [])));
  await document.fonts.ready;
};

/** The video pictures of the last applyFrame call, and settle(), which waits until they are decoded. */
const createPictures = () => {
  let shown: HTMLImageElement[] = [];
  const settle = async (): Promise<void> => {
    const mine = shown;
    const results = await Promise.allSettled(mine.map((img) => img.decode()));
    // A newer applyFrame replaced the pictures meanwhile (the preview while playing): wait for those instead.
    if (mine !== shown) return settle();
    const bad = results.findIndex((x) => x.status === 'rejected');
    if (bad >= 0)
      throw new Error('The video frame picture "' + (mine[bad]?.getAttribute('src') ?? '') + '" could not be loaded. Build the page again: buildPage extracts the frames into the project\'s .cache directory.');
  };
  return { settle, set: (imgs: HTMLImageElement[]): void => { shown = imgs; } };
};

const start = (): void => {
  const data = readData();
  const r = data.resolved;
  const nodes = buildStage(document, document.body, r, data.scale);
  const pictures = createPictures();
  let markup: string | undefined;
  const page: PopostVideoPage = {
    frames: r.frames,
    fps: r.canvas.fps,
    width: r.canvas.width,
    height: r.canvas.height,
    scale: data.scale,
    prepare: async () => {
      await prepareStatic(nodes, data);
      await pictures.settle();
    },
    applyFrame: (n: number) => pictures.set(applyFrame(nodes, r, n)),
    previewFrame: (n: number) => pictures.set(applyFrame(nodes, r, n, false)),
    settle: () => pictures.settle(),
    layout: () => layoutOf(nodes, r, data.scale),
    scenes: (segment?: number) => sceneFacts(nodes, segment),
    changed: () => {
      const now = nodes.stage.innerHTML;
      const same = now === markup;
      markup = now;
      // A scene draws inside its own document, which the stage's markup does not show.
      return !same || nodes.live;
    },
  };
  page.applyFrame(0);
  window.__popostVideo = page;
};

start();
