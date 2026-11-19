/**
 * `popost deck import`: an editor document back into the project, so the agent's next turn sees what the user edited. The
 * document is split with the editor's own `splitProject` (run in Chromium, `engine.ts`), then
 *
 * - a page whose slide differs from what `popost deck export` would write for it now is **changed**: its page file is
 *   replaced, and its visual review, its render receipt and the series review are dropped, so nothing vouches for a page
 *   nobody has looked at since the edit. A page that is not changed keeps its file, review and render untouched;
 * - a slide with an id the project does not know is **added** (`pages/<id>.html`); a project page the document no longer has
 *   is **removed** (file, review and render included);
 * - the manifest takes the document's order, names and sizes; page ids, roles and everything else in it stay.
 *
 * Page files go through the same sanitizer as the local editor's saves (`editor/sanitize.ts`).
 */
import { ValueError } from '../core/errors';
import { MAX_CANVAS, Project, type PageEntry } from '../core/project';
import { writeAtomic } from '../core/util';
import { sanitizeHtml } from '../editor/sanitize';
import type { Runtime } from '../runtime';
import { chromeSession } from './engine';
import { loadDeckPage } from './pages';
import type { DeckPage, DeckSession, DeckSize, DeckSplit, DeckSplitPage } from './types';

export interface ImportDeckOptions {
  /** Replaces the Chromium-backed converter (tests). */
  readonly session?: DeckSession;
}

export interface ImportDeckResult {
  /** Pages in the project now. */
  readonly pages: number;
  /** Existing pages whose content changed (files rewritten, reviews and renders dropped). */
  readonly changed: string[];
  readonly added: string[];
  readonly removed: string[];
}

interface Diff {
  changed: string[];
  added: string[];
  removed: string[];
}

const NO_SLIDE = 'the document has no .slide page: nothing to import';
const FALLBACK_SIZE: DeckSize = { width: 1080, height: 1350 };

/** Size of a page that carries none: the project's own (its first page), else what `page add` uses. */
const defaultSizeOf = (project: Project): DeckSize => {
  const first = project.manifest.pages[0];
  return first ? { width: Number(first.width), height: Number(first.height) } : FALLBACK_SIZE;
};

const validSize = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_CANVAS;

const checkSizes = (pages: readonly DeckSplitPage[]): void => {
  for (const page of pages)
    if (!validSize(page.width) || !validSize(page.height))
      throw new ValueError(`page ${page.id}: canvas size must be whole pixels within 1..${MAX_CANVAS}`);
};

/** The project pages the document still has, read for the comparison; one that cannot be read counts as changed. */
const comparable = async (project: Project, split: DeckSplit): Promise<DeckPage[]> => {
  const ids = new Set(split.pages.map((page) => page.id));
  const pages: DeckPage[] = [];
  for (const entry of project.manifest.pages) {
    if (!ids.has(entry.id)) continue;
    try {
      pages.push(await loadDeckPage(project, entry));
    } catch {
      // no baseline for it: compare() reports the page as changed
    }
  }
  return pages;
};

const compare = (
  previous: readonly PageEntry[],
  split: DeckSplit,
  baselines: Readonly<Record<string, readonly string[] | null>>,
): Diff => {
  const known = new Set(previous.map((page) => page.id));
  const kept = new Set(split.pages.map((page) => page.id));
  const edited = (page: DeckSplitPage, index: number): boolean =>
    !baselines[page.id]?.includes(split.signatures[index] ?? '');
  return {
    changed: split.pages.filter((page, index) => known.has(page.id) && edited(page, index)).map((page) => page.id),
    added: split.pages.filter((page) => !known.has(page.id)).map((page) => page.id),
    removed: previous.filter((page) => !kept.has(page.id)).map((page) => page.id),
  };
};

const nextEntries = (previous: readonly PageEntry[], pages: readonly DeckSplitPage[]): PageEntry[] => {
  const byId = new Map(previous.map((page) => [page.id, page]));
  return pages.map((page) => {
    const old = byId.get(page.id);
    if (old) return { ...old, name: page.name, width: page.width, height: page.height };
    return { id: page.id, name: page.name, htmlPath: `pages/${page.id}.html`, width: page.width, height: page.height, role: page.role };
  });
};

/** The page file for a slide: sanitized like an editor save, with the doctype the sanitizer drops put back. */
const pageFile = (page: DeckSplitPage): string => `<!doctype html>${sanitizeHtml(page.html)}`;

/** The render (PNG and receipt) of a page: with the page changed or gone, it shows something that no longer exists. */
const dropRender = async (project: Project, id: string): Promise<void> => {
  for (const name of [`${id}.png`, `${id}.render.json`]) await project.rt.fs.rm(project.rt.path.join(project.exportsDir, name));
};

const restore = async (project: Project, backups: ReadonlyMap<string, string | null>): Promise<void> => {
  for (const [path, text] of backups) {
    if (text === null) await project.rt.fs.rm(path);
    else await project.rt.fs.writeFile(path, text);
  }
};

/** Write the changed and added page files, then the manifest; a failure puts every file and the manifest back. */
const writeProject = async (
  project: Project,
  pages: readonly DeckSplitPage[],
  diff: Diff,
  entries: PageEntry[],
  reshaped: boolean,
): Promise<void> => {
  const { rt } = project;
  const old = structuredClone(project.manifest);
  const backups = new Map<string, string | null>();
  const touched = new Set([...diff.changed, ...diff.added]);
  try {
    for (const page of pages.filter((p) => touched.has(p.id))) {
      const path = project.abs(entries.find((entry) => entry.id === page.id)!.htmlPath);
      const before = await rt.fs.stat(path);
      backups.set(path, before?.isFile ? await rt.fs.readText(path) : null);
      await writeAtomic(rt, path, pageFile(page));
    }
    project.manifest.pages = entries;
    for (const id of [...diff.changed, ...diff.removed]) delete project.manifest.reviews[id];
    if (reshaped) delete project.manifest.seriesReview;
    project.manifest.revision = (project.manifest.revision ?? 0) + 1;
    await project.saveManifest();
  } catch (error) {
    project.manifest = old;
    await restore(project, backups);
    throw error;
  }
};

const unchanged = (previous: readonly PageEntry[], entries: readonly PageEntry[], diff: Diff): boolean =>
  !diff.changed.length && !diff.added.length && !diff.removed.length && JSON.stringify(previous) === JSON.stringify(entries);

/** The series review judges the sequence: any page edited, added or removed, or the order changed, makes it stale. */
const reshapes = (previous: readonly PageEntry[], entries: readonly PageEntry[], diff: Diff): boolean =>
  Boolean(diff.changed.length || diff.added.length || diff.removed.length) ||
  previous.map((page) => page.id).join('\0') !== entries.map((page) => page.id).join('\0');

/**
 * Bring the project at `dir` (relative to `rt.cwd`) in line with an editor document. Throws `ValueError` for a document
 * without a slide or with a bad page size, `ProjectError` for a directory that is not a project. A document that matches
 * the project writes nothing.
 */
export const importDeck = async (
  rt: Runtime,
  dir: string,
  html: string,
  options: ImportDeckOptions = {},
): Promise<ImportDeckResult> => {
  // No "slide" anywhere means no `.slide` element: say so without starting a browser.
  if (!/slide/i.test(html)) throw new ValueError(NO_SLIDE);
  const project = await Project.load(rt, dir);
  const previous = project.manifest.pages;
  const session = options.session ?? chromeSession(rt, project.root);
  const { split, baselines } = await session(async (engine) => {
    const known = previous.map((p) => ({ id: p.id, width: Number(p.width), height: Number(p.height), role: p.role }));
    const result = await engine.split(html, known, defaultSizeOf(project));
    checkSizes(result.pages);
    return { split: result, baselines: await engine.baseline(await comparable(project, result)) };
  });
  const diff = compare(previous, split, baselines);
  const entries = nextEntries(previous, split.pages);
  if (!unchanged(previous, entries, diff)) {
    await writeProject(project, split.pages, diff, entries, reshapes(previous, entries, diff));
    for (const id of [...diff.changed, ...diff.removed]) await dropRender(project, id);
    for (const page of previous.filter((entry) => diff.removed.includes(entry.id))) await rt.fs.rm(project.abs(page.htmlPath));
  }
  return { pages: split.pages.length, ...diff };
};
