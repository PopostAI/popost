/**
 * The reference pictures of an image job. `reference --role …` registers a picture under `reference/<hash>.<ext>`; a
 * job names them by role (`--ref layout`, `--ref identity`, `--ref all`) instead of by those hash names, and a composition
 * job with no `--ref` takes the layout references plus the identity ones. A path that does not exist is an error that lists
 * what is registered, with the likely one when it is a typo.
 */
import type { Project } from '../core/project';
import { isFile } from '../core/util';
import { JobError } from './jobs';
import { msg } from '../i18n';

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
  const roles = `${REF_ROLES.join('|')}|${REF_ALL}`;
  const guess = close.length === 1 ? close[0]!.path : null;
  const registered = known.length
    ? msg(
        ` Registered references: ${listRefs(known)}.${guess ? ` Did you mean ${guess}?` : ''} Use one of these paths, or --ref ${roles}.`,
        `已登记的参考图：${listRefs(known)}。${guess ? `你是不是要用 ${guess}？` : ''}请用其中一个路径，或 --ref ${roles}。`,
      )
    : msg(
        ' No reference is registered; register one with: reference --dir <project> --file <image> --role layout.',
        '还没有登记任何参考图；请用 reference --dir <project> --file <image> --role layout 登记。',
      );
  return new JobError(msg(`reference file not found: ${given}.${registered}`, `找不到参考图文件：${given}。${registered}`));
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

const noRegistered = (token: string, role: string): string => {
  const kind = role === REF_ALL ? '' : `${role} `;
  const as = role === REF_ALL ? 'layout' : role;
  return msg(
    `--ref ${token}: no ${kind}reference is registered; register one with: reference --dir <project> --file <image> --role ${as}, or pass a file path.`,
    `--ref ${token}：还没有登记 ${kind}参考图；请用 reference --dir <project> --file <image> --role ${as} 登记一张，或直接给文件路径。`,
  );
};

const forRole = (project: Project, role: string, token: string | null): Candidate[] => {
  const matches = registeredReferences(project).filter((ref) => role === REF_ALL || ref.role === role);
  if (!matches.length && token)
    throw new JobError(noRegistered(token, role));
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
  const counts = roleCounts(registered);
  if (registered.length)
    notes.push(
      msg(
        `references: ${registered.length} registered (${counts})${given.length ? '' : ', the project defaults'}`,
        `参考图：已登记 ${registered.length} 张（${counts}）${given.length ? '' : '，项目默认'}`,
      ),
    );
  const files = dropped.map((c) => c.file).join(', ');
  if (dropped.length)
    notes.push(
      msg(
        `left out ${dropped.length} reference${dropped.length === 1 ? '' : 's'} because the model takes at most ${options.limit}: ${files}`,
        `模型最多接受 ${options.limit} 张，因此略去了 ${dropped.length} 张参考图：${files}`,
      ),
    );
  return { files: kept.map((c) => c.file), notes };
};
