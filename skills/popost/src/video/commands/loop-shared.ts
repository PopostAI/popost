/**
 * What the loop's commands (template, plan, materials, retarget, readback, look, eval) share: the failures of their
 * library code that the caller can fix, reported as `{"ok": false, "error": …}` with exit code 2.
 */
import type { OptionSpec, ParsedArgs } from '../../args';
import { EvalSetError } from '../eval/dataset';
import { tempoCapProblem } from '../retarget/tempo';
import { TemplateError } from '../template/save';
import { VideoCommandError, type Body } from './shared';

/** A template that cannot be read, an evaluation set that cannot be found: the message says what to do. */
/** --fit-tempo of the spoken commands: retarget --speak, plan, template fill --speak and template check. */
export const FIT_TEMPO: OptionSpec = {
  flag: '--fit-tempo', kind: 'number', metavar: 'MAX',
  help: 'with a voice: a line that would run over its beat is sped up, pitch kept, by at most this much (1.12 is hardly heard); what is still over re-flows',
};

/** The cap --fit-tempo gives, or undefined when it is not given or is 1; a cap out of range is refused. */
export const fitTempoOf = (args: ParsedArgs): number | undefined => {
  const max = args.number('fit-tempo');
  if (max === undefined) return undefined;
  const problem = tempoCapProblem(max);
  if (problem) throw new VideoCommandError(problem);
  return max > 1 ? max : undefined;
};

export const looping = (body: Body): Body => async (args, rt) => {
  try {
    return await body(args, rt);
  } catch (error) {
    if (error instanceof TemplateError || error instanceof EvalSetError) throw new VideoCommandError(error.message);
    throw error;
  }
};
