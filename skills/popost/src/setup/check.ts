/**
 * What `setup` checks against the disk before it changes anything: the project directory, the files the spec names, the
 * page ids it uses, the font roles and the plan. Every problem is collected, so the caller fixes them all in one go.
 */
import { ImageError, sniffImage } from '../core/image';
import { MANIFEST_NAME, Project } from '../core/project';
import { errorText, isDir, isFile } from '../core/util';
import { fileErrorText } from '../core/error-text';
import { loadLibrary } from '../fonts/palette';
import { REF_ALL, REF_ROLES, registeredReferences } from '../images/references';
import { normalizePrompt } from '../providers/cli-config';
import type { Runtime } from '../runtime';
import * as seriesPlan from '../workflow/series-plan';
import { msg } from '../i18n';
import { fromSpec, locateRef, pagePlan, type SetupContext } from './context';
import type { ImageEntry, ReferenceEntry } from './spec';

type Report = (where: string, message: string) => void;
type Check = Pick<SetupContext, 'rt' | 'spec' | 'dir' | 'specDir' | 'project'>;

export interface OpenedProject {
  readonly project: Project | null;
  /** Why the directory cannot be used as it is. */
  readonly problem?: string;
}

/** The project in `dir`, `null` when there is none yet; a directory that is neither a project nor empty cannot be initialised. */
export const openProject = async (rt: Runtime, dir: string): Promise<OpenedProject> => {
  const root = rt.path.resolve(rt.cwd, dir);
  if (await isFile(rt, rt.path.join(root, MANIFEST_NAME))) {
    try {
      return { project: await Project.load(rt, dir) };
    } catch (error) {
      return {
        project: null,
        problem: msg(
          `${dir} holds a project that cannot be loaded (${errorText(error)})`,
          `${dir} 里的项目无法加载（${errorText(error)}）`,
        ),
      };
    }
  }
  if ((await rt.fs.stat(root)) && !(await isDir(rt, root))) return { project: null, problem: msg(`${dir} is a file, not a directory`, `${dir} 是文件，不是目录`) };
  if ((await isDir(rt, root)) && (await rt.fs.readdir(root)).length)
    return {
      project: null,
      problem: msg(
        `${dir} is not empty and is not a popost project; use a new directory (the spec file must not be inside the new project directory)`,
        `${dir} 不是空目录，也不是 popost 项目；请换一个新目录（spec 文件不能放在新项目目录里）`,
      ),
    };
  return { project: null };
};

/** The bytes of a file that must exist next to the spec, or the reason it cannot be used. */
const readNextToSpec = async (ctx: Check, file: string): Promise<{ bytes: Uint8Array } | { problem: string }> => {
  const stat = await ctx.rt.fs.stat(fromSpec(ctx, file));
  if (!stat) return { problem: fileErrorText('ENOENT', file) ?? file };
  if (stat.isDirectory) return { problem: msg(`${file} is a directory, not a file`, `${file} 是目录，不是文件`) };
  return { bytes: await ctx.rt.fs.readFile(fromSpec(ctx, file)) };
};

/** `null` when `bytes` is a PNG, JPEG, WebP or GIF; else what is wrong with it. */
const pictureProblem = (bytes: Uint8Array, file: string): string | null => {
  try {
    sniffImage(bytes, file);
    return null;
  } catch (error) {
    if (error instanceof ImageError) return error.message;
    throw error;
  }
};

const checkProject = (ctx: Check, opened: OpenedProject, report: Report): void => {
  const { spec } = ctx;
  if (opened.problem) report('dir', opened.problem);
  if (!ctx.project && !opened.problem && spec.brief === undefined) report('brief', msg('required: the project does not exist yet', '必填：项目还不存在'));
  if (ctx.project && spec.mode !== undefined && spec.mode !== ctx.project.manifest.mode)
    report(
      'mode',
      msg(
        `the project already exists as "${ctx.project.manifest.mode}" and its mode cannot change: remove "mode" or set it to "${ctx.project.manifest.mode}"`,
        `项目已存在，mode 为 "${ctx.project.manifest.mode}"，不能更改：删掉 "mode" 或设为 "${ctx.project.manifest.mode}"`,
      ),
    );
  if (!ctx.project && Array.isArray(spec.pages) && spec.pages[0] !== 'p1') report('pages', msg('a new project starts with page p1: begin the list with "p1"', '新项目从 p1 页开始：列表第一项要是 "p1"'));
  if (spec.quote === true && !spec.images.length) report('quote', msg('there are no images to quote', '没有可报价的图片'));
};

const checkReference = async (ctx: Check, entry: ReferenceEntry, report: Report): Promise<void> => {
  const where = `references[${entry.index}]`;
  const read = await readNextToSpec(ctx, entry.file);
  if ('problem' in read) report(`${where}.file`, read.problem);
  else {
    const problem = pictureProblem(read.bytes, entry.file);
    if (problem) report(`${where}.file`, problem);
  }
  const { final } = pagePlan(ctx);
  if (entry.page !== undefined && !final.includes(entry.page)) report(
      `${where}.page`,
      msg(
        `"${entry.page}" is not a page of this project (pages: ${final.join(', ')})`,
        `"${entry.page}" 不是本项目的页（现有页：${final.join(', ')}）`,
      ),
    );
};

const checkFonts = async (ctx: Check, report: Report): Promise<void> => {
  if (!ctx.spec.fonts.length) return;
  try {
    const known = (await loadLibrary(ctx.rt)).palette.roles.map((role) => role.id);
    const unknown = ctx.spec.fonts.filter((role) => !known.includes(role));
    if (unknown.length) report(
        'fonts',
        msg(
          `unknown font roles: ${unknown.join(', ')} (popost font list shows the available ones)`,
          `未知的字体角色：${unknown.join(', ')}（popost font list 可查看可用角色）`,
        ),
      );
  } catch (error) {
    report('fonts', errorText(error));
  }
};

const readPlan = async (ctx: Check, file: string): Promise<{ plan: unknown } | { problem: string }> => {
  const read = await readNextToSpec(ctx, file);
  if ('problem' in read) return read;
  try {
    return { plan: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { problem: msg(`${file} is not valid JSON (${detail})`, `${file} 不是合法的 JSON（${detail}）`) };
  }
};

const checkPlan = async (ctx: Check, report: Report): Promise<void> => {
  if (ctx.spec.plan === undefined) return;
  const read = await readPlan(ctx, ctx.spec.plan);
  if ('problem' in read) return report('plan', read.problem);
  const { final } = pagePlan(ctx);
  const orderHint = msg(
    ` (the project will have: ${final.join(', ')}; set "pages" to match the plan)`,
    `（项目将有的页：${final.join(', ')}；请把 "pages" 设成与 plan 一致）`,
  );
  for (const message of seriesPlan.validate(read.plan, final, orderHint)) report('plan', message);
};

/** The roles of the references the project has or the spec registers. */
const registeredRoles = (ctx: Check): Set<string> =>
  new Set([...(ctx.project ? registeredReferences(ctx.project).map((ref) => ref.role) : []), ...ctx.spec.references.map((ref) => ref.role)]);

/** Why a reference token such as `layout` or `all` finds nothing registered. */
const noReference = (token: string): string => {
  const kind = token === REF_ALL ? '' : `${token} `;
  const role = token === REF_ALL ? 'layout' : token;
  return msg(
    `"${token}": no ${kind}reference is registered; add one under "references" (role "${role}") or give a picture path`,
    `"${token}"：还没有登记 ${kind}参考图；在 "references" 下添加一张（role "${role}"），或直接给图片路径`,
  );
};

const checkRefToken = async (ctx: Check, token: string, where: string, report: Report): Promise<void> => {
  if (token === REF_ALL || (REF_ROLES as readonly string[]).includes(token)) {
    const roles = registeredRoles(ctx);
    const have = token === REF_ALL ? roles.size > 0 : roles.has(token);
    if (!have) report(where, noReference(token));
    return;
  }
  const found = await locateRef(ctx, token);
  if (found === null) return report(where, msg(`picture not found: ${token}`, `找不到图片：${token}`));
  const problem = pictureProblem(await ctx.rt.fs.readFile(found), token);
  if (problem) report(where, problem);
};

/** Two jobs with the same prompt, ratio and references would get one quote between them. */
const twinKey = (prompt: string, entry: ImageEntry): string => JSON.stringify([normalizePrompt(prompt), entry.aspect ?? null, entry.ref]);

const checkImage = async (ctx: Check, entry: ImageEntry, seen: Map<string, string>, report: Report): Promise<void> => {
  const where = `images[${entry.index}]`;
  const read = await readNextToSpec(ctx, entry.promptFile);
  if ('problem' in read) report(`${where}.promptFile`, read.problem);
  else {
    const key = twinKey(new TextDecoder().decode(read.bytes), entry);
    const twin = seen.get(key);
    if (twin)
      report(
        where,
        msg(
          `"${entry.id}" asks for the same picture as "${twin}" (same prompt, aspect and references): keep one, or change the prompt of the other`,
          `"${entry.id}" 与 "${twin}" 要的是同一张图（prompt、比例和参考图都相同）：保留一个，或改掉另一个的 prompt`,
        ),
      );
    seen.set(key, entry.id);
  }
  for (const token of entry.ref) await checkRefToken(ctx, token, `${where}.ref`, report);
  const mode = ctx.project?.manifest.mode ?? ctx.spec.mode ?? 'original';
  if (entry.purpose === 'composition' && mode === 'strict') report(
      `${where}.purpose`,
      msg(
        'a strict (reproduction) project has no composition job: it uses the supplied references',
        'strict（复刻）项目没有 composition 任务：它直接使用提供的参考图',
      ),
    );
};

/** Every problem of the spec that shows only against the disk, in the order of the spec. */
export const checkSpec = async (ctx: Check, opened: OpenedProject): Promise<string[]> => {
  const problems: string[] = [];
  const report: Report = (where, message) => void problems.push(`${where}: ${message}`);
  checkProject(ctx, opened, report);
  for (const entry of ctx.spec.references) await checkReference(ctx, entry, report);
  await checkFonts(ctx, report);
  await checkPlan(ctx, report);
  const seen = new Map<string, string>();
  for (const entry of ctx.spec.images) await checkImage(ctx, entry, seen, report);
  return problems;
};
