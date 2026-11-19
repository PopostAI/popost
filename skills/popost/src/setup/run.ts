/**
 * `popost setup`: the deterministic setup of a project from one spec. The whole spec is checked first (every problem at
 * once, nothing changed); then the steps run in a fixed order and stop at the first one that fails, so that the same spec
 * can simply be run again after a fix: finished steps find their work done and skip it.
 */
import { KeyError, OsError, ValueError } from '../core/errors';
import { ImageError } from '../core/image';
import { ProjectError } from '../core/project';
import { errorText } from '../core/util';
import { FontError } from '../fonts/palette';
import { isOsError, JobError } from '../images/jobs';
import type { Runtime } from '../runtime';
import { failureText } from '../workflow/errors';
import { readUserText } from '../workflow/io';
import { checkSpec, openProject } from './check';
import type { SetupContext } from './context';
import { quoteStep } from './quote';
import { parseSpec } from './spec';
import { msg } from '../i18n';
import { fontsStep, imagesStep, initStep, pagesStep, planStep, referencesStep, settingsStep, skipped, StepFailure, type StepResult } from './steps';

export interface SetupCall {
  readonly dir: string;
  readonly specPath: string;
  readonly config?: string;
  readonly acceptUnknownCost: boolean;
}

export interface SetupResult {
  readonly document: Record<string, unknown>;
  readonly code: number;
}

interface Step {
  readonly name: string;
  readonly wanted: (ctx: SetupContext) => boolean;
  readonly run: (ctx: SetupContext) => Promise<StepResult>;
}

const STEPS: readonly Step[] = [
  { name: 'init', wanted: () => true, run: initStep },
  { name: 'settings', wanted: (ctx) => ctx.spec.settings !== undefined, run: settingsStep },
  { name: 'pages', wanted: (ctx) => ctx.spec.pages !== undefined, run: pagesStep },
  { name: 'references', wanted: (ctx) => ctx.spec.references.length > 0, run: referencesStep },
  { name: 'fonts', wanted: (ctx) => ctx.spec.fonts.length > 0, run: fontsStep },
  { name: 'plan', wanted: (ctx) => ctx.spec.plan !== undefined, run: planStep },
  { name: 'images', wanted: (ctx) => ctx.spec.images.length > 0, run: imagesStep },
  { name: 'quote', wanted: (ctx) => ctx.spec.images.length > 0, run: (ctx) => (ctx.spec.quote === false ? Promise.resolve(skipped(msg('"quote" is false in the spec', 'spec 里 "quote" 为 false'))) : quoteStep(ctx)) },
];

const refused = (error: string, extra: Record<string, unknown> = {}): SetupResult => ({ document: { ok: false, error, ...extra }, code: 2 });

/** Input the caller can fix (exit 2); anything else is a bug of the CLI or its environment (exit 1). */
const isInputError = (error: unknown): boolean =>
  error instanceof StepFailure || error instanceof JobError || error instanceof ProjectError || error instanceof FontError || error instanceof ValueError || error instanceof KeyError || error instanceof OsError || error instanceof ImageError || error instanceof SyntaxError || isOsError(error);

/** Warnings of the steps that ran, as one list at the top of the document (nothing when there are none). */
const warned = (warnings: readonly string[]): { warnings?: readonly string[] } => (warnings.length ? { warnings } : {});

const failed = (step: string, error: unknown, steps: readonly unknown[], warnings: readonly string[]): SetupResult => {
  const message = error instanceof StepFailure ? error.message : isInputError(error) ? failureText(error) : errorText(error);
  const code = error instanceof StepFailure ? error.code : isInputError(error) ? 2 : 1;
  const document = { ok: false, failedStep: step, error: message, steps, ...warned(warnings), next: msg(
      'fix the cause and run the same popost setup command again: the steps listed above are skipped',
      '解决原因后再运行同一条 popost setup 命令：上面列出的已完成步骤会跳过',
    ),
  };
  return { document, code };
};

/** The next step once the jobs are quoted: authorization first, then the run in the background while the pages are written. */
const runNext = (dir: string, quoteIds: string, cost: string): string =>
  msg(
    `Show the plan and cost (${cost}). Obtain fee authorization unless a valid existing account/scope/budget agreement covers this stage; do not run images without it. ` +
      `Then start the pictures with popost image run --dir ${dir} --quote-id ${quoteIds} --confirm (start it in the background when your host can) and write the pages while they generate; ` +
      'wait for the job only right before the first render, then register each result with popost image complete.',
    `向用户展示方案和费用（${cost}）。除非已有有效的账号/范围/预算约定覆盖这一阶段，否则先取得付费授权；没有授权不要生成图片。` +
      `然后用 popost image run --dir ${dir} --quote-id ${quoteIds} --confirm 开始生图（宿主支持时放到后台运行），生图期间写页面；` +
      '直到第一次渲染前才等待任务完成，再用 popost image complete 逐个登记结果。',
  );

/** What to do after the setup, in words: nothing is generated or charged until the user has confirmed. */
const nextText = (ctx: SetupContext): string => {
  const { quotes, totalAmount, billingUnit, hostJobs } = ctx.outcome;
  const dir = ctx.dir;
  if (!ctx.spec.images.length)
    return msg(
      `Write the pages (one complete HTML file per page), then popost render --dir ${dir} --page all.`,
      `写好各页（每页一个完整的 HTML 文件），然后运行 popost render --dir ${dir} --page all。`,
    );
  const parts: string[] = [];
  if (quotes.length) parts.push(runNext(dir, quotes.map((row) => row.quoteId).join(','), `${totalAmount ?? msg('unknown', '未知')} ${billingUnit ?? msg('units unknown', '单位未知')}`));
  if (hostJobs.length)
    parts.push(
      msg(
        `Generate ${hostJobs.join(', ')} with the host image tool from production/jobs/<id>.json (prompt, aspect, references), then register each with popost image complete --tool <that tool>; write the pages meanwhile.`,
        `用宿主的图片工具按 production/jobs/<id>.json（prompt、比例、参考图）生成 ${hostJobs.join(', ')}，再用 popost image complete --tool <该工具> 逐个登记；同时写页面。`,
      ),
    );
  if (!parts.length)
    parts.push(
      msg(
        `Price the jobs with popost image quote --dir ${dir} --all, then continue as above.`,
        `用 popost image quote --dir ${dir} --all 给任务报价，然后按上面的步骤继续。`,
      ),
    );
  return parts.join(' ');
};

const succeeded = (ctx: SetupContext, steps: readonly unknown[], warnings: readonly string[]): SetupResult => {
  const { quotes, totalCredits, totalAmount, billingUnit, balance } = ctx.outcome;
  const priced = quotes.length ? { quotes, totalCredits, totalAmount, billingUnit, ...(balance === null ? {} : { balance }) } : {};
  return { document: { ok: true, steps, ...warned(warnings), ...priced, next: nextText(ctx) }, code: 0 };
};

const execute = async (ctx: SetupContext): Promise<SetupResult> => {
  const steps: unknown[] = [];
  const warnings: string[] = [];
  for (const step of STEPS.filter((candidate) => candidate.wanted(ctx))) {
    try {
      if (ctx.rt.signal?.aborted) throw new StepFailure(msg('cancelled by the host before this step', '宿主在这一步之前取消了'), 1);
      const { warnings: raised = [], ...result } = await step.run(ctx);
      warnings.push(...raised);
      steps.push({ step: step.name, ...result });
    } catch (error) {
      return failed(step.name, error, steps, warnings);
    }
  }
  return succeeded(ctx, steps, warnings);
};

const loadSpec = async (rt: Runtime, specPath: string): Promise<{ raw: unknown } | { error: string }> => {
  try {
    return { raw: JSON.parse(await readUserText(rt, specPath)) };
  } catch (error) {
    if (error instanceof SyntaxError)
      return { error: msg(`${specPath} is not valid JSON (${error.message})`, `${specPath} 不是合法的 JSON（${error.message}）`) };
    if (error instanceof OsError) return { error: error.message };
    throw error;
  }
};

export const runSetup = async (rt: Runtime, call: SetupCall): Promise<SetupResult> => {
  const loaded = await loadSpec(rt, call.specPath);
  if ('error' in loaded) return refused(loaded.error);
  const { spec, problems: shape, unusable } = parseSpec(loaded.raw);
  if (unusable)
    return refused(msg(`the spec has ${shape.length} problem; nothing was changed`, `spec 有 ${shape.length} 个问题；未做任何改动`), {
      problems: shape,
    });
  const opened = await openProject(rt, call.dir);
  const ctx: SetupContext = {
    rt,
    spec,
    dir: call.dir,
    specDir: rt.path.dirname(rt.path.resolve(rt.cwd, call.specPath)),
    config: call.config,
    acceptUnknownCost: call.acceptUnknownCost,
    project: opened.project,
    outcome: { quotes: [], totalCredits: null, totalAmount: null, billingUnit: null, balance: null, hostJobs: [] },
  };
  const problems = [...shape, ...(await checkSpec(ctx, opened))];
  if (problems.length) {
    const count = problems.length;
    const text = msg(
      `the spec has ${count} problem${count === 1 ? '' : 's'}; nothing was changed. Fix them all, then run the same command again`,
      `spec 有 ${count} 个问题；未做任何改动。全部改好后再运行同一条命令`,
    );
    return refused(text, { problems });
  }
  return execute(ctx);
};
