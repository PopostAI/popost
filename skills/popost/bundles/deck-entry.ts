/**
 * The in-page half of `popost deck export|import`: the editor's own `compileProject` / `splitProject`, bundled into one
 * script (`bundles/build-deck.mjs` writes it to `src/deck/compile-bundle.ts`) and run in a Chromium page that holds nothing
 * else. The editor code needs a real DOM and CSSOM (`DOMParser`, `CSSStyleSheet`), which is why it runs in a browser.
 *
 * Project HTML only ever goes through `DOMParser`: parsed documents have no browsing context, so nothing in them runs.
 * Stylesheets come from the host (`__popostReadStylesheet`, answered from the project's files), never from the network.
 * This file is not part of the TypeScript program of `src/`: it imports the editor package, which has its own settings.
 */
import { compileProject, splitProject } from '../../../packages/canvas-editor/src/storage/compile';
import type { ManifestPage, PreviousPage, SplitPage } from '../../../packages/canvas-editor/src/storage/compile';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
type Size = { width: number; height: number };

interface HostWindow {
  /** Provided by the host page (`page.exposeFunction`): the text of a project stylesheet, or a rejection. */
  __popostReadStylesheet(href: string): Promise<string>;
  __popostDeck: unknown;
}

const host = window as unknown as HostWindow;

const attempt = async <T>(fn: () => T | Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

/** Elements the editor's static-document contract (`validateDeck`) refuses; a page that has them is exported without. */
const FORBIDDEN = 'script,iframe,object,embed,base,form,meta[http-equiv]';
const SCRIPT_URL = /^\s*javascript:/i;

/** The page without active content: what the editor accepts as a deck. */
const stripActive = (html: string): string => {
  const doc = parse(html);
  doc.querySelectorAll(FORBIDDEN).forEach((node) => node.remove());
  for (const element of doc.querySelectorAll('*')) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? '';
      const url = name === 'href' || name === 'src' || name === 'xlink:href' || name === 'poster';
      if (/^on/i.test(name) || (url && SCRIPT_URL.test(value))) element.removeAttribute(name);
    }
  }
  return '<!doctype html>' + doc.documentElement.outerHTML;
};

const compile = (pages: readonly ManifestPage[], origin: string): Promise<string> =>
  compileProject(
    { pages: pages.map((page) => ({ ...page, html: stripActive(page.html) })) },
    { origin, fetchStylesheet: (url) => host.__popostReadStylesheet(url.href) },
  );

/** Top-level `.slide` elements, selected exactly as `splitProject` does. */
const topSlides = (doc: Document): HTMLElement[] =>
  [...doc.querySelectorAll<HTMLElement>('.slide')].filter((node) => !node.parentElement?.closest('.slide'));

/** A slide as comparable text. The name is left out: it lives in the manifest and `compileProject` stamps it from there. */
const signature = (node: HTMLElement): string => {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-popost-name');
  return copy.outerHTML;
};

const randomPageId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'p-' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const split = (content: string, previousPages: readonly PreviousPage[], defaultSize: Size) =>
  attempt(() => ({
    pages: splitProject(content, { previousPages, defaultSize, newPageId: randomPageId }) as SplitPage[],
    signatures: topSlides(parse(content)).map(signature),
  }));

/**
 * The forms a page's slide may have in a document that has not been edited. Compiling a page that came from the editor adds
 * a `style[data-popost-head-style]` (its head's reset CSS, scoped) to the slide, which the document the page came from does
 * not have; so the slide is also given without it. Anything else different is an edit.
 */
const acceptable = (slide: HTMLElement): string[] => {
  const bare = slide.cloneNode(true) as HTMLElement;
  bare.querySelectorAll('style[data-popost-head-style]').forEach((node) => node.remove());
  return [...new Set([signature(slide), signature(bare)])];
};

/** What each page looks like in the editor document right now (its acceptable forms), or `null` when it does not compile. */
const baseline = (pages: readonly ManifestPage[], origin: string) =>
  attempt(async () => {
    const out: Record<string, string[] | null> = {};
    for (const page of pages) {
      try {
        const [slide] = topSlides(parse(await compile([page], origin)));
        out[page.id] = slide ? acceptable(slide) : null;
      } catch {
        out[page.id] = null;
      }
    }
    return out;
  });

host.__popostDeck = {
  compile: (pages: ManifestPage[], origin: string) => attempt(() => compile(pages, origin)),
  split,
  baseline,
};
