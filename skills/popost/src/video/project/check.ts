/**
 * Checks what the schema cannot express: ids, references, lengths, spans, kinds of materials, files on disk.
 * Every Problem names its JSON path, says what is wrong, lists the allowed values where there is a list, and gives one fix.
 * The check itself reads nothing: readProjectFiles gathers what it needs to know about the files first.
 */
import type { Runtime } from '../../runtime';
import type { FootageInfo, Problem, Project, Segment, WordsInfo } from '../types';
import { timelineOf } from '../timeline/spans';
import { trackWords } from '../timeline/words';
import { error, materialRef, warning, type CheckContext } from './check-common';
import { checkTracks } from './check-tracks';
import { checkFootageFiles, checkPlay } from './check-footage';
import { checkTransition, checkTransitionOverlaps } from './check-transition';
import { checkCamera } from './check-camera';
import { checkFill, checkFonts } from './check-look';
import { checkWordsMaterials } from './check-words';
import { lintScene, slotProblems } from '../scene/lint';

const duplicates = (list: readonly { id: string }[], name: string, what: string): Problem[] => {
  const first = new Map<string, number>();
  list.forEach((x, i) => { if (!first.has(x.id)) first.set(x.id, i); });
  return list.flatMap((x, i) => {
    const j = first.get(x.id) ?? i;
    return j === i ? [] : [error(name + '[' + i + '].id', what + ' id "' + x.id + '" is already used by ' + name + '[' + j + '].', 'Give it its own id, for example "' + x.id + '-' + (i + 1) + '".')];
  });
};

const checkFrames = (ctx: CheckContext, s: Segment, k: number): Problem[] =>
  Number.isInteger(s.frames) && (s.frames ?? 0) >= 1
    ? []
    : [error('segments[' + k + '].frames', 'Segment "' + s.id + '" has ' + (s.frames === undefined ? 'no "frames"' : '"frames": ' + s.frames) + '; every segment needs a length of at least 1 frame, because this version has no speech to time it.', 'Set "frames" to the length, for example ' + ctx.fps * 3 + ' (3 seconds at ' + ctx.fps + ' fps).')];

/** What checkProject knows about the project's files on disk; readProjectFiles reads it. */
export interface ProjectFiles {
  /** The project directory, as the problems name it. */
  dir: string;
  /** Paths, as video.json writes them, that exist in the directory. */
  present: ReadonlySet<string>;
  /** The source of every scene file that exists, by its path in video.json. */
  scenes: Readonly<Record<string, string>>;
}

/** The last part of a path written with either slash. */
const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;

/** A scene base: an HTML file inside the project; with files, it is on disk and keeps the rules a scene keeps (scene/lint.ts). */
const checkScene = (file: string, at: string, id: string, files: ProjectFiles | undefined, slots?: Record<string, string>): Problem[] => {
  if (isOutside(file)) return [error(at, 'The scene "' + file + '" of segment "' + id + '" lies outside the project directory.', 'Put it in the project, for example scenes/' + baseName(file) + ', and write its path relative to the project directory.')];
  if (!/\.html?$/i.test(file)) return [error(at, 'The scene "' + file + '" of segment "' + id + '" is not an HTML file.', 'A scene is an HTML page, for example scenes/' + id + '.html.')];
  if (files === undefined) return [];
  if (!files.present.has(file)) return [error(at, 'The scene "' + file + '" of segment "' + id + '" does not exist in ' + files.dir + '.', 'Write the file, or correct the path (it is relative to the project directory).')];
  const html = files.scenes[file] ?? '';
  return [...lintScene(html, at), ...slotProblems(html, slots, at.replace(/\.scene$/, '.slots'))];
};

const checkBase = (ctx: CheckContext, s: Segment, k: number, files?: ProjectFiles): Problem[] => {
  const at = 'segments[' + k + '].base';
  if ('scene' in s.base) return checkScene(s.base.scene, at + '.scene', s.id, files, s.base.slots);
  if (!('material' in s.base)) return checkFill(s.base.color, at + '.color');
  const ref = materialRef(ctx, s.base.material, at + '.material', ['image', 'video'], 'the base of segment "' + s.id + '"');
  const start = ctx.tl.starts[k] ?? 0;
  const span = { start, end: start + (ctx.tl.lengths[k] ?? 0) };
  const camera = checkCamera(ctx, s.base.camera, k, at + '.camera');
  return ref.length > 0 ? [...ref, ...camera] : [...checkPlay(ctx, s.base, s.base.material, at, 'The base of segment "' + s.id + '"', span), ...camera];
};

/**
 * True when a material's file path leaves the project directory: absolute (with either slash, or a drive letter), or
 * through ".." anywhere it climbs above the start.
 */
export const isOutside = (file: string): boolean => {
  const slashed = file.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-z]:\//i.test(slashed)) return true;
  let depth = 0;
  for (const part of slashed.split('/')) {
    if (part === '..') depth--;
    else if (part !== '' && part !== '.') depth++;
    if (depth < 0) return true;
  }
  return false;
};

/** Every file of the project video.json names and the check looks for: material and words files, and scenes. */
const namedFiles = (project: Project): { files: string[]; scenes: string[] } => ({
  files: project.materials.flatMap((m) => [m.file, m.words].filter((f): f is string => typeof f === 'string' && f !== '' && !isOutside(f))),
  scenes: project.segments.flatMap((s) => ('scene' in s.base && !isOutside(s.base.scene) && /\.html?$/i.test(s.base.scene) ? [s.base.scene] : [])),
});

/** Reads what checkProject needs to know about the files of a project in dir (as typed: the problems name it so). */
export const readProjectFiles = async (rt: Runtime, project: Project, dir: string): Promise<ProjectFiles> => {
  const root = rt.path.resolve(rt.cwd, dir);
  const named = namedFiles(project);
  const all = [...new Set([...named.files, ...named.scenes])];
  const found = await Promise.all(all.map(async (f) => ((await rt.fs.stat(rt.path.resolve(root, f))) !== null ? [f] : [])));
  const present = new Set(found.flat());
  const scenes = await Promise.all([...new Set(named.scenes)].filter((f) => present.has(f)).map(async (f) => [f, await rt.fs.readText(rt.path.resolve(root, f))] as const));
  return { dir, present, scenes: Object.fromEntries(scenes) };
};

/** A material's file and its words file: inside the project, and on disk when the files were read. */
const checkMaterialFiles = (project: Project, files: ProjectFiles | undefined): Problem[] =>
  project.materials.flatMap((m, i) => (['file', 'words'] as const).flatMap((key) => {
    const at = 'materials[' + i + '].' + key;
    const name = m[key];
    const what = key === 'file' ? 'The file' : 'The words file';
    if (!name) return [];
    if (isOutside(name)) return [error(at, what + ' "' + name + '" of material "' + m.id + '" lies outside the project directory.', 'Copy it into the project, for example under assets/, and write its path relative to the project directory.')];
    if (files !== undefined && !files.present.has(name)) return [error(at, what + ' "' + name + '" of material "' + m.id + '" does not exist in ' + files.dir + '.', 'Put the file there, or correct the path (it is relative to the project directory).')];
    return [];
  }));

const checkCanvas = (project: Project): Problem[] => {
  const { width, height } = project.canvas;
  return width % 2 === 0 && height % 2 === 0
    ? []
    : [warning('canvas', 'The canvas is ' + width + 'x' + height + '; H.264 needs even sizes, so the render drops the last odd pixel row or column.', 'Use even sizes, for example 1080x1920.')];
};

/**
 * Problems a schema cannot express. Run it on a project that parseProject accepted. opts.files: what readProjectFiles
 * read from the project directory, to check the files on disk (checkProjectOnDisk reads and checks). opts.footage: what the build step read from the video materials' files (compile/footage.ts probeFootage); without
 * it, the checks that need the source's length and frame rate are skipped. opts.words: what it read from the words
 * files (compile/words.ts loadWords); without it, phrases are not looked up and captions not matched to the words.
 */
export const checkProject = (project: Project, opts: { files?: ProjectFiles; footage?: Readonly<Record<string, FootageInfo>>; words?: Readonly<Record<string, WordsInfo>> } = {}): Problem[] => {
  const tl = timelineOf(project);
  const ctx: CheckContext = {
    project,
    tl,
    materials: new Map(project.materials.map((m) => [m.id, m] as const).reverse()),
    fps: project.canvas.fps,
    footage: opts.footage ?? {},
    wordsRead: opts.words ?? {},
    words: trackWords(project, tl, opts.words ?? {}),
  };
  return [
    ...checkCanvas(project),
    ...duplicates(project.materials, 'materials', 'Material'),
    ...duplicates(project.segments, 'segments', 'Segment'),
    ...duplicates(project.tracks, 'tracks', 'Track'),
    ...project.segments.flatMap((s, k) => [...checkFrames(ctx, s, k), ...checkBase(ctx, s, k, opts.files), ...checkTransition(ctx, s, k)]),
    ...checkTransitionOverlaps(ctx),
    ...checkTracks(ctx),
    ...checkFonts(ctx),
    ...checkMaterialFiles(project, opts.files),
    ...checkFootageFiles(ctx),
    ...checkWordsMaterials(ctx),
  ];
};

/** checkProject with the files of the project in dir (as typed) read first. */
export const checkProjectOnDisk = async (rt: Runtime, project: Project, dir: string, opts: { footage?: Readonly<Record<string, FootageInfo>>; words?: Readonly<Record<string, WordsInfo>> } = {}): Promise<Problem[]> =>
  checkProject(project, { ...opts, files: await readProjectFiles(rt, project, dir) });

export const hasErrors = (problems: readonly Problem[]): boolean => problems.some((p) => p.level === 'error');

/** One line per problem, for error messages and the CLI. */
export const formatProblems = (problems: readonly Problem[]): string =>
  problems.map((p) => p.level + ' at ' + p.at + ': ' + p.message + (p.allowed ? ' Allowed: ' + p.allowed.join(', ') + '.' : '') + (p.fix ? ' Fix: ' + p.fix : '')).join('\n');
