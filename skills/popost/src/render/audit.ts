/**
 * Machine audit of standalone HTML files (port of `render_html.py`): every canvas root (`.post`, else `.page`) of every
 * file is measured, screenshotted at `scale`, and promoted to `<out>/pages/<id>.png` (+ `.sha256`, + a small
 * `preview/<id>@w<N>.png`) only when the audit finds no error. `report.json` records what was found. An accepted page
 * means "no machine error", never that a person reviewed it. Pages render offline (`offline.ts`); unlike the Python tool
 * there is no switch to allow external requests.
 */
import type { Browser, Page } from 'playwright-core';
import { sniffImage } from '../core/image';
import { isInside, isoNow, relPosix, sha256, writeAtomic, writeJson } from '../core/util';
import type { Runtime } from '../runtime';
import { AUDIT_SCRIPT } from './audit-script';
import { callInPage, loadPage, openOfflineContext, withBrowser } from './offline';

export interface AuditIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  evidence?: unknown;
}

export interface AuditPage {
  id: string;
  sourceHtml: string;
  status: 'accepted' | 'failed';
  issues: AuditIssue[];
  facts: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}

export interface AuditOptions {
  /** Output directory (`pages/`, `preview/`, `report.json`). */
  readonly outDir: string;
  /** Declared canvas size; when set, a root that differs by more than 2px is an error. */
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
  readonly selector?: string;
  readonly previewWidth?: number;
  /** The directory pages may read from (images, CSS, fonts next to them). Default: the file's own directory. */
  readonly root?: string;
}

export interface AuditReport {
  schemaVersion: 'render-audit.v1';
  acceptanceScope: 'render-audit-only';
  renderOnlyNote: string;
  generatedAt: string;
  summary: {
    total: number;
    pageCount: number;
    accepted: number;
    failed: number;
    issuesByCode: Record<string, number>;
    acceptedMeaning: string;
  };
  reviews: never[];
  pages: AuditPage[];
}

interface AuditOutcome {
  readonly page: AuditPage;
  readonly png?: Uint8Array;
  readonly previewJob?: { index: number; width: number };
}

const issue = (code: string, message: string, evidence?: unknown, severity: 'error' | 'warning' = 'error'): AuditIssue => ({
  code,
  severity,
  message,
  ...(evidence === undefined ? {} : { evidence }),
});

/** Source-level rules that need no browser: no scripts, and external references are reported. */
export const staticScan = (html: string): AuditIssue[] => {
  const issues: AuditIssue[] = [];
  const low = html.toLowerCase();
  if (low.includes('<script'))
    issues.push(issue('script-present', '检测到 <script>：静态 HTML 产物不应依赖脚本', 'static scan'));
  for (const match of low.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/g))
    issues.push(issue('external-ref', '静态外链引用（默认断网将被拦截）', match[1]!.slice(0, 120), 'warning'));
  for (const _ of low.matchAll(/url\(\s*["']?https?:\/\//g))
    issues.push(issue('external-ref', 'CSS url() 外链（默认断网将被拦截）', 'css url()', 'warning'));
  return issues;
};

/** Files named explicitly plus the `*.html` files of `htmlDir`, absolute and unique, in that order. */
export const collectHtml = async (rt: Runtime, files: readonly string[], htmlDir?: string): Promise<string[]> => {
  const all = files.map((file) => rt.path.resolve(rt.cwd, file));
  if (htmlDir) {
    const dir = rt.path.resolve(rt.cwd, htmlDir);
    all.push(...(await rt.fs.readdir(dir)).filter((name) => name.endsWith('.html')).map((name) => rt.path.join(dir, name)));
  }
  return [...new Set(all)];
};

const failed = (id: string, file: string, issues: AuditIssue[]): AuditPage => ({
  id,
  sourceHtml: file,
  status: 'failed',
  issues,
  facts: {},
  artifacts: {},
});

const errorOf = (error: unknown): AuditIssue =>
  issue(
    'render-exception',
    `渲染异常: ${error instanceof Error ? error.name : 'Error'}`,
    String(error instanceof Error ? error.message : error).slice(0, 300),
  );

interface AuditData {
  rootFound: boolean;
  rootRect?: { width: number; height: number };
  rootSelector?: string;
  issues: AuditIssue[];
  facts: Record<string, unknown>;
}

/** Audit and (when clean) screenshot canvas root number `index`; `usedIds` makes page ids unique across files. */
const auditRoot = async (
  page: Page,
  ctx: { file: string; stem: string; count: number; selector: string; options: AuditOptions },
  index: number,
  first: { blocked: string[]; staticIssues: AuditIssue[] },
  usedIds: Set<string>,
): Promise<AuditOutcome> => {
  const { stem, count, selector, options, file } = ctx;
  const audit = await callInPage<AuditData>(page, AUDIT_SCRIPT, { selector, index, fallback: '.page' });
  const res = failed(count === 1 ? stem : `${stem}#${index}`, file, [...(audit.issues ?? [])]);
  res.facts = { ...audit.facts };
  if (index === 0) {
    res.issues.push(...first.staticIssues);
    if (first.blocked.length) {
      res.facts.blockedExternal = [...first.blocked];
      for (const url of first.blocked)
        res.issues.push(issue('external-request', '外部请求被断网策略拦截', url.slice(0, 120)));
    }
  }
  const lw = Math.round(audit.rootRect?.width ?? 0);
  const lh = Math.round(audit.rootRect?.height ?? 0);
  const rootSelector = audit.rootSelector ?? selector;
  Object.assign(res.facts, {
    rootSelector,
    rootCount: count,
    declaredSize: options.width ? [options.width, options.height] : null,
    logicalSize: { width: lw, height: lh },
  });
  if (options.width && options.height && (Math.abs(lw - options.width) > 2 || Math.abs(lh - options.height) > 2))
    res.issues.push(
      issue('size-mismatch', '根尺寸与声明画幅偏差>2px', { declared: [options.width, options.height], actual: [lw, lh] }),
    );
  res.id = uniqueId(res, usedIds);
  if (res.issues.some((x) => x.severity === 'error')) return { page: res };
  const png = await page.locator(rootSelector).nth(index).screenshot({ scale: 'device', type: 'png' });
  res.status = 'accepted';
  return { page: res, png, previewJob: { index, width: lw } };
};

const uniqueId = (res: AuditPage, used: Set<string>): string => {
  const base = res.id;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let k = 2;
  while (used.has(`${base}__${k}`)) k++;
  const id = `${base}__${k}`;
  used.add(id);
  res.issues.push(issue('page-id-collision', '页 id 重复（跨文件 basename 冲突），已拒绝并改名隔离', base));
  return id;
};

/** Render every canvas root of one file; a crash becomes a `render-exception` issue instead of aborting the run. */
const auditFile = async (
  rt: Runtime,
  browser: Browser,
  file: string,
  options: AuditOptions,
  usedIds: Set<string>,
): Promise<AuditOutcome[]> => {
  const stem = rt.path.basename(file, rt.path.extname(file));
  const root = rt.path.resolve(rt.cwd, options.root ?? rt.path.dirname(file));
  if (!isInside(rt, root, file)) return [{ page: failed(stem, file, [issue('render-exception', '文件不在可读目录内', file)]) }];
  const html = await rt.fs.readText(file);
  const { context, blocked } = await openOfflineContext(rt, browser, root, { scale: options.scale ?? 2 });
  const outcomes: AuditOutcome[] = [];
  try {
    const page = await context.newPage();
    await loadPage(page, relPosix(rt, root, file), options.width ?? 1200, options.height ?? 1600);
    const wanted = options.selector ?? '.post';
    const count = (s: string) => callInPage<number>(page, '(s) => document.querySelectorAll(s).length', s);
    const selector = (await count(wanted)) === 0 && wanted !== '.page' ? '.page' : wanted;
    const roots = await count(selector);
    if (roots === 0)
      return [
        { page: failed(stem, file, [issue('no-root-page', '未找到根元素 .post（回退 .page 也无）', `selector=${wanted}`)]) },
      ];
    const first = { blocked, staticIssues: staticScan(html) };
    for (let i = 0; i < roots; i++)
      outcomes.push(await auditRoot(page, { file, stem, count: roots, selector, options }, i, first, usedIds));
  } catch (error) {
    if (outcomes.length) outcomes[outcomes.length - 1]!.page.issues.push(errorOf(error));
    else outcomes.push({ page: failed(stem, file, [errorOf(error)]) });
  } finally {
    await context.close();
  }
  return outcomes;
};

/** A downscaled copy: the root is screenshotted again at the device scale that makes it `previewWidth` pixels wide. */
const capturePreview = async (
  rt: Runtime,
  browser: Browser,
  file: string,
  job: { index: number; width: number },
  options: AuditOptions,
  selector: string,
): Promise<Uint8Array> => {
  const root = rt.path.resolve(rt.cwd, options.root ?? rt.path.dirname(file));
  const scale = (options.previewWidth ?? 375) / Math.max(1, job.width);
  const { context } = await openOfflineContext(rt, browser, root, { scale });
  try {
    const page = await context.newPage();
    await loadPage(page, relPosix(rt, root, file), options.width ?? 1200, options.height ?? 1600);
    return await page.locator(selector).nth(job.index).screenshot({ scale: 'device', type: 'png' });
  } finally {
    await context.close();
  }
};

/** Write the PNG, its hash and its preview; a failure keeps any previous PNG and marks the page failed. */
const promote = async (rt: Runtime, browser: Browser, outcome: AuditOutcome, options: AuditOptions): Promise<void> => {
  const { page, png, previewJob } = outcome;
  if (page.status !== 'accepted' || !png) return;
  try {
    const outDir = rt.path.resolve(rt.cwd, options.outDir);
    const finalPath = rt.path.join(outDir, 'pages', `${page.id}.png`);
    await writeAtomic(rt, finalPath, png);
    const digest = sha256(png);
    await rt.fs.writeFile(`${finalPath}.sha256`, `${digest}  ${rt.path.basename(finalPath)}\n`);
    page.artifacts = { png: finalPath, sha256: digest };
    const info = sniffImage(png);
    page.facts.pixelSize = [info.width, info.height];
    const width = options.previewWidth ?? 375;
    const preview = await capturePreview(
      rt,
      browser,
      page.sourceHtml,
      previewJob!,
      options,
      String(page.facts.rootSelector),
    );
    const previewPath = rt.path.join(outDir, 'preview', `${page.id}@w${width}.png`);
    await rt.fs.writeFile(previewPath, preview);
    page.artifacts.preview = previewPath;
  } catch (error) {
    page.status = 'failed';
    page.issues.push(errorOf(error));
  }
};

const buildReport = (rt: Runtime, pages: AuditPage[]): AuditReport => {
  const failedCount = pages.filter((p) => p.status === 'failed').length;
  const issuesByCode: Record<string, number> = {};
  for (const p of pages) for (const i of p.issues) issuesByCode[i.code] = (issuesByCode[i.code] ?? 0) + 1;
  return {
    schemaVersion: 'render-audit.v1',
    // "accepted" is zero machine errors and a promoted PNG; strict replica / truth review is a person reading the PNG.
    acceptanceScope: 'render-audit-only',
    renderOnlyNote:
      'render accepted 仅表示零机器审计 error、PNG 已晋升；不等于 strict 复刻三层通过。replica/truth 层须真人读图并绑 pngHash。',
    generatedAt: isoNow(rt),
    summary: {
      total: pages.length,
      pageCount: pages.length,
      accepted: pages.length - failedCount,
      failed: failedCount,
      issuesByCode,
      acceptedMeaning: 'render-audit-only：零机器 error，非 strict 三层通过',
    },
    reviews: [],
    pages,
  };
};

/** Audit and render `files`; writes `report.json` and returns it. The caller turns `summary.failed` into an exit code. */
export const auditHtmlFiles = async (
  rt: Runtime,
  files: readonly string[],
  options: AuditOptions,
): Promise<AuditReport> => {
  if (!files.length) throw new Error('no HTML files given');
  const pages: AuditPage[] = [];
  await withBrowser(rt, async (browser) => {
    const usedIds = new Set<string>();
    for (const file of files) {
      for (const outcome of await auditFile(rt, browser, file, options, usedIds)) {
        await promote(rt, browser, outcome, options);
        pages.push(outcome.page);
      }
    }
  });
  const report = buildReport(rt, pages);
  await writeJson(rt, rt.path.join(rt.path.resolve(rt.cwd, options.outDir), 'report.json'), report);
  return report;
};
