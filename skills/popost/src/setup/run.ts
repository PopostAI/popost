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
  { name: 'quote', wanted: (ctx) => ctx.spec.images.length > 0, run: (ctx) => (ctx.spec.quote === false ? Promise.resolve(skipped('"quote" is false in the spec')) : quoteStep(ctx)) },
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
  const document = { ok: false, failedStep: step, error: message, steps, ...warned(warnings), next: 'fix the cause and run the same popost setup command again: the steps listed above are skipped' };
  return { document, code };
};

/** What to do after the setup, in words: nothing is generated or charged until the user has confirmed. */
const nextText = (ctx: SetupContext): string => {
  const { quotes, totalAmount, billingUnit, hostJobs } = ctx.outcome;
  const dir = ctx.dir;
  if (!ctx.spec.images.length) return `Write the pages (one complete HTML file per page), then popost render --dir ${dir} --page all.`;
  const parts: string[] = [];
  if (quotes.length)
    parts.push(
      `Show the plan and cost (${totalAmount ?? 'unknown'} ${billingUnit ?? 'units unknown'}). Obtain fee authorization unless a valid existing account/scope/budget agreement covers this stage; do not run images without it. ` +
        `Then start the pictures with popost image run --dir ${dir} --quote-id ${quotes.map(row => row.quoteId).join(',')} --confirm (start it in the background when your host can) and write the pages while they generate; ` +
        'wait for the job only right before the first render, then register each result with popost image complete.',
    );
  if (hostJobs.length)
    parts.push(`Generate ${hostJobs.join(', ')} with the host image tool from production/jobs/<id>.json (prompt, aspect, references), then register each with popost image complete --tool <that tool>; write the pages meanwhile.`);
  if (!parts.length) parts.push(`Price the jobs with popost image quote --dir ${dir} --all, then continue as above.`);
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
      if (ctx.rt.signal?.aborted) throw new StepFailure('cancelled by the host before this step', 1);
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
    if (error instanceof SyntaxError) return { error: `${specPath} is not valid JSON (${error.message})` };
    if (error instanceof OsError) return { error: error.message };
    throw error;
  }
};

export const runSetup = async (rt: Runtime, call: SetupCall): Promise<SetupResult> => {
  const loaded = await loadSpec(rt, call.specPath);
  if ('error' in loaded) return refused(loaded.error);
  const { spec, problems: shape, unusable } = parseSpec(loaded.raw);
  if (unusable) return refused(`the spec has ${shape.length} problem; nothing was changed`, { problems: shape });
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
  if (problems.length) return refused(`the spec has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was changed. Fix them all, then run the same command again`, { problems });
  return execute(ctx);
};
