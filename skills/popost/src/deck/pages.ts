/** The project's pages in the form the converter takes (`DeckPage`). */
import { ValueError } from '../core/errors';
import type { PageEntry, Project } from '../core/project';
import type { DeckPage } from './types';

/** One manifest page with its HTML read from the project. */
export const loadDeckPage = async (project: Project, entry: PageEntry): Promise<DeckPage> => {
  let html: string;
  try {
    html = await project.readPageHtml(entry.id);
  } catch {
    throw new ValueError(`page ${entry.id}: ${entry.htmlPath} is missing or unreadable`);
  }
  return {
    id: entry.id,
    name: entry.name,
    width: Number(entry.width),
    height: Number(entry.height),
    role: entry.role,
    htmlPath: entry.htmlPath,
    html,
  };
};

/** Every page of the manifest, in manifest order. */
export const loadDeckPages = async (project: Project): Promise<DeckPage[]> => {
  const pages: DeckPage[] = [];
  for (const entry of project.manifest.pages) pages.push(await loadDeckPage(project, entry));
  return pages;
};
