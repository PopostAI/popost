/**
 * Saving the editor's pages into the project (port of `server.save_payload`): every page is validated and sanitized before
 * anything is written, the font stylesheets the page does not embed are linked, and a failed write rolls the project back.
 */
import { FONT_LINK, fontLinkTag } from '../fonts/project-fonts';
import { MODES, SAFE_ID, MAX_CANVAS, type PageEntry, type Project } from '../core/project';
import { isFile, sha256 } from '../core/util';
import { sanitizeHtml } from './sanitize';

/** A request the caller got wrong (HTTP 400); named like the Python `ValueError` it replaces. */
export class SaveError extends Error {
  override name = 'ValueError';
}

export interface SavedPage {
  id: string;
  sha256: string;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Python `int(x)`: integers and integer-like strings; anything else is a bad request. */
const toInt = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  throw new SaveError('invalid canvas size');
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Link the font CSS of every manifest font whose family the page does not already embed as `@font-face`. */
const withFontLinks = (html: string, fonts: readonly Raw[]): string => {
  let links = '';
  for (const font of fonts) {
    const family = escapeRegExp(String(font.cssFamily ?? ''));
    const embedded =
      family && new RegExp(`@font-face\\s*\\{[^}]*font-family\\s*:\\s*['"]?${family}(?:['";\\s}])`, 'i').test(html);
    if (font.cssPath && !embedded) links += fontLinkTag(String(font.cssPath));
  }
  if (!links) return html;
  const cleaned = html.replace(FONT_LINK, '');
  return cleaned.includes('</head>') ? cleaned.replace('</head>', () => `${links}</head>`) : cleaned + links;
};

interface Prepared {
  entry: PageEntry;
  html: string;
}

const prepare = (data: Raw, project: Project): Prepared[] => {
  if (!MODES.includes((data.mode ?? project.manifest.mode) as never)) throw new SaveError('invalid project mode');
  const pages = data.pages;
  if (!Array.isArray(pages) || !pages.length) throw new SaveError('project needs at least one page');
  const seen = new Set<string>();
  return pages.map((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.id !== 'string') throw new SaveError('invalid or duplicate page id');
    const id = raw.id;
    if (!SAFE_ID.test(id) || seen.has(id)) throw new SaveError('invalid or duplicate page id');
    seen.add(id);
    const width = toInt(raw.width, 1080);
    const height = toInt(raw.height, 1350);
    if (width < 1 || width > MAX_CANVAS || height < 1 || height > MAX_CANVAS) throw new SaveError('invalid canvas size');
    if (typeof raw.html !== 'string') throw new SaveError('page html must be a string');
    const html = withFontLinks(sanitizeHtml(raw.html), project.manifest.fonts);
    const entry = { id, name: String(raw.name ?? id), htmlPath: `pages/${id}.html`, width, height, role: String(raw.role ?? 'content') };
    return { entry, html };
  });
};

const restore = async (project: Project, backups: Map<string, string | null>): Promise<void> => {
  for (const [path, text] of backups) {
    if (text === null) await project.rt.fs.rm(path);
    else await project.rt.fs.writeFile(path, text);
  }
};

/** Validate and write all pages of `data` (`{pages: [{id, name?, width?, height?, role?, html}]}`). */
export const savePayload = async (project: Project, data: unknown): Promise<SavedPage[]> => {
  const body = isRecord(data) && isRecord(data.manifest) ? data.manifest : data;
  if (!isRecord(body)) throw new SaveError('project payload must be an object');
  const prepared = prepare(body, project);
  const { rt } = project;
  const old = structuredClone(project.manifest);
  const backups = new Map<string, string | null>();
  for (const { entry } of prepared) {
    const path = project.abs(entry.htmlPath);
    backups.set(path, (await isFile(rt, path)) ? await rt.fs.readText(path) : null);
  }
  try {
    project.manifest.pages = prepared.map((p) => p.entry);
    if (old.pages.map((p) => p.id).join('\0') !== prepared.map((p) => p.entry.id).join('\0'))
      delete project.manifest.seriesReview;
    for (const { entry, html } of prepared) await project.writePageHtml(entry.id, html);
    project.manifest.revision = (project.manifest.revision ?? 0) + 1;
    await project.saveManifest();
  } catch (error) {
    project.manifest = old;
    await restore(project, backups);
    await project.saveManifest();
    throw error;
  }
  return prepared.map(({ entry, html }) => ({ id: entry.id, sha256: sha256(html) }));
};
