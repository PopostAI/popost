/**
 * Editable HTML project core (port of `project_core.py`). A project is a directory: `social-studio-project.json`
 * (schema v2, workflowVersion 3), one HTML file per page under `pages/` (the only layout authority), `assets/`,
 * `exports/`, `design.md`, and the production records the workflow commands add.
 */
import { msg } from '../i18n';
import type { Runtime } from '../runtime';
import { quoted } from './error-text';
import { OsError } from './errors';
import { sniffImage } from './image';
import { escapeHtml, isDir, isFile, isInside, isoNow, readJson, sha256, walkFiles, writeAtomic, writeJson } from './util';

export const SCHEMA = 'social-studio-project.v2';
export const MODES = ['original', 'strict'] as const;
export type Mode = (typeof MODES)[number];
export const MANIFEST_NAME = 'social-studio-project.json';
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_CANVAS = 16384;
/**
 * The heading under which design.md collects observations, and the prefix of the note `init` adds there. `build` reads
 * design.md by these two markers, so they are the same in every language.
 */
export const OBSERVATION_LOG = '## Observation log';
export const INIT_NOTE_PREFIX = 'init:';
/** The first line `init` adds to design.md: the file is a starter until the design phase rewrites it. */
export const initDesignNote = (): string =>
  `${INIT_NOTE_PREFIX} ${msg('the design.md draft comes from the brief (a starter, not finished; never treat it as final)', 'design.md 初稿来自 brief（starter，未完成，勿当 final）')}`;

export class ProjectError extends Error {
  override name = 'ProjectError';
}

export interface PageEntry {
  id: string;
  name: string;
  htmlPath: string;
  width: number;
  height: number;
  role?: string;
  [key: string]: unknown;
}

export interface AssetEntry {
  id: string;
  path: string;
  sha256: string;
  kind: string;
  [key: string]: unknown;
}

export interface Manifest {
  schema: string;
  version: number;
  mode: Mode;
  brief: string;
  designMd: string;
  pages: PageEntry[];
  assets: AssetEntry[];
  fonts: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  concept: Record<string, unknown> & { status: string; prompt: string | null; fixture: string | null };
  updatedAt: string | null;
  projectId: string;
  workflowVersion?: number;
  platform: string | null;
  language: string | null;
  provider: { channel: string; model: string | null; [key: string]: unknown };
  reviews: Record<string, unknown>;
  revision: number;
  seriesReview?: unknown;
  [key: string]: unknown;
}

const CONCEPT_STATUSES = ['pending', 'awaits_asset', 'reviewed', 'manual', 'done'];

const fallbackSkeleton = (pid: string, name: string, w: number, h: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: system-ui, sans-serif; }
.post { width:${w}px; height:${h}px; position:relative; overflow:hidden;
  background:#f5f6f8; color:#16181d; padding:80px; }
.title { font-size:72px; font-weight:800; line-height:1.12; }
.lede { margin-top:28px; font-size:34px; line-height:1.45; color:#555c66; }
</style></head>
<body><div class="post" data-canvas-width="${w}" data-canvas-height="${h}">
<h1 id="${pid}_title" data-layer-id="${pid}.title" class="title"><span data-slot>${escapeHtml(name)}</span></h1>
<p id="${pid}_lede" data-layer-id="${pid}.lede" class="lede">Edit this live text layer. No script, no external requests.</p>
</div></body></html>
`;

const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_CANVAS;

export class Project {
  readonly root: string;
  readonly manifestPath: string;
  readonly pagesDir: string;
  readonly assetsDir: string;
  readonly exportsDir: string;
  readonly designMd: string;
  manifest: Manifest;

  private constructor(
    readonly rt: Runtime,
    root: string,
    manifest: Manifest,
  ) {
    const p = rt.path;
    this.root = p.resolve(rt.cwd, root);
    this.manifestPath = p.join(this.root, MANIFEST_NAME);
    this.pagesDir = p.join(this.root, 'pages');
    this.assetsDir = p.join(this.root, 'assets');
    this.exportsDir = p.join(this.root, 'exports');
    this.designMd = p.join(this.root, 'design.md');
    this.manifest = manifest;
  }

  /** Absolute path of a project-relative path (manifest paths use forward slashes). */
  abs(rel: string): string {
    return this.rt.path.join(this.root, ...rel.split('/'));
  }

  static async create(rt: Runtime, root: string, brief: string, mode: Mode = 'original', width = 1080, height = 1350) {
    if (!MODES.includes(mode)) throw new ProjectError(msg(`mode must be ${MODES.join('/')}`, `mode 必须是 ${MODES.join('/')}`));
    const dir = rt.path.resolve(rt.cwd, root);
    if ((await isDir(rt, dir)) && (await rt.fs.readdir(dir)).length)
      throw new ProjectError(msg(`the folder is not empty, so init refuses it: ${root}`, `目录非空，拒绝 init: ${root}`));
    const project = new Project(rt, dir, {
      schema: SCHEMA,
      version: 1,
      mode,
      brief,
      designMd: 'design.md',
      pages: [],
      assets: [],
      fonts: [],
      sources: [],
      concept: { status: 'pending', prompt: null, fixture: null },
      updatedAt: null,
      projectId: rt.randomUUID(),
      workflowVersion: 3,
      platform: null,
      language: null,
      provider: { channel: 'official', model: null },
      reviews: {},
      revision: 0,
    });
    for (const d of [project.root, project.pagesDir, project.assetsDir, project.exportsDir]) await rt.fs.mkdir(d);
    await project.writeDesignMd(brief, mode);
    await project.addPage('p1', 'Page 1', width, height);
    await project.saveManifest();
    return project;
  }

  private async writeDesignMd(brief: string, mode: string) {
    const body = [
      '# Design Notes',
      '',
      `- mode: ${mode}`,
      '',
      '## Brief',
      brief,
      '',
      ...msg(
        [
          '## Initial design intent (written by init, to be revised in the design phase)',
          '- Audience: to do',
          '- Page rhythm: cover → body → close (to do)',
          '- Visual direction: to do (palette / type scale / white space)',
          '- Font roles: display / body / caption (pick them from the palette)',
          '- Constraints: no text burned into images, no external links, safe areas per platform',
        ].join('\n'),
        [
          '## 初始设计意图（init 生成，待设计阶段修订）',
          '- 受众：待补',
          '- 多页节奏：封面 → 主体 → 收尾（待补）',
          '- Visual direction：待补（色板/字阶/留白）',
          '- Font roles：display / body / caption（待 palette 选定）',
          '- Constraints：不烧字进图、无外链、安全区按平台',
        ].join('\n'),
      ).split('\n'),
      '',
      `${OBSERVATION_LOG} ${msg('(read PNG, append below)', '（读 PNG 后在下方追加）')}`,
      '',
    ];
    await writeAtomic(this.rt, this.designMd, body.join('\n'));
  }

  static async load(rt: Runtime, root: string): Promise<Project> {
    const dir = rt.path.resolve(rt.cwd, root);
    const manifestPath = rt.path.join(dir, MANIFEST_NAME);
    if (!(await isFile(rt, manifestPath)))
      throw new ProjectError(
        msg(
          `not a v2 project (no ${MANIFEST_NAME}): ${root}; --dir must point at a project folder made by popost setup / init`,
          `不是 v2 工程（缺 ${MANIFEST_NAME}）: ${root}；--dir 要指向 popost setup / init 建的工程目录`,
        ),
      );
    const manifest = await readJson<Manifest>(rt, manifestPath);
    if (manifest.schema !== SCHEMA) throw new ProjectError(msg(`schema must be ${SCHEMA}`, `schema 必须为 ${SCHEMA}`));
    if (!MODES.includes(manifest.mode)) throw new ProjectError(msg(`invalid mode: ${quoted(manifest.mode)}`, `mode 非法: ${quoted(manifest.mode)}`));
    for (const page of manifest.pages) {
      if (!SAFE_ID.test(page.id)) throw new ProjectError(msg(`invalid page id: ${quoted(page.id)}`, `页 id 非法: ${quoted(page.id)}`));
      if (!isInside(rt, dir, page.htmlPath)) throw new ProjectError(msg('page path outside project', '页面路径在工程目录之外'));
      if (!validSize(Number(page.width)) || !validSize(Number(page.height))) throw new ProjectError(msg('invalid canvas size', '画布尺寸非法'));
    }
    manifest.reviews ??= {};
    manifest.revision ??= 0;
    const project = new Project(rt, dir, manifest);
    await project.syncInstalledFonts();
    return project;
  }

  /** `font install` writes `fonts-manifest.json`; loading merges it into `manifest.fonts`. */
  private async syncInstalledFonts() {
    const path = this.rt.path.join(this.root, 'fonts-manifest.json');
    if (!(await isFile(this.rt, path))) return;
    try {
      const data = await readJson<Record<string, unknown>>(this.rt, path);
      const installed = (data.installed_roles ?? data.installed ?? []) as Record<string, unknown>[];
      const current = new Map(this.manifest.fonts.map((f) => [String(f.id), f]));
      for (const entry of installed)
        current.set(String(entry.id), {
          ...entry,
          cssFamily: entry.family,
          label: entry.label ?? entry.id,
        });
      this.manifest.fonts = [...current.values()];
    } catch {
      // a broken fonts-manifest.json leaves manifest.fonts as it was
    }
  }

  async saveManifest(): Promise<void> {
    this.manifest.updatedAt = isoNow(this.rt);
    await writeJson(this.rt, this.manifestPath, this.manifest);
  }

  // ---------- pages ----------
  private async skeletonHtml(pid: string, name: string, w: number, h: number): Promise<string> {
    const template = this.rt.path.join(this.rt.skillRoot, 'assets', 'project-starter', 'page.html');
    if (!(await isFile(this.rt, template))) return fallbackSkeleton(pid, name, w, h);
    return (await this.rt.fs.readText(template))
      .replaceAll('{{WIDTH}}', String(w))
      .replaceAll('{{HEIGHT}}', String(h))
      .replaceAll('{{ID}}', pid)
      .replaceAll('{{NAME}}', escapeHtml(name));
  }

  async addPage(pid: string, name: string, width = 1080, height = 1350): Promise<string> {
    if (!SAFE_ID.test(pid)) throw new ProjectError(msg(`a page id takes only letters, digits, _ and -: ${quoted(pid)}`, `页 id 只允许字母数字_-: ${quoted(pid)}`));
    if (this.manifest.pages.some((page) => page.id === pid)) throw new ProjectError(msg(`the page id already exists: ${pid}`, `页 id 已存在: ${pid}`));
    if (!validSize(width) || !validSize(height)) throw new ProjectError(msg('canvas size must be within 1..16384', '画布尺寸必须在 1..16384 之间'));
    const htmlPath = `pages/${pid}.html`;
    await writeAtomic(this.rt, this.abs(htmlPath), await this.skeletonHtml(pid, name, width, height));
    this.manifest.pages.push({ id: pid, name, htmlPath, width, height });
    await this.saveManifest();
    return pid;
  }

  page(pid: string): PageEntry {
    const page = this.manifest.pages.find((p) => p.id === pid);
    if (!page) throw new ProjectError(msg(`no such page: ${pid}`, `页不存在: ${pid}`));
    return page;
  }

  pageHtmlPath(pid: string): string {
    return this.abs(this.page(pid).htmlPath);
  }

  readPageHtml(pid: string): Promise<string> {
    return this.rt.fs.readText(this.pageHtmlPath(pid));
  }

  /** Writing different HTML drops the page's visual review and the series review: they no longer match. */
  async writePageHtml(pid: string, html: string): Promise<string> {
    const path = this.pageHtmlPath(pid);
    if (!(await isFile(this.rt, path)) || (await this.readPageHtml(pid)) !== html) {
      delete this.manifest.reviews[pid];
      delete this.manifest.seriesReview;
    }
    await writeAtomic(this.rt, path, html);
    return path;
  }

  // ---------- assets / fonts / sources ----------
  async addAssetBytes(data: Uint8Array, relName: string, kind = 'image'): Promise<AssetEntry> {
    const stem = relName.replace(/\.[^.]*$/, '');
    if (!SAFE_ID.test(stem)) throw new ProjectError(msg(`invalid asset name: ${quoted(relName)}`, `资产名非法: ${quoted(relName)}`));
    const path = `assets/${relName}`;
    await this.rt.fs.writeFile(this.abs(path), data);
    const entry: AssetEntry = { id: stem, path, sha256: sha256(data), kind };
    this.manifest.assets = [...this.manifest.assets.filter((a) => a.path !== path), entry];
    await this.saveManifest();
    return entry;
  }

  /** The Skill's font library (assets/fonts/palette.json) and what this project has installed. */
  async fonts(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      library: { available: false, roles: [] },
      installed: { files: [], css: null, chosen: [] },
    };
    let lib = this.rt.path.join(this.rt.skillRoot, 'assets', 'fonts', 'palette.json');
    if (!(await isFile(this.rt, lib))) lib = this.rt.path.join(this.assetsDir, 'fonts', 'palette.json');
    if (await isFile(this.rt, lib)) {
      try {
        const data = await readJson<Record<string, unknown>>(this.rt, lib);
        out.library = { available: true, roles: data.roles ?? data.fonts ?? [], path: lib };
      } catch (error) {
        out.library = { available: false, roles: [], note: String(error) };
      }
    }
    const fontDir = this.rt.path.join(this.root, 'fonts');
    if (await isDir(this.rt, fontDir)) {
      const files = (await walkFiles(this.rt, fontDir))
        .filter((f) => f.endsWith('.woff2'))
        .map((f) => this.rt.path.relative(this.root, f).split(this.rt.path.sep).join('/'))
        .sort();
      const css = this.rt.path.join(this.root, 'css', 'chosen.css');
      out.installed = {
        files,
        css: (await isFile(this.rt, css)) ? await this.rt.fs.readText(css) : null,
        chosen: [],
      };
    }
    return out;
  }

  async addSource(kind: string, note: string): Promise<void> {
    this.manifest.sources.push({ kind, note });
    await this.saveManifest();
  }

  // ---------- design / concept ----------
  async appendDesignNote(note: string): Promise<void> {
    const before = (await isFile(this.rt, this.designMd)) ? await this.rt.fs.readText(this.designMd) : '';
    await this.rt.fs.writeFile(this.designMd, `${before}- ${note}\n`);
  }

  async setConcept(status: string, prompt: string | null = null, fixture: string | null = null): Promise<void> {
    if (!CONCEPT_STATUSES.includes(status)) throw new ProjectError(msg(`invalid concept.status: ${quoted(status)}`, `concept.status 非法: ${quoted(status)}`));
    this.manifest.concept = { status, prompt, fixture };
    await this.saveManifest();
  }

  /** A file the user named, relative to the working directory; a missing one is an `OsError` naming it. */
  private async readReferenceFile(path: string): Promise<Uint8Array> {
    const full = this.rt.path.resolve(this.rt.cwd, path);
    const stat = await this.rt.fs.stat(full);
    if (!stat) throw new OsError('ENOENT', path);
    if (stat.isDirectory) throw new OsError('EISDIR', path);
    return this.rt.fs.readFile(full);
  }

  /** Copy a local reference image into `reference/`; the one composition contact sheet of a series is `concept`. */
  async importReference(path: string, role = 'layout', pageId: string | null = null, concept = false) {
    const data = await this.readReferenceFile(path);
    sniffImage(data, path);
    const digest = sha256(data);
    const extension = this.rt.path.extname(path).toLowerCase();
    const folder = this.rt.path.join(this.root, 'reference');
    await this.rt.fs.mkdir(folder);
    const name = (concept ? 'composition-reference' : digest.slice(0, 16)) + extension;
    if (concept && (await this.rt.fs.readdir(folder)).some((f) => f.startsWith('composition-reference.')))
      throw new ProjectError(
        msg('one composition contact sheet per series; reuse it instead of adding page concepts', '每组只有一张整组构图参考图；请复用它，不要再加单页构图'),
      );
    await this.rt.fs.writeFile(this.rt.path.join(folder, name), data);
    const entry = {
      kind: concept ? 'composition' : 'local-reference',
      path: `reference/${name}`,
      role,
      pageId,
      sha256: digest,
    };
    this.manifest.sources.push(entry);
    if (concept)
      Object.assign(this.manifest.concept, { status: 'reviewed', fixture: entry.path, imageCount: 1, sha256: digest });
    else if (this.manifest.mode === 'strict')
      Object.assign(this.manifest.concept, { status: 'reviewed', fixture: entry.path });
    await this.saveManifest();
    return entry;
  }
}
