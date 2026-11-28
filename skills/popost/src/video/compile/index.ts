/**
 * Project directory -> page: read video.json, parse, read the video materials (probe) and the words files, check,
 * resolve, extract the video frames the timeline shows (compile/footage.ts), compile. Errors among the problems mean
 * no page.
 */
import type { Runtime } from '../../runtime';
import type { Problem, Project, Resolved } from '../types';
import { parseProject } from '../project/schema';
import { checkProject, readProjectFiles } from '../project/check';
import { resolve } from '../timeline/resolve';
import { compilePage } from './page';
import { extractFootage, probeFootage, type FootageStats } from './footage';
import { loadWords } from './words';
import { checkSpeechLocks } from '../generate/speech-lock';
import { clipMusicRecords, musicOverlap, soundRecords, speakingCuts, speechOverlap } from '../project/check-sound';

export { compilePage } from './page';
export { loadWords } from './words';

export interface BuiltPage {
  html?: string;
  /** The timeline the page plays, with the frame directory of every video material set. */
  resolved?: Resolved;
  /** The parsed project (absent when video.json could not be read or parsed). */
  project?: Project;
  problems: Problem[];
  /** What the build did with video frames (absent when the project shows no video). */
  footage?: FootageStats;
}

export interface BuildOptions {
  /** Render scale: the page's size, and the size video frames are extracted at. Default 1. */
  scale?: number;
  /** An immutable JSON snapshot, supplied by Studio exports. Assets still resolve against projectDir. */
  source?: unknown;
}

/** shown: the file as the user's path names it, for the message. */
const readJson = async (rt: Runtime, file: string, shown: string): Promise<{ json?: unknown; problem?: Problem }> => {
  let text: string;
  try {
    text = await rt.fs.readText(file);
  } catch {
    return { problem: { level: 'error', at: '(root)', message: 'Could not read ' + shown + '.', fix: 'Create video.json in the project directory, or pass the right directory.' } };
  }
  try {
    return { json: JSON.parse(text) as unknown };
  } catch (e) {
    return { problem: { level: 'error', at: '(root)', message: 'video.json is not valid JSON: ' + (e instanceof Error ? e.message : String(e)) + '.', fix: 'Correct the JSON syntax (commas, quotes, brackets); JSON has no comments, use a "note" field instead.' } };
  }
};

/** projectDir: as the user typed it (the problems name it so), against rt.cwd. */
export const buildPage = async (rt: Runtime, projectDir: string, opts: BuildOptions = {}): Promise<BuiltPage> => {
  const read = opts.source === undefined ? await readJson(rt, rt.path.resolve(rt.cwd, projectDir, 'video.json'), rt.path.join(projectDir, 'video.json')) : { json: opts.source };
  if (read.problem) return { problems: [read.problem] };
  const parsed = parseProject(read.json);
  if (!parsed.project) return { problems: parsed.problems };
  const [probed, words, files] = await Promise.all([probeFootage(rt, parsed.project, projectDir), loadWords(rt, parsed.project, projectDir), readProjectFiles(rt, parsed.project, projectDir)]);
  const problems = [...parsed.problems, ...checkProject(parsed.project, { files, footage: probed.info, words })];
  if (problems.some((p) => p.level === 'error')) return { problems, project: parsed.project };
  const plain = resolve(parsed.project, probed.info, words);
  problems.push(...await checkSpeechLocks(rt, rt.path.resolve(rt.cwd, projectDir), plain), ...speechOverlap(plain), ...musicOverlap(plain), ...speakingCuts(plain), ...await clipMusicRecords(rt, rt.path.resolve(rt.cwd, projectDir), plain), ...await soundRecords(rt, rt.path.resolve(rt.cwd, projectDir), parsed.project));
  if (problems.some(p => p.level === 'error')) return { problems, project: parsed.project };
  const shows = Object.keys(plain.footage ?? {}).length > 0;
  const { resolved, stats } = shows ? await extractFootage(rt, plain, projectDir, probed, { scale: opts.scale }) : { resolved: plain, stats: undefined };
  return { html: await compilePage(resolved, opts), resolved, project: parsed.project, problems, ...(stats ? { footage: stats } : {}) };
};
