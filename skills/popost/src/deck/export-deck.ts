/**
 * `popost deck export`: the project as ONE editor document, the form the popost.ai workbench stores a deck in (top-level
 * `.slide[data-popost-page]` elements). The conversion is the editor's own `compileProject`, run in Chromium (`engine.ts`).
 * Asset and font URLs come out as the editor leaves them: relative to the pages (`../assets/x.png`).
 */
import { ValueError } from '../core/errors';
import { Project } from '../core/project';
import { writeAtomic } from '../core/util';
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { chromeSession } from './engine';
import { loadDeckPages } from './pages';
import type { DeckSession } from './types';

export interface ExportDeckOptions {
  /** Where to write the document, relative to the working directory. Default `<project>/exports/deck.html`. */
  readonly out?: string;
  /** Replaces the Chromium-backed converter (tests). */
  readonly session?: DeckSession;
}

export interface ExportDeckResult {
  /** Absolute path of the written document. */
  readonly file: string;
  readonly pages: number;
  /** The document itself, so a host need not read the file back. */
  readonly html: string;
}

/**
 * Write the editor document of the project at `dir` (relative to `rt.cwd`). Throws `ValueError` for a page the editor
 * cannot compile (no canvas root, an external resource, a stylesheet that is not in the project) and `ProjectError` for a
 * directory that is not a project.
 */
export const exportDeck = async (rt: Runtime, dir: string, options: ExportDeckOptions = {}): Promise<ExportDeckResult> => {
  const project = await Project.load(rt, dir);
  const pages = await loadDeckPages(project);
  if (!pages.length) throw new ValueError(msg('the project has no pages to export', '工程里没有可导出的页面'));
  const session = options.session ?? chromeSession(rt, project.root);
  const html = await session((engine) => engine.compile(pages));
  const file = options.out ? rt.path.resolve(rt.cwd, options.out) : rt.path.join(project.exportsDir, 'deck.html');
  await writeAtomic(rt, file, html);
  return { file, pages: pages.length, html };
};
