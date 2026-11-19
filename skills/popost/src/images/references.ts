/**
 * The reference pictures of an image job. `reference --role …` registers a picture under `reference/<hash>.<ext>`; a
 * job names them by role (`--ref layout`, `--ref identity`, `--ref all`) instead of by those hash names, and a composition
 * job with no `--ref` takes the layout references plus the identity ones. A path that does not exist is an error that lists
 * what is registered, with the likely one when it is a typo.
 */
import type { Project } from '../core/project';
import { isFile } from '../core/util';
import { JobError } from './jobs';

export const REF_ROLES = ['layout', 'identity', 'style', 'content'] as const;
export const REF_ALL = 'all';
/** What a composition job takes when it is given no `--ref`. */
const DEFAULT_ROLES: readonly string[] = ['layout', 'identity'];

interface Registered {
  /** Project-relative, as `reference` printed it. */
  readonly path: string;
  readonly role: string;
}

/** Local reference pictures in the order they were registered (the generated composition reference is not one of them). */
export const registeredReferences = (project: Project): Registered[] =>
  project.manifest.sources
    .filter((source) => source.kind === 'local-reference' && typeof source.path === 'string')
    .map((source) => ({ path: source.path as string, role: String(source.role ?? 'layout') }));

const listRefs = (list: readonly Registered[]): string => list.map((ref) => `${ref.path} (${ref.role})`).join(', ');

const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length]!;
};

const unknownReference = (project: Project, given: string): JobError => {
  const { path } = project.rt;
  const stem = (file: string) => path.basename(file, path.extname(file));
  const known = registeredReferences(project);
  const close = known.filter((ref) => distance(stem(given), stem(ref.path)) <= 2);
  const registered = known.length
    ? ` Registered references: ${listRefs(known)}.${close.length === 1 ? ` Did you mean ${close[0]!.path}?` : ''} Use one of these paths, or --ref ${REF_ROLES.join('|')}|${REF_ALL}.`
    : ' No reference is registered; register one with: reference --dir <project> --file <image> --role layout.';
  return new JobError(`reference file not found: ${given}.${registered}`);
};

/** An explicit `--ref` path: as given when it exists from the working directory, else inside the project; stored as written. */
const explicitPath = async (project: Project, given: string): Promise<string> => {
  const { rt } = project;
  if (await isFile(rt, rt.path.resolve(rt.cwd, given))) return given;
  const inProject = rt.path.isAbsolute(given) ? null : project.abs(given);
  if (inProject && (await isFile(rt, inProject))) return inProject;
  throw unknownReference(project, given);
};

export interface RefOptions {
  /** A composition job with no `--ref` takes the layout and identity references. */
  readonly defaults: boolean;
  /** Most pictures the model takes; only the references a role stands for are cut to it, never a path the caller named. */
  readonly limit: number;
}

export interface RefChoice {
  readonly files: string[];
  readonly notes: string[];
}

interface Candidate {
  readonly file: string;
  readonly role?: string;
  readonly named: boolean;
}

const forRole = (project: Project, role: string, token: string | null): Candidate[] => {
  const matches = registeredReferences(project).filter((ref) => role === REF_ALL || ref.role === role);
  if (!matches.length && token)
    throw new JobError(`--ref ${token}: no ${role === REF_ALL ? '' : `${role} `}reference is registered; register one with: reference --dir <project> --file <image> --role ${role === REF_ALL ? 'layout' : role}, or pass a file path.`);
  return matches.map((ref) => ({ file: project.abs(ref.path), role: ref.role, named: false }));
};

/** Whether `given` leaves it to the registered references to fill the list (so the model's reference limit matters). */
export const usesRegistered = (project: Project, given: readonly string[], defaults: boolean): boolean =>
  given.length
    ? given.some((token) => token === REF_ALL || (REF_ROLES as readonly string[]).includes(token))
    : defaults && registeredReferences(project).some((ref) => DEFAULT_ROLES.includes(ref.role));

const candidatesFor = async (project: Project, given: readonly string[], options: RefOptions): Promise<Candidate[]> => {
  if (!given.length) return options.defaults ? DEFAULT_ROLES.flatMap((role) => forRole(project, role, null)) : [];
  const out: Candidate[] = [];
  for (const token of given) {
    if (token === REF_ALL || (REF_ROLES as readonly string[]).includes(token)) out.push(...forRole(project, token, token));
    else out.push({ file: await explicitPath(project, token), named: true });
  }
  return out;
};

/** Identity pictures are kept first when the model takes fewer than are registered: they carry what must stay recognisable. */
const withinLimit = (list: readonly Candidate[], limit: number): { kept: Candidate[]; dropped: Candidate[] } => {
  const room = Math.max(0, limit - list.filter((c) => c.named).length);
  const byPriority = [...list.filter((c) => !c.named)].sort((a, b) => Number(b.role === 'identity') - Number(a.role === 'identity'));
  const dropped = byPriority.slice(room);
  return { kept: list.filter((c) => !dropped.includes(c)), dropped };
};

const unique = (project: Project, list: readonly Candidate[]): Candidate[] => {
  const { rt } = project;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of list) {
    const key = rt.path.resolve(rt.cwd, candidate.file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
};

const roleCounts = (list: readonly Candidate[]): string => {
  const counts = new Map<string, number>();
  for (const c of list) if (c.role) counts.set(c.role, (counts.get(c.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => `${n} ${role}`).join(', ');
};

/** The reference files of a job, from what `--ref` said (paths, roles, `all`) or, for a composition job, from the defaults. */
export const resolveRefs = async (project: Project, given: readonly string[], options: RefOptions): Promise<RefChoice> => {
  const all = unique(project, await candidatesFor(project, given, options));
  const { kept, dropped } = withinLimit(all, options.limit);
  const notes: string[] = [];
  const registered = kept.filter((c) => !c.named);
  if (registered.length) notes.push(`references: ${registered.length} registered (${roleCounts(registered)})${given.length ? '' : ', the project defaults'}`);
  if (dropped.length) notes.push(`left out ${dropped.length} reference${dropped.length === 1 ? '' : 's'} because the model takes at most ${options.limit}: ${dropped.map((c) => c.file).join(', ')}`);
  return { files: kept.map((c) => c.file), notes };
};
