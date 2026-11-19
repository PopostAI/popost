/**
 * `popost page check` (and the check `render` runs first): what is wrong with the page HTML, found without a browser. Each
 * problem carries a short hint, so one call tells the agent what to fix instead of a series of `sed -n` / `tail` / `od`
 * inspections. Scripts and remote URLs come from the audit's `staticScan`; the canvas root and `data-layer-id`s from the
 * build check's `scanCanvas`.
 */
import { Parser } from 'htmlparser2';
import type { Project } from '../core/project';
import { isFile, isInside } from '../core/util';
import { installedFontLinks, withFontLinks } from '../fonts/project-fonts';
import { staticScan } from '../render/audit';
import { scanCanvas } from './build';

export interface PageProblem {
  page: string;
  code: string;
  message: string;
  fix: string;
}

type Found = Omit<PageProblem, 'page'>;

const REWRITE = 'rewrite the page whole with the write tool (keep its <head>) instead of patching it with sed';

/** A tag that lost its `<`: `/style>`, `link rel="stylesheet" href="…">`. */
const LOST_CLOSER = /^\/[a-z][a-z0-9-]*\s*>/i;
const LOST_OPENER = /^(?:link|meta|img|div|span|style|script|html|head|body|section|p)\s+[\w:-]+\s*=\s*["'][^"']*["'][^<]*>/i;

/** Attributes that name a file, and `url(...)` in CSS. */
const REF_ATTRIBUTES = ['src', 'href', 'poster', 'xlink:href'] as const;
const CSS_URL = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;
const NOT_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

interface Scan {
  /** Text outside `<style>` / `<script>`, one entry per line. */
  lines: string[];
  refs: { attribute: string; value: string }[];
}

/** One pass over the page: its text lines and every file it points to (attributes, `style=""` and `<style>` urls). */
const scanMarkup = (html: string): Scan => {
  const scan: Scan = { lines: [], refs: [] };
  const raw: string[] = [];
  const cssRefs = (css: string): void => {
    for (const match of css.matchAll(CSS_URL)) scan.refs.push({ attribute: 'url()', value: match[2]!.trim() });
  };
  const parser = new Parser({
    onopentag: (name, attribs) => {
      if (name === 'style' || name === 'script') raw.push(name);
      for (const attribute of REF_ATTRIBUTES) if (attribs[attribute]) scan.refs.push({ attribute, value: attribs[attribute]!.trim() });
      if (attribs.style) cssRefs(attribs.style);
    },
    onclosetag: (name) => {
      if (raw.at(-1) === name) raw.pop();
    },
    ontext: (text) => {
      if (raw.length) {
        if (raw.at(-1) === 'style') cssRefs(text);
        return;
      }
      scan.lines.push(...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    },
  });
  parser.write(html);
  parser.end();
  return scan;
};

const countOf = (html: string, pattern: RegExp): number => [...html.matchAll(pattern)].length;

const styleProblems = (html: string): Found[] => {
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  const opened = countOf(bare, /<style\b/gi);
  const closed = countOf(bare, /<\/style\s*>/gi);
  if (opened > closed)
    return [{ code: 'style-unclosed', message: `<style> is not closed (${opened} opened, ${closed} closed): the rest of the page is read as CSS`, fix: `add the missing </style>; ${REWRITE}` }];
  if (closed > opened)
    return [{ code: 'style-stray-close', message: `</style> without a <style> (${opened} opened, ${closed} closed)`, fix: `remove the stray </style> or restore the lost <style>; ${REWRITE}` }];
  return [];
};

const lostBracketProblems = (lines: readonly string[]): Found[] =>
  lines
    .filter((line) => LOST_CLOSER.test(line) || LOST_OPENER.test(line))
    .slice(0, 5)
    .map((line) => ({
      code: 'lost-bracket',
      message: `text that looks like a tag that lost its "<": ${line.slice(0, 80)}`,
      fix: `put the "<" back; ${REWRITE}`,
    }));

const fontLinkProblems = (project: Project, html: string): Found[] => {
  const links = installedFontLinks(project, html);
  if (!links || withFontLinks(html, links) === html) return [];
  return [
    {
      code: 'font-links',
      message: `the page lacks the links to the installed fonts, or has stale ones (expected ${links})`,
      fix: 'do nothing by hand: popost render and popost font install put them back; never write these tags yourself',
    },
  ];
};

const missingFileProblems = async (project: Project, refs: Scan['refs']): Promise<Found[]> => {
  const { rt } = project;
  const found: Found[] = [];
  const seen = new Set<string>();
  for (const { attribute, value } of refs) {
    if (!value || NOT_LOCAL.test(value) || seen.has(value)) continue;
    seen.add(value);
    let local = value.replace(/[?#].*$/, '');
    try {
      local = decodeURIComponent(local);
    } catch {
      // not percent-encoded: use as written
    }
    const target = rt.path.resolve(project.pagesDir, local);
    if (isInside(rt, project.root, target) && (await isFile(rt, target))) continue;
    found.push({
      code: 'missing-file',
      message: `${attribute} "${value}" points to a file that is not in the project`,
      fix: 'put the file there (assets/ for pictures) or correct the path: paths are relative to pages/, e.g. ../assets/x.jpg',
    });
  }
  return found;
};

const staticProblems = (html: string): Found[] => {
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const { code, evidence } of staticScan(html)) {
    const key = `${code}:${String(evidence)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(
      code === 'script-present'
        ? { code, message: 'the page has a <script>', fix: 'remove it: pages are static HTML and CSS' }
        : { code, message: `remote reference ${String(evidence)} (pages render offline)`, fix: 'use a file in the project (assets/, fonts/) instead of a URL' },
    );
  }
  return found;
};

const canvasProblems = (html: string): Found[] => {
  const { found, layers } = scanCanvas(html);
  const problems: Found[] = [];
  if (!found)
    problems.push({ code: 'no-canvas-root', message: 'the page has no .post or .page root element', fix: 'wrap the page in one <div class="page"> of the page size' });
  const counts = new Map<string, number>();
  for (const id of layers) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts)
    if (count > 1)
      problems.push({ code: 'duplicate-layer-id', message: `data-layer-id "${id}" is used ${count} times`, fix: 'give every movable unit its own data-layer-id' });
  return problems;
};

/** The problems of one page's HTML. */
export const pageProblems = async (project: Project, html: string): Promise<Found[]> => {
  const scan = scanMarkup(html);
  return [
    ...styleProblems(html),
    ...lostBracketProblems(scan.lines),
    ...fontLinkProblems(project, html),
    ...(await missingFileProblems(project, scan.refs)),
    ...staticProblems(html),
    ...canvasProblems(html),
  ];
};

/** The problems of `pids`, in page order; an unreadable page is a problem too. */
export const checkPages = async (project: Project, pids: readonly string[]): Promise<PageProblem[]> => {
  const problems: PageProblem[] = [];
  for (const page of pids) {
    let found: Found[];
    try {
      found = await pageProblems(project, await project.readPageHtml(page));
    } catch (error) {
      if (error instanceof Error && error.name === 'ProjectError') throw error;
      found = [{ code: 'page-unreadable', message: `pages/${page}.html cannot be read`, fix: 'write the page file with the write tool' }];
    }
    problems.push(...found.map((problem) => ({ page, ...problem })));
  }
  return problems;
};
