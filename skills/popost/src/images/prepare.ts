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
import { msg } from '../i18n';
import { errorText } from '../core/error-text';

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
  if (project.manifest.mode === 'strict') throw new JobError(msg('supplied target is the reproduction reference', 'strict 项目以提供的参考图为复刻目标，不需要 composition'));
  if (project.manifest.sources.some((s) => s.kind === 'composition')) throw new JobError(msg('reuse existing composition reference', '已有 composition 参考图，请复用它'));
  return 'composition'; // one composition job per project, whatever id was asked for
};

/** What to do with a job that cannot be prepared again, by how far it got; `spent`: its quote was run and refused without a charge. */
const refusal = (project: Project, id: string, job: Job, spent: boolean): JobError => {
  const dir = project.root;
  const state = jobState(job);
  if (state === 'completed') {
    const asset = (job.asset as { path?: string } | undefined)?.path ?? msg('a project asset', '项目素材');
    return new JobError(
      msg(
        `job '${id}' is complete (its picture is registered as ${asset}); reuse that asset instead of preparing the job again`,
        `任务 '${id}' 已完成（图片已登记为 ${asset}）；请复用这份素材，不要重新准备任务`,
      ),
    );
  }
  if (state === 'submitted') return new JobError(submittedText(dir, id, job.status === 'generated'));
  return new JobError(spent ? spentText(dir, id, String(job.quoteId)) : quotedText(dir, id, String(job.quoteId)));
};

const submittedText = (dir: string, id: string, generated: boolean): string =>
  msg(
    `job '${id}' was already submitted, so it is never replaced or sent twice. ` +
      (generated
        ? `Its picture is in production/results/${id}: register it with image complete --dir ${dir} --id ${id} --file <that picture> --note "<what you saw>".`
        : `Look at it with image status --dir ${dir} --id ${id}. If its outcome is unknown, retry only with image quote --dir ${dir} --id ${id}, then image run --dir ${dir} --id ${id} --quote-id <new quote> --confirm (the original key is reused, the platform charges once).`),
    `任务 '${id}' 已经提交过，因此永远不会被替换或重复发送。` +
      (generated
        ? `它的图片在 production/results/${id}：用 image complete --dir ${dir} --id ${id} --file <那张图片> --note "<你看到的内容>" 登记。`
        : `用 image status --dir ${dir} --id ${id} 查看。结果不明时，只能先 image quote --dir ${dir} --id ${id}，再 image run --dir ${dir} --id ${id} --quote-id <新报价> --confirm 重试（沿用原来的幂等键，平台只扣一次费）。`),
  );

const spentText = (dir: string, id: string, quoteId: string): string =>
  msg(
    `job '${id}' was quoted (quote ${quoteId}) but its run was refused without a charge, so that quote cannot be run again; the job is not replaced: the quote was bound to its prompt, aspect and references. ` +
      `Price it again with image quote --dir ${dir} --id ${id}, then image run --dir ${dir} --id ${id} --quote-id <new quote> --confirm. ` +
      `To change the request instead, remove production/jobs/${id}.json (nothing was charged) and prepare again.`,
    `任务 '${id}' 已报价（报价 ${quoteId}），但运行被拒绝且未扣费，所以这个报价不能再运行；任务不会被替换：报价绑定了它的 prompt、比例和参考图。` +
      `请用 image quote --dir ${dir} --id ${id} 重新报价，再运行 image run --dir ${dir} --id ${id} --quote-id <新报价> --confirm。` +
      `如果要改请求，删掉 production/jobs/${id}.json（未扣费）后重新 prepare。`,
  );

const quotedText = (dir: string, id: string, quoteId: string): string =>
  msg(
    `job '${id}' is already quoted (quote ${quoteId}) and is not replaced: the quote is bound to its prompt, aspect and references. ` +
      `Run it with image run --dir ${dir} --id ${id} --quote-id ${quoteId} --confirm once the user authorized the cost, or re-price it unchanged with image quote --dir ${dir} --id ${id}. ` +
      `To change the request instead, the quote must be discarded; that is safe only while production/ledger.jsonl has no record of quote ${quoteId} (nothing was submitted): then remove production/jobs/${id}.json and prepare again.`,
    `任务 '${id}' 已报价（报价 ${quoteId}），不会被替换：报价绑定了它的 prompt、比例和参考图。` +
      `用户授权费用后，用 image run --dir ${dir} --id ${id} --quote-id ${quoteId} --confirm 运行；或用 image quote --dir ${dir} --id ${id} 原样重新报价。` +
      `如果要改请求，必须放弃这个报价；只有当 production/ledger.jsonl 里没有报价 ${quoteId} 的记录（未提交任何内容）时才安全：这时删掉 production/jobs/${id}.json 后重新 prepare。`,
  );

/** Whether `path` holds a draft job that this `prepare` replaces; throws for a job that already cost something. */
const replacesDraft = async (project: Project, path: string, id: string): Promise<boolean> => {
  if ((await project.rt.fs.stat(path)) === null) return false;
  let job: Job;
  try {
    job = await loadJob(project.rt, path);
  } catch (error) {
    throw new JobError(
      msg(
        `job '${id}' exists but ${path} cannot be read (${errorText(error)}); fix or remove that file`,
        `任务 '${id}' 已存在，但 ${path} 无法读取（${errorText(error)}）；请修复或删除这个文件`,
      ),
    );
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
const gridText = (grid: { columns: number; rows: number }): string => `${grid.columns} 列 ${grid.rows} 行`;

/** The picture ratio of the composition sheet: the one `series prompt` designed the grid for, or the closest the model makes. */
const compositionAspect = (project: Project, limits: ModelLimits): { aspect: string; notes: string[] } => {
  const pages = project.manifest.pages;
  const grid = recordedGrid(project);
  const designed = typeof project.manifest.concept.aspect === 'string' ? project.manifest.concept.aspect : undefined;
  const plan = planSheet(pages, { aspects: limits.aspects, grid });
  const designedFits = designed !== undefined && (!limits.aspects || limits.aspects.includes(designed));
  const aspect = grid && designedFits ? designed : plan.aspect;
  const notes = [msg(`aspect ${aspect}: ${describeGrid(plan)} of ${plan.pageAspect} pages`, `比例 ${aspect}：${gridText(plan)}，每页 ${plan.pageAspect}`)];
  if (grid && designed && !designedFits) {
    const made = (limits.aspects ?? []).join(', ');
    notes.push(
      msg(
        `the model makes ${made}, not the ${designed} the prompt was designed for; ${aspect} is the closest fit for that grid`,
        `模型支持 ${made}，不支持 prompt 设计时用的 ${designed}；${aspect} 是最贴近这个网格的比例`,
      ),
    );
  }
  const best = planSheet(pages, { aspects: limits.aspects });
  if (grid && (best.columns !== grid.columns || best.rows !== grid.rows) && best.fill - plan.fill >= 0.15)
    notes.push(
      msg(
        `for this model ${describeGrid(best)} at ${best.aspect} would show the pages larger (${percent(best.fill)} of the picture instead of ${percent(plan.fill)}): series prompt --dir ${project.root} --aspect ${best.aspect}, then prepare again`,
        `对这个模型，${best.aspect} 下用${gridText(best)}能把页面显示得更大（占图片的 ${percent(best.fill)}，而不是 ${percent(plan.fill)}）：运行 series prompt --dir ${project.root} --aspect ${best.aspect}，再重新 prepare`,
      ),
    );
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
  if (!JOB_ID.test(call.id)) throw new JobError(msg(`invalid job id: ${call.id}`, `无效的任务 id：${call.id}`));
  if (call.purpose !== 'composition' && call.id === 'composition') throw new JobError(msg('composition id is reserved', 'composition 这个 id 保留给 composition 任务'));
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
  const unavailable =
    limits.unavailable && asked
      ? [
          msg(
            `the model's limits could not be read (${limits.unavailable}); used the common picture ratios, quote checks the request`,
            `无法读取模型的限制（${limits.unavailable}）；已按常用图片比例处理，报价时会校验请求`,
          ),
        ]
      : [];
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
  return { path: target.path, job, replaced, notes: [...(replaced ? [msg(`replaced the earlier prepared job '${target.id}' (it had no quote and no run)`, `已替换之前准备的任务 '${target.id}'（它没有报价，也没运行过）`)] : []), ...notes] };
};
