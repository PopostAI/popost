/**
 * The edit session of one project directory: applies operations to video.json after check passes, keeps undo and
 * redo in memory, and keeps the file as it was when the session started as video.json.bak (written once, on the
 * first edit). It writes exactly two files, video.json and video.json.bak, each through a temporary file in the same
 * directory that is renamed over it, so a reader never sees half a file. Requests are applied one at a time.
 */
import type { Runtime } from '../../../runtime';
import type { Problem } from '../../types';
import type { EditInfo, StepKind } from '../protocol';
import { checkJson, newUnknownFields } from './check';
import { applyOp, opLabel, type EditOp } from './ops';

export const PROJECT_FILE = 'video.json';
export const BACKUP_FILE = 'video.json.bak';
/** Steps kept for undo; the oldest is dropped beyond it. */
export const HISTORY_LIMIT = 100;

export type { EditInfo, StepKind };

interface Step { before: string; after: string; op: StepKind; label: string }

/** What a request did: ok with what changed, or the HTTP status and the problems (nothing was written then). */
export type Outcome =
  | { ok: true; op: StepKind | 'undo' | 'redo'; step: StepKind; label: string; info: EditInfo }
  | { ok: false; status: number; problems: Problem[]; info: EditInfo };

export interface Editor {
  apply(op: EditOp): Promise<Outcome>;
  undo(): Promise<Outcome>;
  redo(): Promise<Outcome>;
  /** Reads video.json; a change that is not ours becomes a step of its own and clears redo. True when there was one. */
  sync(): Promise<boolean>;
  info(): EditInfo;
}

const readText = (rt: Runtime, file: string): Promise<string | undefined> => rt.fs.readText(file).catch(() => undefined);

/** Writes through a temporary file of its own (a new random name) in the same directory and renames it over the target. */
const writeAtomic = async (rt: Runtime, file: string, text: string): Promise<void> => {
  const temp = rt.path.join(rt.path.dirname(file), '.' + rt.path.basename(file) + '.' + rt.randomUUID().replace(/-/g, '').slice(0, 12) + '.tmp');
  try {
    await rt.fs.writeFile(temp, text);
    await rt.fs.rename(temp, file);
  } catch (e) {
    await rt.fs.rm(temp);
    throw e;
  }
};

/** The indentation of a JSON text (two spaces when it has none), so an edit keeps the file's look. */
const indentOf = (text: string): string | number => {
  const m = text.match(/\n([ \t]+)\S/);
  return m?.[1] ?? 2;
};

export const formatJson = (value: unknown, like: string): string => JSON.stringify(value, null, indentOf(like)) + (like.endsWith('\n') || like === '' ? '\n' : '');

const problem = (at: string, message: string, fix: string): Problem => ({ level: 'error', at, message, fix });

/**
 * An operation applied to the text of video.json: the new text and what it touched, or the status and the problems
 * that refuse it (a text that is not JSON, a path that does not fit, a field the format does not know, a check error).
 */
export const editText = async (rt: Runtime, text: string, op: EditOp, dir: string): Promise<{ text: string; label: string } | { status: number; problems: Problem[] }> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { status: 409, problems: [problem('(root)', 'video.json is not valid JSON (' + (e instanceof Error ? e.message : String(e)) + '), so it cannot be edited here.', 'Correct the JSON in your editor and save; the preview reloads by itself.')] };
  }
  const applied = applyOp(json, op);
  if ('problem' in applied) return { status: 400, problems: [applied.problem] };
  const unknown = newUnknownFields(json, applied.json);
  if (unknown.length) return { status: 400, problems: unknown };
  const problems = await checkJson(rt, applied.json, dir);
  if (problems.some((p) => p.level === 'error')) return { status: 422, problems };
  return { text: formatJson(applied.json, text), label: opLabel(json, applied.json, op) };
};

/** dir: the project directory, absolute. */
export const createEditor = async (rt: Runtime, dir: string): Promise<Editor> => {
  const file = rt.path.join(dir, PROJECT_FILE);
  const original = await readText(rt, file);
  let current = original;
  let backup = false;
  let undo: Step[] = [];
  let redo: Step[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const info = (): EditInfo => ({ undo: undo.length, redo: redo.length, backup });
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const push = (step: Step): void => {
    undo = [...undo, step].slice(-HISTORY_LIMIT);
    redo = [];
  };
  const sync = async (): Promise<boolean> => {
    const text = await readText(rt, file);
    if (text === undefined || text === current) return false;
    push({ before: current ?? '', after: text, op: 'outside', label: PROJECT_FILE });
    current = text;
    return true;
  };
  const write = async (text: string): Promise<void> => {
    if (!backup && original !== undefined) {
      await writeAtomic(rt, rt.path.join(dir, BACKUP_FILE), original);
      backup = true;
    }
    await writeAtomic(rt, file, text);
    current = text;
  };
  const refused = (status: number, problems: Problem[]): Outcome => ({ ok: false, status, problems, info: info() });

  const apply = async (op: EditOp): Promise<Outcome> => {
    await sync();
    const before = current ?? '';
    const edited = await editText(rt, before, op, dir);
    if ('problems' in edited) return refused(edited.status, edited.problems);
    if (edited.text !== before) {
      await write(edited.text);
      push({ before, after: edited.text, op: op.op, label: edited.label });
    }
    return { ok: true, op: op.op, step: op.op, label: edited.label, info: info() };
  };

  const travel = async (back: boolean): Promise<Outcome> => {
    await sync();
    const from = back ? undo : redo;
    const step = from[from.length - 1];
    if (!step) return refused(409, [problem('(history)', back ? 'There is nothing to undo.' : 'There is nothing to redo.', back ? 'Make an edit first.' : 'Undo something first.')]);
    await write(back ? step.before : step.after);
    if (back) {
      undo = undo.slice(0, -1);
      redo = [...redo, step];
    } else {
      redo = redo.slice(0, -1);
      undo = [...undo, step];
    }
    return { ok: true, op: back ? 'undo' : 'redo', step: step.op, label: step.label, info: info() };
  };

  return {
    apply: (op) => serial(() => apply(op)),
    undo: () => serial(() => travel(true)),
    redo: () => serial(() => travel(false)),
    sync: () => serial(sync),
    info,
  };
};
