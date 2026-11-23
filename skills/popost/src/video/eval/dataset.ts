/**
 * The real evaluation set lives outside the repository (POPOST_VIDEO_DATA). Two files describe it:
 *   cases.json  [{ id, type, video (path relative to the data directory), materials, brief }]
 *   split.json  { dev: [ids], heldout: [ids] }
 * Nothing of it is ever committed, and file names of its videos never go into the ledger.
 */
import type { Runtime } from '../../runtime';

/** The evaluation set cannot be read. The message says what to set. */
export class EvalSetError extends Error {
  override name = 'EvalSetError';
}

export interface EvalCase { id: string; type: string; video: string; materials: string[]; brief: string }
export type EvalSet = 'dev' | 'heldout';

const readJson = async <T>(rt: Runtime, file: string, what: string): Promise<T> => {
  try {
    return JSON.parse(await rt.fs.readText(file)) as T;
  } catch (e) {
    throw new EvalSetError('Could not read ' + what + ' at ' + file + ' (' + (e instanceof Error ? e.message : String(e)) + '). Set POPOST_VIDEO_DATA to the directory of the evaluation set.');
  }
};

/** The cases of one set, with absolute video paths. */
export const loadSet = async (rt: Runtime, dataDir: string, set: EvalSet): Promise<EvalCase[]> => {
  const cases = await readJson<EvalCase[]>(rt, rt.path.join(dataDir, 'cases.json'), 'the case list');
  const split = await readJson<Record<EvalSet, string[]>>(rt, rt.path.join(dataDir, 'split.json'), 'the split');
  const ids = split[set];
  if (!Array.isArray(ids)) throw new EvalSetError('split.json has no list "' + set + '". It needs "dev" and "heldout".');
  return ids.map((id) => {
    const c = cases.find((x) => x.id === id);
    if (!c) throw new EvalSetError('split.json names case "' + id + '", which cases.json does not have.');
    return { ...c, video: rt.path.join(dataDir, c.video), materials: c.materials.map((m) => rt.path.join(dataDir, m)) };
  });
};
