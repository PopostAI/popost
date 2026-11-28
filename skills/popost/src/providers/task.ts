/**
 * The popost.ai task of a project. Every Open API request made in a project's context (`rt.project`) carries three
 * headers, and the platform groups the charges of the project under one line of the user's account page
 * ("Task: <title>"), item by item (clips, image tasks, voice-over, transcription, music, link parsing):
 *
 * - `x-popost-task`: the task id, `^[A-Za-z0-9_-]{8,64}$`;
 * - `x-popost-task-title`: the title, URI-encoded UTF-8, at most 100 characters, without control characters;
 * - `x-popost-agent-session`: the agent's session, `CODEX_THREAD_ID` when it is set and fits `^[A-Za-z0-9_-]{1,100}$`.
 *
 * A value that does not fit is left out, never sent: a request never fails for its task. The id of an image project is
 * its manifest's `projectId` when it fits. Any other project keeps its id in `production/task.json`, made with a random
 * id the first time a request is sent in it; an id once there is never changed.
 *
 * The title: the `title` in production/task.json first (`popost usage --dir P --title …` sets it, nameTask), then for an
 * image project its title, name or brief (the title cloud save gives it), and else the folder's name. A video project
 * keeps the title of its first request in the file: what that command was about (ProjectContext.title: the
 * reference's file name, the first words of a brief or fill) or else the folder's name. It is read again for every
 * request, so a new title goes with the next one.
 */
import { MANIFEST_NAME } from '../core/project';
import { readJson, writeJson } from '../core/util';
import { msg } from '../i18n';
import type { ProjectContext, Runtime } from '../runtime';
import { isRecord, type JsonRecord } from './base';

export const TASK_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const AGENT_SESSION = /^[A-Za-z0-9_-]{1,100}$/;
export const TITLE_MAX = 100;
export const TASK_FILE = 'production/task.json';
/** What makes a folder a video project before it has a task: its project file, its materials, its voices, its agreed clips. */
export const VIDEO_MARKS = [TASK_FILE, 'production/approved-clips.json', 'video.json', 'materials.json', 'voices.json'];

export interface ProjectTask {
  readonly dir: string;
  readonly kind: 'image' | 'video';
  /** undefined: the project has no id yet (nothing was sent in it), or the one in its task file does not fit. */
  readonly id?: string;
  readonly title?: string;
}

const fits = (value: unknown): value is string => typeof value === 'string' && TASK_ID.test(value);

/** A title as the header carries it: control characters out, spaces collapsed, at most 100 characters of whole code points. */
export const cleanTitle = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > TITLE_MAX) break;
    out += ch;
  }
  return out.trim() || undefined;
};

/** The header value of a title: its URI encoding, undefined when it cannot be encoded (a broken surrogate). */
export const encodeTitle = (title: string): string | undefined => {
  try {
    return encodeURIComponent(title);
  } catch {
    return undefined;
  }
};

const at = (rt: Runtime, dir: string, rel: string): string => rt.path.join(dir, ...rel.split('/'));
const exists = async (rt: Runtime, file: string): Promise<boolean> => (await rt.fs.stat(file)) !== null;
const recordAt = async (rt: Runtime, file: string): Promise<JsonRecord | undefined> => {
  const data = await readJson(rt, file).catch(() => undefined);
  return isRecord(data) ? data : undefined;
};

const kindOf = async (rt: Runtime, dir: string, kind: ProjectContext['kind']): Promise<ProjectTask['kind'] | undefined> => {
  if (await exists(rt, rt.path.join(dir, MANIFEST_NAME))) return 'image';
  if (kind === 'video') return 'video';
  for (const mark of VIDEO_MARKS) if (await exists(rt, at(rt, dir, mark))) return 'video';
  return undefined;
};

/**
 * The task of the project in `ctx`; undefined when there is no project there. create: give it an id when it has none
 * (the first request sent in it); otherwise the task may come back without one.
 */
export const projectTask = async (rt: Runtime, ctx: ProjectContext, create: boolean): Promise<ProjectTask | undefined> => {
  const dir = rt.path.resolve(rt.cwd, ctx.dir);
  const kind = await kindOf(rt, dir, ctx.kind);
  if (!kind) return undefined;
  const file = at(rt, dir, TASK_FILE);
  const stored = await recordAt(rt, file);
  const manifest = kind === 'image' ? ((await recordAt(rt, rt.path.join(dir, MANIFEST_NAME))) ?? {}) : {};
  const titles = kind === 'image' ? [stored?.title, manifest.title, manifest.name, manifest.brief] : [stored?.title, ctx.title];
  const title = [...titles, rt.path.basename(dir)].map(cleanTitle).find((t) => t !== undefined);
  const base = { dir, kind, ...(title ? { title } : {}) };
  const id = kind === 'image' && fits(manifest.projectId) ? manifest.projectId : stored && fits(stored.id) ? stored.id : undefined;
  // An id in the task file that does not fit, or a file that cannot be read, is not replaced: an id is never changed.
  if (id || !create || stored?.id !== undefined || (!stored && (await exists(rt, file)))) return { ...base, ...(id ? { id } : {}) };
  const made = newId(rt);
  // A video project keeps the title of its first request (what that command was about, else the folder's name), so
  // its line on the account page stays the same until one is given.
  const named = kind === 'video' && stored?.title === undefined && title !== undefined ? { title } : {};
  await rt.fs.mkdir(rt.path.dirname(file));
  await writeJson(rt, file, { ...stored, id: made, ...named });
  return { ...base, id: made };
};

const newId = (rt: Runtime): string => rt.randomUUID().replace(/-/g, '');

/**
 * Names the task of the project at `dir` (`popost usage --title`): the title goes into production/task.json, ahead of
 * every other, with an id when the project has none yet. A folder that is not an image project is a video project.
 * Sends nothing.
 */
export const nameTask = async (rt: Runtime, dir: string, raw: string): Promise<ProjectTask> => {
  const title = cleanTitle(raw);
  if (!title) throw new TaskError(msg('--title needs a few words: it is empty without its control characters', '--title 需要几个字：去掉控制字符后为空'));
  const root = rt.path.resolve(rt.cwd, dir);
  const image = await exists(rt, rt.path.join(root, MANIFEST_NAME));
  const file = at(rt, root, TASK_FILE);
  const stored = await recordAt(rt, file);
  if (!stored && (await exists(rt, file))) throw new TaskError(msg(`${file} cannot be read; it is left as it is`, `${file} 无法读取，保持原样`));
  const manifest = image ? ((await recordAt(rt, rt.path.join(root, MANIFEST_NAME))) ?? {}) : {};
  const needsId = !(image && fits(manifest.projectId)) && stored?.id === undefined;
  await rt.fs.mkdir(rt.path.dirname(file));
  await writeJson(rt, file, { ...stored, ...(needsId ? { id: newId(rt) } : {}), title });
  return (await projectTask(rt, { dir: root, kind: image ? 'found' : 'video' }, false)) as ProjectTask;
};

/** A title that cannot be set. */
export class TaskError extends Error {
  override name = 'TaskError';
}

/** Tasks found per file system and project, so that requests side by side make one id. Only a task with an id is kept. */
const known = new WeakMap<object, Map<string, Promise<ProjectTask | undefined>>>();

const taskOf = (rt: Runtime, ctx: ProjectContext): Promise<ProjectTask | undefined> => {
  const byFs = known.get(rt.fs) ?? new Map<string, Promise<ProjectTask | undefined>>();
  known.set(rt.fs, byFs);
  const key = ctx.kind + ':' + rt.path.resolve(rt.cwd, ctx.dir);
  const found = byFs.get(key);
  if (found) return found;
  const task = projectTask(rt, ctx, true).catch(() => undefined);
  byFs.set(key, task);
  void task.then((t) => (t?.id ? undefined : byFs.delete(key)));
  return task;
};

/** The headers of a request in `rt`'s project; none outside a project, and none that does not fit its pattern. */
export const taskHeaders = async (rt: Runtime): Promise<Record<string, string>> => {
  if (!rt.project) return {};
  const task = await taskOf(rt, rt.project);
  if (!task?.id) return {};
  // The id is found once; the title is read again, so that a title given since goes with this request.
  const now = await projectTask(rt, rt.project, false).catch(() => undefined);
  const named = now?.title ?? task.title;
  const title = named === undefined ? undefined : encodeTitle(named);
  const session = rt.env.CODEX_THREAD_ID?.trim();
  return {
    'x-popost-task': task.id,
    ...(title ? { 'x-popost-task-title': title } : {}),
    ...(session && AGENT_SESSION.test(session) ? { 'x-popost-agent-session': session } : {}),
  };
};

/** `rt` working in the project at `dir`; title: what the command is about, for a video project without a title. */
export const inProject = (rt: Runtime, dir: string, kind: ProjectContext['kind'] = 'video', title?: string): Runtime => ({
  ...rt,
  project: { dir: rt.path.resolve(rt.cwd, dir), kind, ...(title ? { title } : {}) },
});

/** The project at or above `path`: the nearest folder that is an image project or has the marks of a video project. */
export const enclosingProject = async (rt: Runtime, path: string): Promise<string | undefined> => {
  for (let dir = rt.path.resolve(rt.cwd, path); ; dir = rt.path.dirname(dir)) {
    if (await kindOf(rt, dir, 'found')) return dir;
    if (rt.path.dirname(dir) === dir) return undefined;
  }
};

/** `rt` working in the project around `path` (an output of the command), or `rt` itself when there is none. */
export const aroundPath = async (rt: Runtime, path: string | undefined): Promise<Runtime> => {
  const dir = path ? await enclosingProject(rt, path) : undefined;
  return dir ? inProject(rt, dir, 'found') : rt;
};

/** The value of --dir in a command line (`--dir P` or `--dir=P`): the project the command works in. */
export const dirArg = (argv: readonly string[]): string | undefined => {
  for (const [i, word] of argv.entries()) {
    if (word === '--') return undefined;
    if (word.startsWith('--dir=')) return word.slice('--dir='.length) || undefined;
    const next = argv[i + 1];
    if (word === '--dir' && next && !next.startsWith('-')) return next;
  }
  return undefined;
};
