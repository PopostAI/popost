/**
 * The steps of `popost setup` that prepare a project: init, settings, pages, references, fonts, plan and image jobs. Each
 * one calls what the matching command calls, and each can run again: it leaves alone what is already as the spec says.
 * The quote step is in `quote.ts`.
 */
import { Project, initDesignNote } from '../core/project';
import { isDir, isFile, sha256 } from '../core/util';
import { cjkFontWarnings, installedFontLinks, installFonts, linkInstalledFonts, type FontLinkReport } from '../fonts/project-fonts';
import { jobFile, loadJob, type Job } from '../images/jobs';
import { draftJob, prepareJob, sameRequest, type PrepareCall } from '../images/prepare';
import { applySettings, settingsDiffer } from '../workflow/settings';
import * as seriesPlan from '../workflow/series-plan';
import { msg } from '../i18n';
import { fromSpec, locateRef, pagePlan, pageSize, type SetupContext } from './context';
import type { ImageEntry, ReferenceEntry } from './spec';

export interface StepResult {
  readonly status: 'done' | 'skipped';
  readonly detail: string;
  /** What was decided for the caller on the way (picture ratios, references), one line each. */
  readonly notes?: readonly string[];
  /** What the caller should reconsider but was not stopped for; `popost setup` lists them together. */
  readonly warnings?: readonly string[];
  /** The pages whose font links this step wrote (or could not), so the caller never has to guess. */
  readonly fontLinks?: FontLinkReport;
}

/** A step that stopped for a reason the caller can fix; `code` is the exit code (2 input, 1 refused). */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

const done = (
  detail: string,
  notes: readonly string[] = [],
  warnings: readonly string[] = [],
  fontLinks?: FontLinkReport,
): StepResult => ({
  status: 'done',
  detail,
  ...(notes.length ? { notes } : {}),
  ...(warnings.length ? { warnings } : {}),
  ...(fontLinks && (fontLinks.linked.length || fontLinks.failed) ? { fontLinks } : {}),
});
export const skipped = (detail: string): StepResult => ({ status: 'skipped', detail });

/** The project, which exists from the init step on. */
export const projectOf = (ctx: SetupContext): Project => {
  if (!ctx.project) throw new StepFailure(msg('there is no project yet: the init step did not run', '还没有项目：init 步骤没有运行'));
  return ctx.project;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const pageCount = (count: number): string => msg(plural(count, 'page'), `${count} 页`);

export const initStep = async (ctx: SetupContext): Promise<StepResult> => {
  if (ctx.project) {
    const { mode, pages } = ctx.project.manifest;
    return skipped(
      msg(
        `the project exists (${mode}, ${pageCount(pages.length)}) and is kept as it is`,
        `项目已存在（${mode}，${pageCount(pages.length)}），保持不变`,
      ),
    );
  }
  const { rt, spec } = ctx;
  if (spec.brief === undefined) throw new StepFailure(msg('brief is required to create the project', '创建项目需要 brief'));
  const mode = spec.mode ?? 'original';
  const project = await Project.create(rt, ctx.dir, spec.brief, mode, spec.width, spec.height);
  await project.appendDesignNote(initDesignNote());
  ctx.project = project;
  const first = project.manifest.pages[0]!;
  return done(
    msg(
      `created the project (${mode} mode) with page p1 (${first.width}x${first.height})`,
      `已创建项目（${mode} 模式），含页 p1（${first.width}x${first.height}）`,
    ),
  );
};

export const settingsStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const change = ctx.spec.settings ?? {};
  if (!settingsDiffer(project, change)) return skipped(msg('settings are already as the spec says', '设置已与 spec 一致'));
  await applySettings(project, change);
  const given = Object.entries(change).filter(([, value]) => value);
  return done(given.map(([key, value]) => `${key} ${String(value)}`).join(', '));
};

const pageName = (id: string): string => {
  const numbered = /^p(\d+)$/.exec(id);
  return numbered ? `Page ${numbered[1]}` : id;
};

export const pagesStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const { add, final } = pagePlan(ctx);
  if (!add.length) return skipped(msg(`pages are already there: ${final.join(', ')}`, `页面已存在：${final.join(', ')}`));
  const { width, height } = pageSize(ctx);
  for (const id of add) await project.addPage(id, pageName(id), width, height);
  // A page added to a project that has fonts installed gets their links, like the pages `font install` linked.
  const fontLinks = await linkInstalledFonts(project, add);
  await project.saveManifest();
  const detail = msg(
    `added ${add.join(', ')} (${width}x${height}); the project has ${pageCount(final.length)}`,
    `已添加 ${add.join(', ')}（${width}x${height}）；项目共 ${pageCount(final.length)}`,
  );
  return done(detail, [], [], fontLinks);
};

/** Registered already: a reference with this content, role and page. */
const isRegistered = (project: Project, digest: string, entry: ReferenceEntry): boolean =>
  project.manifest.sources.some(
    (source) => source.kind === 'local-reference' && source.sha256 === digest && source.role === entry.role && (source.pageId ?? null) === (entry.page ?? null),
  );

export const referencesStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const added: string[] = [];
  for (const entry of ctx.spec.references) {
    const file = fromSpec(ctx, entry.file);
    if (isRegistered(project, sha256(await ctx.rt.fs.readFile(file)), entry)) continue;
    await project.importReference(file, entry.role, entry.page ?? null);
    added.push(`${entry.file} (${entry.role}${entry.page ? `, ${entry.page}` : ''})`);
  }
  const kept = ctx.spec.references.length - added.length;
  if (!added.length) return skipped(msg(`${plural(kept, 'reference')} already registered`, `${kept} 张参考图已登记`));
  return done(
    msg(
      `registered ${added.join(', ')}${kept ? `; ${kept} already registered` : ''}`,
      `已登记 ${added.join(', ')}${kept ? `；${kept} 张此前已登记` : ''}`,
    ),
  );
};

/** Installed: recorded in the project and its files are there. */
const isInstalled = async (project: Project, role: string): Promise<boolean> =>
  project.manifest.fonts.some((font) => String(font.id) === role) && (await isDir(project.rt, project.abs(`fonts/${role}`)));

/** The links the CLI keeps in every page (a guessed `css/fonts.css` does not exist): the agent never writes them. */
const linksNote = (project: Project): string => {
  const links = installedFontLinks(project);
  if (!links) return '';
  return msg(
    `; every page links them with ${links} in its <head>: do not write these tags yourself, setup, font install and render keep them`,
    `；每一页都在 <head> 里用 ${links} 引用它们：不要自己写这些标签，setup、font install 和 render 会维护`,
  );
};

export const fontsStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const missing: string[] = [];
  for (const role of ctx.spec.fonts) if (!(await isInstalled(project, role))) missing.push(role);
  if (!missing.length)
    return skipped(
      msg(`font roles already installed: ${ctx.spec.fonts.join(', ')}`, `字体角色已安装：${ctx.spec.fonts.join(', ')}`) + linksNote(project),
    );
  const { result, fontLinks } = await installFonts(ctx.rt, project, missing.join(','), true);
  const { installed } = result;
  const kept = ctx.spec.fonts.length - missing.length;
  const detail =
    msg(
      `installed ${missing.join(', ')}${kept ? `; ${kept} already installed` : ''}`,
      `已安装 ${missing.join(', ')}${kept ? `；${kept} 个此前已安装` : ''}`,
    ) + linksNote(project);
  return done(detail, [], cjkFontWarnings(project, installed.map((role) => role.id)), fontLinks);
};

export const planStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const plan = JSON.parse(await ctx.rt.fs.readText(fromSpec(ctx, ctx.spec.plan!))) as { pages?: unknown[] };
  const attached = project.manifest.seriesPlan as { sha256?: string } | undefined;
  if (attached?.sha256 === seriesPlan.digest(plan) && (await isFile(ctx.rt, project.abs(seriesPlan.PLAN_FILE)))) return skipped(msg('this series plan is already attached', '这份 series plan 已附加'));
  await seriesPlan.save(project, plan);
  return done(msg(`attached the series plan (${pageCount(plan.pages?.length ?? 0)})`, `已附加 series plan（${pageCount(plan.pages?.length ?? 0)}）`));
};

// ---------- image jobs ----------

const prepareCall = async (ctx: SetupContext, entry: ImageEntry): Promise<PrepareCall> => {
  const refs: string[] = [];
  for (const token of entry.ref) refs.push((await locateRef(ctx, token)) ?? token);
  return { id: entry.id, promptFile: fromSpec(ctx, entry.promptFile), purpose: entry.purpose, refs, aspect: entry.aspect, config: ctx.config };
};

/** The job file of an earlier prepare, when there is a readable one. */
const existingJob = async (project: Project, path: string): Promise<Job | null> => {
  if (!(await isFile(project.rt, path))) return null;
  try {
    return await loadJob(project.rt, path);
  } catch {
    return null; // an unreadable job file is reported by prepare, in its own words
  }
};

interface Prepared {
  readonly unchanged: boolean;
  readonly notes: readonly string[];
}

/**
 * One image job. A job that asks for the same picture is left alone, whatever state it is in (a quoted job keeps its
 * quote, and a composition job whose picture is registered is not asked for again). A different request replaces a draft,
 * and for a job that was quoted or run `prepare` refuses in its own words.
 */
const prepareOne = async (project: Project, call: PrepareCall): Promise<Prepared> => {
  const composition = call.purpose === 'composition';
  const id = composition ? 'composition' : call.id;
  const path = jobFile(project, id);
  const earlier = await existingJob(project, path);
  if (earlier && sameRequest(project, earlier, (await draftJob(project, call, { id, path, composition })).job)) return { unchanged: true, notes: [] };
  const made = await prepareJob(project, call);
  return { unchanged: false, notes: made.notes };
};

export const imagesStep = async (ctx: SetupContext): Promise<StepResult> => {
  const project = projectOf(ctx);
  const prepared: string[] = [];
  const kept: string[] = [];
  const notes: string[] = [];
  for (const entry of ctx.spec.images) {
    const outcome = await prepareOne(project, await prepareCall(ctx, entry));
    (outcome.unchanged ? kept : prepared).push(entry.id);
    notes.push(...outcome.notes.map((note) => `${entry.id}: ${note}`));
  }
  if (!prepared.length) return skipped(msg(`image jobs already prepared as asked: ${kept.join(', ')}`, `图片任务已按要求准备好：${kept.join(', ')}`));
  const detail = msg(
    `prepared ${prepared.join(', ')}${kept.length ? `; unchanged: ${kept.join(', ')}` : ''}`,
    `已准备 ${prepared.join(', ')}${kept.length ? `；未变：${kept.join(', ')}` : ''}`,
  );
  return done(detail, notes);
};
