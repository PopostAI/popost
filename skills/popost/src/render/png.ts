/**
 * Page PNGs (port of `server.render_pages_png` and friends). A PNG is a deliverable, so it is reused only while its
 * receipt (`<name>.render.json`: page fingerprint, PNG hash, renderer signature) still matches the page and the file;
 * changed pages share one browser; the screenshot is the page's `.post` (else `.page`) at scale 1 with fonts and images
 * ready, and the project is rendered offline (`offline.ts`).
 */
import { zipSync } from 'fflate';
import type { Browser } from 'playwright-core';
import { pageFingerprint, RENDER_SIGNATURE } from '../core/fingerprint';
import type { Project } from '../core/project';
import { isFile, readJson, sha256, writeAtomic, writeJson } from '../core/util';
import { hasBrokenImage, loadPage, openOfflineContext, withBrowser } from './offline';
import { msg } from '../i18n';

/** Python-style error names are kept: they are part of the `{"ok": false, "error": "Name: message"}` text agents see. */
export class RenderError extends Error {
  override name = 'RuntimeError';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `exports/p1.png` -> `exports/p1.render.json`, like `Path.with_suffix`. */
export const receiptPath = (project: Project, png: string): string => {
  const { path } = project.rt;
  return png.slice(0, png.length - path.extname(png).length) + '.render.json';
};

const u32 = (data: Uint8Array, offset: number): number =>
  ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;

interface Receipt {
  fingerprint?: unknown;
  pngHash?: unknown;
  renderer?: unknown;
}

/** The PNG at `outPath` (default `exports/<pid>.png`) when the receipt proves it is the current render, else `null`. */
export const cachedPng = async (project: Project, pid: string, outPath?: string): Promise<string | null> => {
  const { rt } = project;
  const png = outPath ?? rt.path.join(project.exportsDir, `${pid}.png`);
  try {
    const receipt = await readJson<Receipt>(rt, receiptPath(project, png));
    const data = await rt.fs.readFile(png);
    const page = project.page(pid);
    const current =
      PNG_SIGNATURE.every((byte, i) => data[i] === byte) &&
      u32(data, 16) === page.width &&
      u32(data, 20) === page.height &&
      receipt.fingerprint === (await pageFingerprint(project, pid)) &&
      receipt.pngHash === sha256(data) &&
      (receipt.renderer ?? RENDER_SIGNATURE) === RENDER_SIGNATURE;
    return current ? png : null;
  } catch (error) {
    if (error instanceof Error && error.name === 'ProjectError') throw error;
    return null;
  }
};

/** Screenshot of the page root; throws when the page is not renderable (no root, broken image). */
const screenshotRoot = async (project: Project, browser: Browser, pid: string): Promise<Uint8Array> => {
  const entry = project.page(pid);
  const { context } = await openOfflineContext(project.rt, browser, project.root, { scale: 1 });
  try {
    const page = await context.newPage();
    await loadPage(page, entry.htmlPath, entry.width, entry.height);
    if (await hasBrokenImage(page)) throw new RenderError(msg('page contains missing or unreadable images', '页面里有缺失或无法读取的图片'));
    const root = (await page.locator('.post').count()) ? page.locator('.post') : page.locator('.page');
    if (!(await root.count())) throw new RenderError(msg('page has no .post or .page root element', '页面没有 .post 或 .page 根元素'));
    return await root.first().screenshot({ scale: 'device', type: 'png' });
  } finally {
    await context.close();
  }
};

const renderOne = async (project: Project, browser: Browser, pid: string, out: string): Promise<void> => {
  const { rt } = project;
  const fingerprint = await pageFingerprint(project, pid);
  const png = await screenshotRoot(project, browser, pid);
  if ((await pageFingerprint(project, pid)) !== fingerprint)
    throw new RenderError(msg('project changed during render; retry current source', '渲染期间项目有改动；请按当前源文件重试'));
  await writeAtomic(rt, out, png);
  await writeJson(rt, receiptPath(project, out), { fingerprint, pngHash: sha256(png), renderer: RENDER_SIGNATURE });
};

/** What a render did: the PNG of each page, the pages screenshotted now and the ones served from their receipt. */
export interface RenderReport {
  paths: Record<string, string>;
  rendered: string[];
  unchanged: string[];
}

/**
 * PNG paths for `pids`, rendering only what has no current receipt (or all with `force`), all in one browser session.
 * `outPaths` maps a page id to an output file (absolute); everything else goes to `exports/<pid>.png`.
 */
export const renderPages = async (
  project: Project,
  pids: readonly string[],
  outPaths: Readonly<Record<string, string>> = {},
  force = false,
): Promise<RenderReport> => {
  const { rt } = project;
  const report: RenderReport = { paths: {}, rendered: [], unchanged: [] };
  const pending: { pid: string; out: string }[] = [];
  for (const pid of pids) {
    project.page(pid);
    const out = outPaths[pid] ?? rt.path.join(project.exportsDir, `${pid}.png`);
    const cached = force ? null : await cachedPng(project, pid, out);
    if (cached) {
      report.paths[pid] = cached;
      report.unchanged.push(pid);
    } else pending.push({ pid, out });
  }
  if (!pending.length) return report;
  await withBrowser(rt, async (browser) => {
    for (const { pid, out } of pending) {
      await renderOne(project, browser, pid, out);
      report.paths[pid] = out;
      report.rendered.push(pid);
    }
  });
  return report;
};

/** `renderPages`, as page id -> PNG path. */
export const renderPagesPng = async (
  project: Project,
  pids: readonly string[],
  outPaths: Readonly<Record<string, string>> = {},
  force = false,
): Promise<Record<string, string>> => (await renderPages(project, pids, outPaths, force)).paths;

export const renderPagePng = async (project: Project, pid: string, out?: string, force = false): Promise<string> => {
  const results = await renderPagesPng(project, [pid], out ? { [pid]: out } : {}, force);
  return results[pid]!;
};

/** Every page's PNG in one ZIP (`<pageId>.png`, manifest order); default `exports/all.zip`. */
export const exportAllReport = async (
  project: Project,
  outZip?: string,
  force = false,
): Promise<{ zip: string } & Omit<RenderReport, 'paths'>> => {
  const { rt } = project;
  const target = outZip ?? rt.path.join(project.exportsDir, 'all.zip');
  const pids = project.manifest.pages.map((page) => page.id);
  const { paths: images, rendered, unchanged } = await renderPages(project, pids, {}, force);
  const entries: Record<string, Uint8Array> = {};
  for (const pid of pids) {
    if (!(await isFile(rt, images[pid]!))) throw new RenderError(msg(`missing PNG for page ${pid}`, `页 ${pid} 缺少 PNG`));
    entries[`${pid}.png`] = await rt.fs.readFile(images[pid]!);
  }
  await rt.fs.writeFile(target, zipSync(entries, { level: 6, mtime: rt.now() }));
  return { zip: target, rendered, unchanged };
};

export const exportAll = async (project: Project, outZip?: string, force = false): Promise<string> =>
  (await exportAllReport(project, outZip, force)).zip;
