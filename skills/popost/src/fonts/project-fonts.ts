/**
 * Fonts as a project sees them: `font install` (CLI) and `POST /api/font-install` (local editor) both put the chosen
 * roles into the project, record them in `manifest.fonts`, and - unless the caller keeps the pages untouched - link their
 * CSS from every page.
 */
import type { Project } from '../core/project';
import type { Runtime } from '../runtime';
import { installProject, type InstallResult, type InstalledRole } from './install';
import { msg } from '../i18n';

/** A previously injected font stylesheet link (self-closed or not). */
export const FONT_LINK = /<link rel="stylesheet" href="\.\.\/css\/[^"]*"\s*\/?>/g;

export const fontLinkTag = (cssPath: string): string => `<link rel="stylesheet" href="../${cssPath}">`;

/** The insertion point of the links in a page that has no `</head>`: just after an open `<head>`, before `<body`, ... */
const insertionPoint = (html: string): number => {
  const head = /<\/head\s*>/i.exec(html);
  if (head) return head.index;
  const open = /<head\b[^>]*>/i.exec(html);
  if (open) return open.index + open[0].length;
  const body = /<body\b/i.exec(html);
  if (body) return body.index;
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return root.index + root[0].length;
  // A fragment page (`<style>...</style><div class="page">`): before its first tag. Comments, doctype and closers are skipped.
  for (const tag of html.matchAll(/<!--[\s\S]*?-->|<(?![!?/])/g)) if (!tag[0].startsWith('<!--')) return tag.index;
  return 0;
};

/**
 * `html` with the font links replaced by `links`: before `</head>`; a page without it gets them after an open `<head>`,
 * before `<body`, or before its first tag (browsers hoist a `<link>` into the head). Links the page already had are replaced,
 * so a page that has exactly these links comes back identical.
 */
export const withFontLinks = (html: string, links: string): string => {
  const bare = html.replace(FONT_LINK, '');
  const at = insertionPoint(bare);
  return `${bare.slice(0, at)}${links}${bare.slice(at)}`;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the page declare `family` itself (an `@font-face` the editor embedded)? Then it needs no link for it. */
const embedsFamily = (html: string, family: string): boolean =>
  new RegExp(`@font-face\\s*\\{[^}]*font-family\\s*:\\s*['"]?${escapeRegExp(family)}(?:['";\\s}])`, 'i').test(html);

const fontEntry = (role: InstalledRole): Record<string, unknown> => ({ ...role, cssFamily: role.family });

/**
 * The `<link>` tags of every installed font, as a page has them; empty when the project has no fonts. With the page's
 * `html`, a font whose family the page embeds as `@font-face` is left out.
 */
export const installedFontLinks = (project: Project, html?: string): string =>
  project.manifest.fonts
    .filter((font) => typeof font.cssPath === 'string')
    .filter((font) => html === undefined || !font.cssFamily || !embedsFamily(html, String(font.cssFamily)))
    .map((font) => fontLinkTag(String(font.cssPath)))
    .join('');

/** What `linkInstalledFonts` did: the pages it changed and, defensively, the ones it could not read or write. */
export interface FontLinkReport {
  linked: string[];
  failed?: { page: string; reason: string }[];
}

/**
 * Every page (or just `only`) gets a link for every installed font, replacing the links it had. Returns the pages that
 * changed; a page that already has exactly these links is not written.
 */
export const linkInstalledFonts = async (project: Project, only?: readonly string[]): Promise<FontLinkReport> => {
  const report: FontLinkReport = { linked: [] };
  if (!installedFontLinks(project)) return report;
  for (const page of project.manifest.pages.filter((candidate) => !only || only.includes(candidate.id))) {
    try {
      const before = await project.readPageHtml(page.id);
      const after = withFontLinks(before, installedFontLinks(project, before));
      if (after === before) continue;
      await project.writePageHtml(page.id, after);
      report.linked.push(page.id);
    } catch (error) {
      (report.failed ??= []).push({ page: page.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
};

/** A language setting that names Chinese: `zh`, `zh-CN`, `zh_TW`, `en+zh`, `Chinese`, `中文`. */
const CHINESE_LANGUAGE = /(^|[^a-z])zh([^a-z]|$)|chinese|中文/i;

/**
 * A warning for each installed `cjk-*` role when the project's copy language is known and not Chinese: the export carries the
 * CSS a page links on every page, and the Chinese stylesheets are large. Only a warning, the roles are installed anyway; an
 * unknown language (nothing saved by `settings`) warns about nothing.
 */
export const cjkFontWarnings = (project: Project, roleIds: readonly string[]): string[] => {
  const language = project.manifest.language?.trim();
  if (!language || CHINESE_LANGUAGE.test(language)) return [];
  return roleIds
    .filter((id) => id.startsWith('cjk-'))
    .map(
      (id) =>
        msg(
          `${id} is a Chinese font role, but this project's copy language is ${language}: its stylesheet is large and the export repeats it on every page; install it only if the copy has Chinese text.`,
          `${id} 是中文字体角色，但本项目的文案语言是 ${language}：它的样式表很大，导出时每一页都会重复一份；只有文案含中文时才安装它。`,
        ),
    );
};

export interface FontInstall {
  result: InstallResult;
  fontLinks: FontLinkReport;
}

/**
 * Install `rolesCsv` into the project and save the manifest. With `injectLinks`, every page gets a link for every installed
 * font (`fontLinks` says which pages changed); the editor passes `false` so its unsaved canvas keeps its own font CSS.
 */
export const installFonts = async (
  rt: Runtime,
  project: Project,
  rolesCsv: string,
  injectLinks: boolean,
): Promise<FontInstall> => {
  const result = await installProject(rt, rolesCsv, project.root);
  const fonts = new Map(project.manifest.fonts.map((font) => [String(font.id), font]));
  for (const role of result.installed) fonts.set(role.id, fontEntry(role));
  project.manifest.fonts = [...fonts.values()];
  const fontLinks = injectLinks ? await linkInstalledFonts(project) : { linked: [] };
  await project.saveManifest();
  return { result, fontLinks };
};

/** `installFonts` for callers that only need what was installed. */
export const installFontsIntoProject = async (
  rt: Runtime,
  project: Project,
  rolesCsv: string,
  injectLinks: boolean,
): Promise<InstallResult> => (await installFonts(rt, project, rolesCsv, injectLinks)).result;
