/**
 * What the preview server sends to the shell: the JSON of GET /api/state and the events of GET /api/events.
 * Types only, shared by the Node server and the browser shell.
 */
import type { DraftNote } from '../draft/build';
import type { Measure, Problem, Resolved, Score } from '../types';

export interface MeasureFile {
  /** The path as given on the command line, or found in the project directory. */
  file: string;
  measure: Measure;
}

export interface PreviewState {
  /** Grows by one on every change the watcher reported; the shell adds it to the page URL so the frame reloads. */
  generation: number;
  project: { dir: string; name: string };
  /** Everything check found, errors and warnings. With an error, resolved is null and /page lists the problems. */
  problems: Problem[];
  resolved: Resolved | null;
  /** The measurement of our render, and of the reference video. Frames are those of each measured file. */
  measure: MeasureFile | null;
  referenceMeasure: MeasureFile | null;
  /** scoreMeasures(reference, render) when both measurements exist and the scorer could be loaded. */
  score: Score | null;
  /** draft-notes.json of the project directory, when present. */
  notes: DraftNote[] | null;
  /** The reference video, when one was given. The shell loads it from /reference. */
  reference: { name: string } | null;
  /** Why something the shell could show is missing: an unreadable measure file, a scorer that failed. */
  messages: string[];
  /** Edit mode only: video.json as written (null when it is not valid JSON), which the page's form edits. */
  source?: unknown;
  /** Edit mode only: what undo and redo can take, and the render started from the page. */
  edit?: EditState;
}

/** Server-sent event names. "reload": a source changed; data is { generation }. */
export const RELOAD_EVENT = 'reload';
/** Edit mode: a render's progress and result; data is a RenderInfo. */
export const RENDER_EVENT = 'render';

export interface EditInfo {
  /** Steps that undo and redo can take. */
  undo: number;
  redo: number;
  /** video.json.bak was written in this session. */
  backup: boolean;
}

export type RenderInfo =
  | { state: 'idle' }
  | { state: 'running'; frame: number; total: number; started: number }
  | { state: 'done'; frames: number; seconds: number; file: string; url: string; finished: number }
  | { state: 'failed'; message: string; finished: number };

export interface EditState extends EditInfo { render: RenderInfo }

/** What a step did: an operation of /api/edit, an edit made outside, or undo / redo of one of them. */
export type StepKind = 'set' | 'insert' | 'remove' | 'move' | 'outside';

/** The answer of POST /api/edit, /api/undo and /api/redo. Nothing was written when ok is false. */
export type EditAnswer =
  | { ok: true; op: StepKind | 'undo' | 'redo'; step: StepKind; label: string; history: EditInfo; state: PreviewState }
  | { ok: false; problems: Problem[]; history?: EditInfo };
