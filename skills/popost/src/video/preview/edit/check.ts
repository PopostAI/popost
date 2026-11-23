/**
 * The check an edit must pass before video.json is written: the same steps "popost video check" runs through buildPage
 * (parse, read the video materials and the words files, checkProject, resolve), on the edited JSON in memory, so that
 * nothing is written to find out. And the one rule of the editor itself: an edit may not add a field the format does
 * not know (the schema only warns about those, the editor refuses them).
 */
import type { Runtime } from '../../../runtime';
import { loadWords } from '../../compile/words';
import { probeFootage } from '../../compile/footage';
import { checkProject, readProjectFiles } from '../../project/check';
import { parseProject } from '../../project/schema';
import { resolve } from '../../timeline/resolve';
import type { Problem } from '../../types';

/** Everything check finds in the JSON of a project, errors and warnings, as "popost video check" reports them. */
export const checkJson = async (rt: Runtime, json: unknown, dir: string): Promise<Problem[]> => {
  const parsed = parseProject(json);
  if (!parsed.project) return parsed.problems;
  const [probed, words, files] = await Promise.all([probeFootage(rt, parsed.project, dir), loadWords(rt, parsed.project, dir), readProjectFiles(rt, parsed.project, dir)]);
  const problems = [...parsed.problems, ...checkProject(parsed.project, { files, footage: probed.info, words })];
  if (problems.some((p) => p.level === 'error')) return problems;
  try {
    resolve(parsed.project, probed.info, words);
    return problems;
  } catch (e) {
    return [...problems, { level: 'error', at: '(root)', message: 'Building the timeline failed: ' + (e instanceof Error ? e.message : String(e)), fix: 'Undo this edit; run "popost video check" and report the failure if check passes.' }];
  }
};

const UNKNOWN = /^Unknown field /;

/**
 * Fields the edit added that the format does not know (the schema's unknown-field warnings that were not there
 * before), as errors: such a path leaves the shape of video.json.
 */
export const newUnknownFields = (before: unknown, after: unknown): Problem[] => {
  const known = new Set(parseProject(before).problems.filter((p) => UNKNOWN.test(p.message)).map((p) => p.at));
  return parseProject(after).problems
    .filter((p) => UNKNOWN.test(p.message) && !known.has(p.at))
    .map((p) => ({ ...p, level: 'error' as const, message: p.message.replace(/; this version ignores it\.$/, '') + ': the path leaves the shape of video.json, so the edit is refused.' }));
};
