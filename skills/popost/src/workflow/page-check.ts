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
import { msg } from '../i18n';
import { staticScan } from '../render/audit';
import { scanCanvas } from './build';

export interface PageProblem {
  page: string;
  code: string;
  message: string;
  fix: string;
}

type Found = Omit<PageProblem, 'page'>;

const rewrite = (): string =>
  msg(
    'rewrite the page whole with the write tool (keep its <head>) instead of patching it with sed',
    '用 write 工具整页重写（保留它的 <head>），不要用 sed 打补丁',
  );

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
    return [
      {
        code: 'style-unclosed',
        message: msg(
          `<style> is not closed (${opened} opened, ${closed} closed): the rest of the page is read as CSS`,
          `<style> 没有闭合（${opened} 个开始标签，${closed} 个结束标签）：页面剩余部分都会被当作 CSS`,
        ),
        fix: msg(`add the missing </style>; ${rewrite()}`, `补上缺少的 </style>；${rewrite()}`),
      },
    ];
  if (closed > opened)
    return [
      {
        code: 'style-stray-close',
        message: msg(`</style> without a <style> (${opened} opened, ${closed} closed)`, `</style> 没有对应的 <style>（${opened} 个开始标签，${closed} 个结束标签）`),
        fix: msg(`remove the stray </style> or restore the lost <style>; ${rewrite()}`, `删除多余的 </style>，或补回丢失的 <style>；${rewrite()}`),
      },
    ];
  return [];
};

const lostBracketProblems = (lines: readonly string[]): Found[] =>
  lines
    .filter((line) => LOST_CLOSER.test(line) || LOST_OPENER.test(line))
    .slice(0, 5)
    .map((line) => ({
      code: 'lost-bracket',
      message: msg(`text that looks like a tag that lost its "<": ${line.slice(0, 80)}`, `有一段文字像是丢了 "<" 的标签：${line.slice(0, 80)}`),
      fix: msg(`put the "<" back; ${rewrite()}`, `把 "<" 补回去；${rewrite()}`),
    }));

const fontLinkProblems = (project: Project, html: string): Found[] => {
  const links = installedFontLinks(project, html);
  if (!links || withFontLinks(html, links) === html) return [];
  return [
    {
      code: 'font-links',
      message: msg(
        `the page lacks the links to the installed fonts, or has stale ones (expected ${links})`,
        `页面缺少已安装字体的链接，或链接已过期（应为 ${links}）`,
      ),
      fix: msg(
        'do nothing by hand: popost render and popost font install put them back; never write these tags yourself',
        '不要手动处理：popost render 和 popost font install 会把它们补回；不要自己写这些标签',
      ),
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
      message: msg(`${attribute} "${value}" points to a file that is not in the project`, `${attribute} "${value}" 指向的文件不在工程里`),
      fix: msg(
        'put the file there (assets/ for pictures) or correct the path: paths are relative to pages/, e.g. ../assets/x.jpg',
        '把文件放到那里（图片放 assets/），或改正路径：路径相对于 pages/，例如 ../assets/x.jpg',
      ),
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
        ? { code, message: msg('the page has a <script>', '页面里有 <script>'), fix: msg('remove it: pages are static HTML and CSS', '删掉它：页面只能是静态的 HTML 和 CSS') }
        : {
            code,
            message: msg(`remote reference ${String(evidence)} (pages render offline)`, `远程引用 ${String(evidence)}（页面是离线渲染的）`),
            fix: msg('use a file in the project (assets/, fonts/) instead of a URL', '改用工程里的文件（assets/、fonts/），不要用网址'),
          },
    );
  }
  return found;
};

const canvasProblems = (html: string): Found[] => {
  const { found, layers } = scanCanvas(html);
  const problems: Found[] = [];
  if (!found)
    problems.push({
      code: 'no-canvas-root',
      message: msg('the page has no .post or .page root element', '页面没有 .post 或 .page 根元素'),
      fix: msg('wrap the page in one <div class="page"> of the page size', '用一个页面尺寸的 <div class="page"> 包住整页'),
    });
  const counts = new Map<string, number>();
  for (const id of layers) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts)
    if (count > 1)
      problems.push({
        code: 'duplicate-layer-id',
        message: msg(`data-layer-id "${id}" is used ${count} times`, `data-layer-id "${id}" 被用了 ${count} 次`),
        fix: msg('give every movable unit its own data-layer-id', '给每个可移动的单元各自的 data-layer-id'),
      });
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
      found = [
        {
          code: 'page-unreadable',
          message: msg(`pages/${page}.html cannot be read`, `无法读取 pages/${page}.html`),
          fix: msg('write the page file with the write tool', '用 write 工具写出这个页面文件'),
        },
      ];
    }
    problems.push(...found.map((problem) => ({ page, ...problem })));
  }
  return problems;
};
