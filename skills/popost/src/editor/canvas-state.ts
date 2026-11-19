import { hasComparison } from './project-tools';
/**
 * Local disk state of the shared project canvas (port of `canvas_bridge.py`): the project as the editor sees it (manifest
 * with every page's HTML), its revision, the first-open snapshot, a short history, feedback notes, and the editor's HTML
 * page with the deployment settings injected. State lives in the project, never only in the browser.
 */
import type { Manifest, Project } from '../core/project';
import { isFile, readJson, sha256, writeJson } from '../core/util';

export type ProjectPayload = Manifest & { pages: (Manifest['pages'][number] & { html: string })[] };

export const STATE_DIR = '.popost-editor';
const HISTORY_LIMIT = 5;

/** Python `json.dumps(sort_keys=True)`: the same value always gives the same text, whatever the key order. */
export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const canvasPayload = async (project: Project): Promise<ProjectPayload> => {
  const manifest = structuredClone(project.manifest);
  const pages = [];
  for (const page of manifest.pages) pages.push({ ...page, html: await project.readPageHtml(page.id) });
  return { ...manifest, pages };
};

/** Changes whenever any page file, font entry or manifest field changes: the editor echoes it back on save. */
export const payloadRevision = (payload: ProjectPayload): string => sha256(stableJson(payload));

export const canvasRevision = async (project: Project): Promise<string> => payloadRevision(await canvasPayload(project));

const stateFile = (project: Project, ...parts: string[]): string =>
  project.rt.path.join(project.root, STATE_DIR, ...parts);

/** The project as it was when the editor first opened it (kept even after pages are deleted). */
export const canvasInitial = async (project: Project): Promise<{ manifest: ProjectPayload; createdAt: string }> => {
  const { rt } = project;
  const file = stateFile(project, 'initial.json');
  if (!(await isFile(rt, file)))
    await writeJson(rt, file, { manifest: await canvasPayload(project), createdAt: rt.now().toISOString() });
  return readJson<{ manifest: ProjectPayload; createdAt: string }>(rt, file);
};

/** Keep the project as it was before a save; only the newest few are retained. */
export const canvasBackup = async (project: Project): Promise<void> => {
  const { rt } = project;
  const dir = stateFile(project, 'history');
  const payload = await canvasPayload(project);
  await rt.fs.writeFile(rt.path.join(dir, `${payloadRevision(payload)}.json`), JSON.stringify(payload));
  const files = await Promise.all(
    (await rt.fs.readdir(dir)).filter((name) => name.endsWith('.json')).map(async (name) => ({
      name,
      mtime: (await rt.fs.stat(rt.path.join(dir, name)))?.mtimeMs ?? 0,
    })),
  );
  files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
  for (const old of files.slice(HISTORY_LIMIT)) await rt.fs.rm(rt.path.join(dir, old.name));
};

export class NoteError extends Error {
  override name = 'ValueError';
}

type Note = Record<string, unknown>;
export interface NoteOperation {
  op: string;
  note?: Note;
  id?: unknown;
  patch?: Note;
}

const applyOperation = (rows: Note[], operation: NoteOperation): Note[] => {
  if (typeof operation?.op !== 'string') throw new NoteError('note operation needs an op');
  if (operation.op === 'add') {
    if (!operation.note || typeof operation.note !== 'object') throw new NoteError('add needs a note');
    return [...rows, operation.note];
  }
  if (operation.op === 'update') {
    if (!operation.patch || typeof operation.patch !== 'object') throw new NoteError('update needs a patch');
    return rows.map((row) => (row.id === operation.id ? { ...row, ...operation.patch } : row));
  }
  if (operation.op === 'delete') return rows.filter((row) => row.id !== operation.id);
  return rows;
};

/** Feedback notes of the project; `operations` (add / update / delete) are applied and saved first. */
export const canvasNotes = async (
  project: Project,
  operations?: readonly NoteOperation[],
): Promise<{ notes: Note[]; command: string }> => {
  const { rt } = project;
  const file = stateFile(project, 'notes.json');
  let rows: Note[] = (await isFile(rt, file)) ? await readJson<Note[]>(rt, file) : [];
  if (operations) {
    for (const operation of operations) rows = applyOperation(rows, operation);
    await writeJson(rt, file, rows);
  }
  return { notes: rows, command: 'Feedback stays in this local project.' };
};

/** JSON text safe inside a `<script>`: ASCII only, and no `<` that could close the tag. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/</g, '\\u003c');

/** The editor's `index.html` with this project's settings injected; the editor's own HTML/CSS/JS stays shared. */
export const editorHtml = (project: Project, source: string, query = '', cloud: 'keyed' | 'anonymous' | 'off' = 'off'): string => {
  const page = project.manifest.pages[0];
  if (!page) throw new Error('project has no page');
  const projectId = project.manifest.projectId || sha256(project.root).slice(0, 32);
  const brief = typeof project.manifest.brief === 'string' ? project.manifest.brief : 'Popost';
  const config = {
    projectId,
    comparison: hasComparison(project),
    width: page.width,
    height: page.height,
    name: Array.from(brief).slice(0, 80).join(''),
    // Absent means no "Save to Cloud" button: the editor shows it only when the service offers cloud save.
    ...(cloud === 'off' ? {} : { cloud: { mode: cloud } }),
  };
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) if (value && !(key in params)) params[key] = value;
  Object.assign(params, { file: `pages/${projectId}.html`, popost: '1' });
  params.lang ??= 'zh';
  const script =
    `<base href="/_editor/"><script>window.__POPOST_LOCAL__=${scriptJson(config)};` +
    `window.__POPOST_PARAMS__=${scriptJson(new URLSearchParams(params).toString())};</script>`;
  return source.replace('<head>', () => `<head>${script}`);
};
