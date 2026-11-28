/** File-bound evidence and portable replication sidecars. Legacy projects have no sidecar. */
import type { Runtime } from '../../runtime';
import { sha256, sha256File } from '../../core/util';
import type { Problem } from '../types';
import { error } from '../project/check-common';
import { isOutside } from '../project/check';
import { parseReplicationContract, REPLICATION_FILE, type ReplicationContract } from './contract';

export interface EvidenceFile { file: string; sha256: string }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Collect only typed file evidence, never interpret a URL or prose as an inspected media file. */
export const evidenceFiles = (value: unknown): EvidenceFile[] => {
  if (Array.isArray(value)) return value.flatMap(evidenceFiles);
  if (!object(value)) return [];
  const mine = typeof value.file === 'string' && typeof value.sha256 === 'string' ? [{ file: value.file, sha256: value.sha256 }] : [];
  return [...mine, ...Object.values(value).flatMap(evidenceFiles)];
};

export const evidenceProblems = async (rt: Runtime, root: string, value: unknown): Promise<Problem[]> => {
  const problems: Problem[] = [];
  const checked = new Set<string>();
  for (const e of evidenceFiles(value)) {
    const key = e.file + ':' + e.sha256;
    if (checked.has(key)) continue;
    checked.add(key);
    if (isOutside(e.file)) {
      problems.push(error('replication.evidence', 'Evidence must be a file inside the reference or project: ' + e.file, 'Copy the actual inspected file into the directory and record its SHA-256.'));
      continue;
    }
    const file = rt.path.join(root, e.file);
    const found = await rt.fs.stat(file);
    if (rt.fs.realpath && found) {
      const [base, actual] = await Promise.all([rt.fs.realpath(root), rt.fs.realpath(file)]);
      if (isOutside(rt.path.relative(base, actual))) {
        problems.push(error('replication.evidence', 'Evidence resolves outside the project: ' + e.file, 'Keep a real independent copy inside the project.'));
        continue;
      }
    }
    if (!found?.isFile) problems.push(error('replication.evidence', 'The evidence file is missing: ' + e.file, 'Keep the actual inspected frame, audio, video or source data with the project.'));
    else if (await sha256File(rt, file) !== e.sha256) problems.push(error('replication.evidence', 'The evidence changed after review: ' + e.file, 'Inspect its current contents and record a fresh review, rather than reusing the former verdict.'));
  }
  return problems;
};

export const readReplication = async (rt: Runtime, root: string): Promise<{ contract?: ReplicationContract; problems: Problem[] }> => {
  const file = rt.path.join(root, REPLICATION_FILE);
  if (!await rt.fs.stat(file)) return { problems: [] };
  try {
    const parsed = parseReplicationContract(JSON.parse(await rt.fs.readText(file)));
    return { ...parsed, problems: [...parsed.problems, ...await evidenceProblems(rt, root, parsed.contract)] };
  } catch (e) {
    return { problems: [error(REPLICATION_FILE, 'The replication contract could not be read: ' + (e instanceof Error ? e.message : String(e)), 'Correct the JSON; a malformed strict contract is never treated as a legacy project.')] };
  }
};

/** A copied template remains verifiable when the source directory moves or disappears. */
export const copyReplication = async (rt: Runtime, from: string, to: string): Promise<Problem[]> => {
  const read = await readReplication(rt, from);
  if (!read.contract || read.problems.some((p) => p.level === 'error')) return read.problems;
  if (rt.path.resolve(from) === rt.path.resolve(to)) return read.problems;
  const data: unknown = JSON.parse(JSON.stringify(read.contract));
  const copied = new Map<string, string>();
  const visit = async (value: unknown): Promise<void> => {
    if (Array.isArray(value)) { for (const child of value) await visit(child); return; }
    if (!object(value)) return;
    if (typeof value.file === 'string' && typeof value.sha256 === 'string') {
      const key = value.file + ':' + value.sha256;
      const previous = copied.get(key);
      if (previous) { value.file = previous; return; }
      const bytes = await rt.fs.readFile(rt.path.join(from, value.file));
      if (sha256(bytes) !== value.sha256) throw new Error('Evidence changed while copying: ' + value.file);
      const ext = rt.path.extname(value.file).replace(/[^.a-z0-9]/gi, '') || '.bin';
      const relative = 'replication-evidence/' + sha256(bytes) + ext;
      await rt.fs.writeFile(rt.path.join(to, relative), bytes);
      copied.set(key, relative);
      value.file = relative;
    }
    for (const child of Object.values(value)) await visit(child);
  };
  await visit(data);
  await rt.fs.writeFile(rt.path.join(to, REPLICATION_FILE), JSON.stringify(data, null, 2) + '\n');
  return read.problems;
};
