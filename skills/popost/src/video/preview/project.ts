/**
 * Reads everything the preview shows from disk: the checked and resolved project (buildPage), the page with its
 * picture URLs moved under /project/, the two measurements, the draft notes and the score. Read-only: nothing here
 * writes a file. Results are cached until the watcher reports a change (bump).
 */
import type { Runtime } from '../../runtime';
import { buildPage, compilePage, type BuiltPage } from '../compile/index';
import type { DraftNote } from '../draft/build';
import { scoreMeasures } from '../score/index';
import type { Measure, Problem, Resolved } from '../types';
import { errorPageHtml } from './html';
import type { MeasureFile, PreviewState } from './protocol';

export interface SourceOptions {
  /** The project directory and the files below, as the user typed them (against rt.cwd). */
  projectDir: string;
  reference?: string;
  /** Measurement of our render and of the reference; when absent, the default names below are looked up in the project. */
  measure?: string;
  referenceMeasure?: string;
  /** Edit mode: the state carries video.json as written ("source"), which the page's form edits. */
  edit?: boolean;
}

/** File names looked up in the project directory, in this order. The round trip writes measure.json and truth.json. */
export const RENDER_MEASURE_NAMES = ['measure.json', 'render.measure.json', 'replica.measure.json'] as const;
export const REFERENCE_MEASURE_NAMES = ['reference.measure.json', 'reference-measure.json', 'truth.json'] as const;
export const NOTES_FILE = 'draft-notes.json';
export const PROJECT_FILE = 'video.json';

/** Where the page loads project files from: /page sits at the root, so "project/x.png" is /project/x.png. */
export const PROJECT_URL_PREFIX = 'project/';

export interface Loaded {
  state: PreviewState;
  page: { status: number; html: string };
  /** Absolute paths whose change should reload the preview. */
  sources: string[];
}

interface JsonRead { value?: unknown; missing?: boolean; error?: string }

const readJson = async (rt: Runtime, file: string): Promise<JsonRead> => {
  let text: string;
  try {
    text = await rt.fs.readText(file);
  } catch {
    return { missing: true };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (e) {
    return { error: file + ' is not valid JSON (' + (e instanceof Error ? e.message : String(e)) + ').' };
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A light shape check: enough for the shell to draw it without crashing. */
const measureShapeError = (v: unknown): string | undefined => {
  if (!isRecord(v)) return 'it is not a JSON object';
  if (v.version !== 1) return '"version" is ' + JSON.stringify(v.version) + ', expected 1';
  const src = v.source;
  if (!isRecord(src) || typeof src.fps !== 'number' || !(src.fps > 0) || typeof src.frames !== 'number') return '"source" needs numbers "fps" (above 0) and "frames"';
  if (!Array.isArray(v.boundaries) || !Array.isArray(v.shots)) return '"boundaries" and "shots" must be arrays';
  return undefined;
};

const MEASURE_FIX = 'Write it with: popost video measure <video> --out <file>.';

/** The first file that exists: the explicit one, or the first default name in the project directory. */
const findMeasure = async (rt: Runtime, dir: string, explicit: string | undefined, names: readonly string[]): Promise<{ file: string; read: JsonRead } | undefined> => {
  const candidates = explicit ? [rt.path.resolve(rt.cwd, explicit)] : names.map((n) => rt.path.join(dir, n));
  for (const file of candidates) {
    const read = await readJson(rt, file);
    if (!read.missing || explicit) return { file, read };
  }
  return undefined;
};

const loadMeasure = async (rt: Runtime, dir: string, explicit: string | undefined, names: readonly string[], what: string, messages: string[]): Promise<MeasureFile | null> => {
  const found = await findMeasure(rt, dir, explicit, names);
  if (!found) return null;
  const { file, read } = found;
  if (read.missing) {
    messages.push('The ' + what + ' measurement ' + file + ' could not be read. ' + MEASURE_FIX);
    return null;
  }
  if (read.error) {
    messages.push('The ' + what + ' measurement: ' + read.error + ' ' + MEASURE_FIX);
    return null;
  }
  const shape = measureShapeError(read.value);
  if (shape) {
    messages.push('The ' + what + ' measurement ' + file + ' is not a measurement: ' + shape + '. ' + MEASURE_FIX);
    return null;
  }
  return { file, measure: read.value as Measure };
};

const isNote = (v: unknown): v is DraftNote => isRecord(v) && typeof v.at === 'string' && typeof v.kind === 'string' && typeof v.message === 'string';

const loadNotes = async (rt: Runtime, dir: string, messages: string[]): Promise<DraftNote[] | null> => {
  const read = await readJson(rt, rt.path.join(dir, NOTES_FILE));
  if (read.missing) return null;
  if (read.error) {
    messages.push(read.error);
    return null;
  }
  if (!Array.isArray(read.value) || !read.value.every(isNote)) {
    messages.push(NOTES_FILE + ' should be a list of { "at", "kind", "message" }; it is left out.');
    return null;
  }
  return read.value;
};

const scoreOf = (render: MeasureFile | null, reference: MeasureFile | null, messages: string[]): PreviewState['score'] => {
  if (!render || !reference) return null;
  try {
    return scoreMeasures(reference.measure, render.measure);
  } catch (e) {
    messages.push('No score: scoreMeasures failed (' + (e instanceof Error ? e.message : String(e)) + ').');
    return null;
  }
};

/** Material files (and words files) named in video.json, read leniently so that a project with errors still reloads when one appears. */
const materialFiles = (json: unknown): string[] => {
  if (!isRecord(json) || !Array.isArray(json.materials)) return [];
  return json.materials.flatMap((m) => (isRecord(m) ? [m.file, m.words].filter((f): f is string => typeof f === 'string') : []));
};

const withUrl = (src: string): string => PROJECT_URL_PREFIX + src.split('/').map(encodeURIComponent).join('/');

/** The same timeline with every picture URL under /project/, so the page finds the files the server serves. */
export const withProjectUrls = (r: Resolved): Resolved => ({
  ...r,
  segments: r.segments.map((s) => (s.base.kind === 'image' || s.base.kind === 'scene' ? { ...s, base: { ...s.base, src: withUrl(s.base.src) } } : s)),
  items: r.items.map((it) => (it.src === undefined ? it : { ...it, src: withUrl(it.src) })),
  audio: r.audio.map((a) => ({ ...a, src: withUrl(a.src) })),
  // Video frames are pictures in the project's .cache directory, served like any project file.
  footage: Object.fromEntries(Object.entries(r.footage ?? {}).map(([id, f]) => [id, { ...f, src: withUrl(f.src), ...(f.dir === undefined ? {} : { dir: withUrl(f.dir) }) }] as const)),
  fonts: (r.fonts ?? []).map((f) => ({ ...f, src: withUrl(f.src) })),
});

const pageOf = async (resolved: Resolved | undefined, problems: Problem[], dir: string): Promise<Loaded['page']> =>
  resolved ? { status: 200, html: await compilePage(withProjectUrls(resolved)) } : { status: 422, html: errorPageHtml(problems, dir) };

/** buildPage, with an unexpected failure (a bug, not a problem of the project) reported as a problem instead of a 500. */
const safeBuild = (rt: Runtime, dir: string): Promise<BuiltPage> =>
  buildPage(rt, dir).catch((e: unknown): BuiltPage => ({
    problems: [{ level: 'error', at: '(root)', message: 'Building the page failed: ' + (e instanceof Error ? e.message : String(e)), fix: 'Run "popost video check ' + dir + '" and report the failure if check passes.' }],
  }));

/** Reads everything once. generation is passed through to the state. */
export const loadAll = async (rt: Runtime, o: SourceOptions, generation: number): Promise<Loaded> => {
  const dir = rt.path.resolve(rt.cwd, o.projectDir);
  const messages: string[] = [];
  const [built, raw, measure, referenceMeasure, notes] = await Promise.all([
    safeBuild(rt, dir),
    readJson(rt, rt.path.join(dir, PROJECT_FILE)),
    loadMeasure(rt, dir, o.measure, RENDER_MEASURE_NAMES, 'render', messages),
    loadMeasure(rt, dir, o.referenceMeasure, REFERENCE_MEASURE_NAMES, 'reference', messages),
    loadNotes(rt, dir, messages),
  ]);
  const score = scoreOf(measure, referenceMeasure, messages);
  const resolved = built.html ? built.resolved : undefined;
  const state: PreviewState = {
    generation,
    project: { dir, name: rt.path.basename(dir) },
    problems: built.problems,
    resolved: resolved ?? null,
    measure,
    referenceMeasure,
    score,
    notes,
    reference: o.reference ? { name: rt.path.basename(o.reference) } : null,
    messages,
    ...(o.edit ? { source: raw.value ?? null } : {}),
  };
  const fixed = [PROJECT_FILE, NOTES_FILE, ...RENDER_MEASURE_NAMES, ...REFERENCE_MEASURE_NAMES].map((n) => rt.path.join(dir, n));
  const given = [o.measure, o.referenceMeasure].flatMap((f) => (f ? [rt.path.resolve(rt.cwd, f)] : []));
  const sceneFiles = isRecord(raw.value) && Array.isArray(raw.value.segments) ? raw.value.segments.flatMap(s=>isRecord(s)&&isRecord(s.base)&&typeof s.base.scene==='string'?[rt.path.resolve(dir,s.base.scene)]:[]) : [];
  const sources = [...fixed, ...given, ...sceneFiles, ...materialFiles(raw.value).map((f) => rt.path.resolve(dir, f))];
  return { state, page: await pageOf(resolved, built.problems, dir), sources };
};

export interface Loader {
  load(): Promise<Loaded>;
  /** Marks the cache stale; the next load reads everything again. Returns the new generation. */
  bump(): number;
  /** True when a change of this absolute path should reload the preview. */
  isSource(file: string): boolean;
  /** The absolute paths whose change should reload the preview, as of the last load. */
  sources(): string[];
}

export const createLoader = (rt: Runtime, o: SourceOptions): Loader => {
  let generation = 0;
  let cached: { generation: number; loaded: Promise<Loaded> } | undefined;
  let sources = new Set<string>();
  const load = (): Promise<Loaded> => {
    if (cached?.generation !== generation) {
      const loaded = loadAll(rt, o, generation);
      cached = { generation, loaded };
      void loaded.then((l) => { sources = new Set(l.sources); }, () => undefined);
    }
    return cached.loaded;
  };
  return {
    load,
    bump: () => ++generation,
    isSource: (file) => sources.has(rt.path.resolve(rt.cwd, file)),
    sources: () => [...sources],
  };
};

