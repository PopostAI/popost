/**
 * `image prepare`: writes `production/jobs/<id>.json`, the request that `quote` prices and `run` submits. Reference files
 * are bound by content hash: a changed reference stops the quote.
 *
 * A job that was never quoted or run is only a draft, so preparing it again replaces it (and says so). Once it has been
 * quoted or run it is never replaced: the quote is bound to its request and a run may have charged, so the refusal says
 * what to do with that job instead.
 *
 * The one composition job defaults from the project: its picture ratio suits the grid of pages the composition prompt asks
 * for (composition-grid.ts) and the model, and its references are the project's layout and identity references.
 */
import { isObject } from '../core/pyjson';
import type { Project } from '../core/project';
import { sha256File } from '../core/util';
import { describeGrid, planSheet, type Grid } from '../workflow/composition-grid';
import { MAX_REFERENCE_IMAGES } from '../providers/popost-validate';
import * as ledger from '../providers/ledger';
import { modelLimits, type ModelLimits } from './capabilities';
import { JOB_ID, jobFile, jobState, JobError, loadJob, saveJob, type Job, type JobProvider } from './jobs';
import { resolveRefs, usesRegistered } from './references';
import { ledgerPathOf, refusedUncharged } from './retry';

export interface PrepareCall {
  readonly id: string;
  readonly promptFile: string;
  readonly purpose: string;
  readonly refs: readonly string[];
  readonly aspect?: string;
  readonly config?: string;
}

export interface Prepared {
  readonly path: string;
  readonly job: Job;
  /** The job of an earlier `prepare` that was replaced. */
  readonly replaced: boolean;
  /** What was decided for the caller (aspect, references), one line each. */
  readonly notes: readonly string[];
}

const compositionId = (project: Project): string => {
  if (project.manifest.mode === 'strict') throw new JobError('supplied target is the reproduction reference');
  if (project.manifest.sources.some((s) => s.kind === 'composition')) throw new JobError('reuse existing composition reference');
  return 'composition'; // one composition job per project, whatever id was asked for
};

/** What to do with a job that cannot be prepared again, by how far it got; `spent`: its quote was run and refused without a charge. */
const refusal = (project: Project, id: string, job: Job, spent: boolean): JobError => {
  const dir = project.root;
  const state = jobState(job);
  if (state === 'completed') return new JobError(`job '${id}' is complete (its picture is registered as ${String((job.asset as { path?: string } | undefined)?.path ?? 'a project asset')}); reuse that asset instead of preparing the job again`);
  if (state === 'submitted')
    return new JobError(
      `job '${id}' was already submitted, so it is never replaced or sent twice. ` +
        (job.status === 'generated'
          ? `Its picture is in production/results/${id}: register it with image complete --dir ${dir} --id ${id} --file <that picture> --note "<what you saw>".`
          : `Look at it with image status --dir ${dir} --id ${id}. If its outcome is unknown, retry only with image quote --dir ${dir} --id ${id}, then image run --dir ${dir} --id ${id} --quote-id <new quote> --confirm (the original key is reused, the platform charges once).`),
    );
  if (spent)
    return new JobError(
      `job '${id}' was quoted (quote ${String(job.quoteId)}) but its run was refused without a charge, so that quote cannot be run again; the job is not replaced: the quote was bound to its prompt, aspect and references. ` +
        `Price it again with image quote --dir ${dir} --id ${id}, then image run --dir ${dir} --id ${id} --quote-id <new quote> --confirm. ` +
        `To change the request instead, remove production/jobs/${id}.json (nothing was charged) and prepare again.`,
    );
  return new JobError(
    `job '${id}' is already quoted (quote ${String(job.quoteId)}) and is not replaced: the quote is bound to its prompt, aspect and references. ` +
      `Run it with image run --dir ${dir} --id ${id} --quote-id ${String(job.quoteId)} --confirm once the user authorized the cost, or re-price it unchanged with image quote --dir ${dir} --id ${id}. ` +
      `To change the request instead, the quote must be discarded; that is safe only while production/ledger.jsonl has no record of quote ${String(job.quoteId)} (nothing was submitted): then remove production/jobs/${id}.json and prepare again.`,
  );
};

/** Whether `path` holds a draft job that this `prepare` replaces; throws for a job that already cost something. */
const replacesDraft = async (project: Project, path: string, id: string): Promise<boolean> => {
  if ((await project.rt.fs.stat(path)) === null) return false;
  let job: Job;
  try {
    job = await loadJob(project.rt, path);
  } catch (error) {
    throw new JobError(`job '${id}' exists but ${path} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove that file`);
  }
  if (jobState(job) === 'prepared') return true;
  const attempt = job.quoteId ? await ledger.attempt(project.rt, ledgerPathOf(project), job.quoteId) : null;
  throw refusal(project, id, job, attempt !== null && refusedUncharged(attempt));
};

/** The sheet grid `series prompt` recorded, when it still holds every page. */
const recordedGrid = (project: Project): Grid | undefined => {
  const { grid } = project.manifest.concept;
  if (!isObject(grid) || typeof grid.columns !== 'number' || typeof grid.rows !== 'number') return undefined;
  return grid.columns > 0 && grid.rows > 0 && grid.columns * grid.rows >= project.manifest.pages.length ? { columns: grid.columns, rows: grid.rows } : undefined;
};

const percent = (fill: number): string => `${Math.round(fill * 100)}%`;

/** The picture ratio of the composition sheet: the one `series prompt` designed the grid for, or the closest the model makes. */
const compositionAspect = (project: Project, limits: ModelLimits): { aspect: string; notes: string[] } => {
  const pages = project.manifest.pages;
  const grid = recordedGrid(project);
  const designed = typeof project.manifest.concept.aspect === 'string' ? project.manifest.concept.aspect : undefined;
  const plan = planSheet(pages, { aspects: limits.aspects, grid });
  const designedFits = designed !== undefined && (!limits.aspects || limits.aspects.includes(designed));
  const aspect = grid && designedFits ? designed : plan.aspect;
  const notes = [`aspect ${aspect}: ${describeGrid(plan)} of ${plan.pageAspect} pages`];
  if (grid && designed && !designedFits) notes.push(`the model makes ${(limits.aspects ?? []).join(', ')}, not the ${designed} the prompt was designed for; ${aspect} is the closest fit for that grid`);
  const best = planSheet(pages, { aspects: limits.aspects });
  if (grid && (best.columns !== grid.columns || best.rows !== grid.rows) && best.fill - plan.fill >= 0.15)
    notes.push(`for this model ${describeGrid(best)} at ${best.aspect} would show the pages larger (${percent(best.fill)} of the picture instead of ${percent(plan.fill)}): series prompt --dir ${project.root} --aspect ${best.aspect}, then prepare again`);
  return { aspect, notes };
};

/** The model's limits are read only when they decide something: the composition's ratio, or how many registered references fit. */
const needsLimits = (project: Project, call: PrepareCall, composition: boolean): boolean =>
  (composition && !call.aspect) || usesRegistered(project, call.refs, composition);

/** Where a `prepare` call writes its job, after the id has been checked: the composition job has the one fixed id. */
export interface JobTarget {
  readonly id: string;
  readonly path: string;
  readonly composition: boolean;
}

const jobTarget = (project: Project, call: PrepareCall): JobTarget => {
  if (!JOB_ID.test(call.id)) throw new JobError('invalid job id');
  if (call.purpose !== 'composition' && call.id === 'composition') throw new JobError('composition id is reserved');
  const composition = call.purpose === 'composition';
  const id = composition ? compositionId(project) : call.id;
  return { id, path: jobFile(project, id), composition };
};

/** The job a `prepare` call asks for, and what was decided for the caller; nothing is written. */
export const draftJob = async (project: Project, call: PrepareCall, target: JobTarget): Promise<{ job: Job; notes: string[] }> => {
  const { rt } = project;
  const { id, composition } = target;
  const prompt = await rt.fs.readText(rt.path.resolve(rt.cwd, call.promptFile));
  const provider = (project.manifest.provider ?? { channel: 'official' }) as JobProvider;
  const asked = needsLimits(project, call, composition);
  const limits: ModelLimits = asked ? await modelLimits(project, provider, call.config) : { maxReferenceImages: MAX_REFERENCE_IMAGES };
  const refs = await resolveRefs(project, call.refs, { defaults: composition, limit: limits.maxReferenceImages });
  const shape = composition && !call.aspect ? compositionAspect(project, limits) : undefined;
  const job: Job = { id, purpose: call.purpose, count: 1, provider, prompt, refs: refs.files, status: 'prepared', aspect: call.aspect ?? shape?.aspect ?? '9:16', refHashes: {} };
  for (const file of job.refs) job.refHashes[rt.path.resolve(rt.cwd, file)] = await sha256File(rt, rt.path.resolve(rt.cwd, file));
  const unavailable = limits.unavailable && asked ? [`the model's limits could not be read (${limits.unavailable}); used the common picture ratios, quote checks the request`] : [];
  return { job, notes: [...refs.notes, ...(shape?.notes ?? []), ...unavailable] };
};

/** Whether two jobs ask for the same picture: same prompt, purpose, ratio, channel and model, and the same reference pictures (by content). */
export const sameRequest = (project: Project, a: Job, b: Job): boolean => {
  const { rt } = project;
  const pictures = (job: Job): string[] => job.refs.map((file) => job.refHashes[rt.path.resolve(rt.cwd, file)] ?? file);
  return (
    a.prompt === b.prompt &&
    a.purpose === b.purpose &&
    a.aspect === b.aspect &&
    a.provider.channel === b.provider.channel &&
    (a.provider.model ?? null) === (b.provider.model ?? null) &&
    JSON.stringify(pictures(a)) === JSON.stringify(pictures(b))
  );
};

export const prepareJob = async (project: Project, call: PrepareCall): Promise<Prepared> => {
  const target = jobTarget(project, call);
  const replaced = await replacesDraft(project, target.path, target.id);
  const { job, notes } = await draftJob(project, call, target);
  await saveJob(project.rt, target.path, job);
  return { path: target.path, job, replaced, notes: [...(replaced ? [`replaced the earlier prepared job '${target.id}' (it had no quote and no run)`] : []), ...notes] };
};
