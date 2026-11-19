/**
 * What `setup` checks against the disk before it changes anything: the project directory, the files the spec names, the
 * page ids it uses, the font roles and the plan. Every problem is collected, so the caller fixes them all in one go.
 */
import { ImageError, sniffImage } from '../core/image';
import { MANIFEST_NAME, Project } from '../core/project';
import { isDir, isFile } from '../core/util';
import { loadLibrary } from '../fonts/palette';
import { REF_ALL, REF_ROLES, registeredReferences } from '../images/references';
import { normalizePrompt } from '../providers/cli-config';
import type { Runtime } from '../runtime';
import * as seriesPlan from '../workflow/series-plan';
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
      return { project: null, problem: `${dir} holds a project that cannot be loaded (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  if ((await rt.fs.stat(root)) && !(await isDir(rt, root))) return { project: null, problem: `${dir} is a file, not a directory` };
  if ((await isDir(rt, root)) && (await rt.fs.readdir(root)).length)
    return { project: null, problem: `${dir} is not empty and is not a popost project; use a new directory (the spec file must not be inside the new project directory)` };
  return { project: null };
};

/** The bytes of a file that must exist next to the spec, or the reason it cannot be used. */
const readNextToSpec = async (ctx: Check, file: string): Promise<{ bytes: Uint8Array } | { problem: string }> => {
  const stat = await ctx.rt.fs.stat(fromSpec(ctx, file));
  if (!stat) return { problem: `file not found: ${file}` };
  if (stat.isDirectory) return { problem: `${file} is a directory, not a file` };
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
  if (!ctx.project && !opened.problem && spec.brief === undefined) report('brief', 'required: the project does not exist yet');
  if (ctx.project && spec.mode !== undefined && spec.mode !== ctx.project.manifest.mode)
    report('mode', `the project already exists as "${ctx.project.manifest.mode}" and its mode cannot change: remove "mode" or set it to "${ctx.project.manifest.mode}"`);
  if (!ctx.project && Array.isArray(spec.pages) && spec.pages[0] !== 'p1') report('pages', 'a new project starts with page p1: begin the list with "p1"');
  if (spec.quote === true && !spec.images.length) report('quote', 'there are no images to quote');
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
  if (entry.page !== undefined && !final.includes(entry.page)) report(`${where}.page`, `"${entry.page}" is not a page of this project (pages: ${final.join(', ')})`);
};

const checkFonts = async (ctx: Check, report: Report): Promise<void> => {
  if (!ctx.spec.fonts.length) return;
  try {
    const known = (await loadLibrary(ctx.rt)).palette.roles.map((role) => role.id);
    const unknown = ctx.spec.fonts.filter((role) => !known.includes(role));
    if (unknown.length) report('fonts', `unknown font roles: ${unknown.join(', ')} (popost font list shows the available ones)`);
  } catch (error) {
    report('fonts', error instanceof Error ? error.message : String(error));
  }
};

const readPlan = async (ctx: Check, file: string): Promise<{ plan: unknown } | { problem: string }> => {
  const read = await readNextToSpec(ctx, file);
  if ('problem' in read) return read;
  try {
    return { plan: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch (error) {
    return { problem: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
};

const checkPlan = async (ctx: Check, report: Report): Promise<void> => {
  if (ctx.spec.plan === undefined) return;
  const read = await readPlan(ctx, ctx.spec.plan);
  if ('problem' in read) return report('plan', read.problem);
  const { final } = pagePlan(ctx);
  for (const message of seriesPlan.validate(read.plan, final)) {
    const differs = message.startsWith('plan page ids/order differ');
    report('plan', differs ? `${message} (the project will have: ${final.join(', ')}; set "pages" to match the plan)` : message);
  }
};

/** The roles of the references the project has or the spec registers. */
const registeredRoles = (ctx: Check): Set<string> =>
  new Set([...(ctx.project ? registeredReferences(ctx.project).map((ref) => ref.role) : []), ...ctx.spec.references.map((ref) => ref.role)]);

const checkRefToken = async (ctx: Check, token: string, where: string, report: Report): Promise<void> => {
  if (token === REF_ALL || (REF_ROLES as readonly string[]).includes(token)) {
    const roles = registeredRoles(ctx);
    const have = token === REF_ALL ? roles.size > 0 : roles.has(token);
    if (!have) report(where, `"${token}": no ${token === REF_ALL ? '' : `${token} `}reference is registered; add one under "references" (role "${token === REF_ALL ? 'layout' : token}") or give a picture path`);
    return;
  }
  const found = await locateRef(ctx, token);
  if (found === null) return report(where, `picture not found: ${token}`);
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
    if (twin) report(where, `"${entry.id}" asks for the same picture as "${twin}" (same prompt, aspect and references): keep one, or change the prompt of the other`);
    seen.set(key, entry.id);
  }
  for (const token of entry.ref) await checkRefToken(ctx, token, `${where}.ref`, report);
  const mode = ctx.project?.manifest.mode ?? ctx.spec.mode ?? 'original';
  if (entry.purpose === 'composition' && mode === 'strict') report(`${where}.purpose`, 'a strict (reproduction) project has no composition job: it uses the supplied references');
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
