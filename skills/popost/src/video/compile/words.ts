/**
 * The build step of words: before check and resolve, read the words file of every audio material that names one
 * (types.ts WordsFile) and check its content (project/words.ts). A file outside the project or missing is left out;
 * check reports it with the other files.
 */
import type { Runtime } from '../../runtime';
import type { Project, WordsInfo } from '../types';
import { isOutside } from '../project/check';
import { parseWordsFile } from '../project/words';

const readOne = async (rt: Runtime, file: string, name: string): Promise<WordsInfo> => {
  let text: string;
  try {
    text = await rt.fs.readText(file);
  } catch (e) {
    return { error: 'The words file "' + name + '" could not be read (' + (e instanceof Error ? e.message : String(e)).split('\n')[0] + ').', fix: 'Check that it is a readable JSON file in the project directory.' };
  }
  try {
    return parseWordsFile(JSON.parse(text) as unknown, name);
  } catch (e) {
    return { error: 'The words file "' + name + '" is not valid JSON: ' + (e instanceof Error ? e.message : String(e)) + '.', fix: 'Correct the JSON syntax; the format is { "fps": 30, "tokens": [...] } as src/align writes it.' };
  }
};

/** What every words file says, by material id: for check (problems) and resolve (frames). projectDir: as typed. */
export const loadWords = async (rt: Runtime, project: Project, projectDir: string): Promise<Record<string, WordsInfo>> => {
  const root = rt.path.resolve(rt.cwd, projectDir);
  const named = project.materials.filter((m) => m.kind === 'audio' && m.words && !isOutside(m.words));
  const read = await Promise.all(named.map(async (m) => {
    const file = rt.path.resolve(root, m.words ?? '');
    return (await rt.fs.stat(file)) === null ? [] : [[m.id, await readOne(rt, file, m.words ?? '')] as const];
  }));
  return Object.fromEntries(read.flat());
};
