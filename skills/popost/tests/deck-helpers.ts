/** Shared fixtures for the deck tests (not a test file itself). */
import { Project } from '../src/core/project';
import type { DeckSession, DeckSplit } from '../src/deck/types';
import type { TestRuntime } from '../src/testing/memory';
import { forgeRender, PNG_1X1 } from './workflow-helpers';

/** A page with a linked same-origin stylesheet, a local image and one text layer. */
export const pageDocument = (id: string, text: string, size: [number, number], extra = ''): string =>
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../css/chosen.css">' +
  `<style>.post{position:relative;width:${size[0]}px;height:${size[1]}px;background:#fafafa}</style></head>` +
  `<body><div class="post" data-canvas-width="${size[0]}" data-canvas-height="${size[1]}" ` +
  'style="color:#223344;background-color:#e8f0ff">' +
  `<h1 class="title" data-layer-id="${id}.title" style="position:absolute;left:10px;top:20px;width:150px"><span data-slot>${text}</span></h1>` +
  `<div data-layer-id="${id}.photo" style="position:absolute;left:10px;top:120px;width:60px;height:60px;background:url(../assets/local.png) center/cover"></div>` +
  `<img src="../assets/local.png" alt="">${extra}</div></body></html>`;

export const CHOSEN_CSS =
  '@font-face{font-family:"Demo";src:url(../fonts/demo.woff2) format("woff2")}\n' +
  '.title{font-family:"Demo",sans-serif;color:#123456;font-size:40px}\n';

/** A three page project: p1 300x400 (cover), p2 and p3 200x200, with the stylesheet, a font and an image. */
export const deckProject = async (rt: TestRuntime): Promise<Project> => {
  const project = await Project.create(rt, 'P', 'deck test', 'original', 300, 400);
  await project.addPage('p2', 'Two', 200, 200);
  await project.addPage('p3', 'Three', 200, 200);
  project.manifest.pages[0]!.role = 'cover';
  await rt.fs.writeFile('/work/P/css/chosen.css', CHOSEN_CSS);
  await rt.fs.writeFile('/work/P/fonts/demo.woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]));
  await project.addAssetBytes(PNG_1X1, 'local.png');
  await project.writePageHtml('p1', pageDocument('p1', 'First page 你好', [300, 400]));
  await project.writePageHtml('p2', pageDocument('p2', 'Second page', [200, 200]));
  await project.writePageHtml('p3', pageDocument('p3', 'Third page', [200, 200]));
  await project.saveManifest();
  return project;
};

/** Reviews, series review, PNG and render receipt for every page, as after a full production run. */
export const reviewEverything = async (rt: TestRuntime, project: Project): Promise<void> => {
  for (const { id } of project.manifest.pages) {
    await forgeRender(rt, project, id);
    project.manifest.reviews[id] = { reviewer: 'agent', note: `looked at ${id}` };
  }
  project.manifest.seriesReview = { reviewer: 'agent', note: 'sequence ok' };
  await project.saveManifest();
};

/** The slides of an editor document: top-level elements carrying `data-popost-page`, in order, and what surrounds them. */
export const slidesOf = (doc: string): { head: string; slides: { id: string; html: string }[]; tail: string } => {
  const starts = [...doc.matchAll(/<div [^>]*data-popost-page="([^"]+)"/g)];
  const end = doc.lastIndexOf('</body>');
  const slides = starts.map((match, i) => ({
    id: match[1]!,
    html: doc.slice(match.index, i + 1 < starts.length ? starts[i + 1]!.index : end).replace(/\n$/, ''),
  }));
  return { head: doc.slice(0, starts[0]!.index), slides, tail: doc.slice(end) };
};

export const compose = (parts: ReturnType<typeof slidesOf>, htmls: readonly string[]): string =>
  parts.head + htmls.join('\n') + parts.tail;

/** A converter that returns what it is given: manifest and file handling without a browser. */
export const fakeSession = (split: DeckSplit, baselines: Record<string, string | null> = {}): DeckSession =>
  (fn) =>
    fn({
      compile: async () => '<!doctype html><html><body><div class="slide" data-popost-page="p1"></div></body></html>',
      split: async () => split,
      baseline: async () => Object.fromEntries(Object.entries(baselines).map(([id, sig]) => [id, sig === null ? null : [sig]])),
    });
