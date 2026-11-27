/**
 * What every `popost video` command shares: one way to declare a command, and one place that turns the failures a user
 * (or the model driving the CLI) can fix into `{"ok": false, "error": …}` with exit code 2. Anything else is a bug and
 * is left to the generic handler in `main.ts` (exit code 1).
 */
import type { OptionSpec, ParsedArgs, PositionalSpec } from '../../args';
import { fail, printJson } from '../../core/util';
import { BrowserUnavailableError } from '../../render/browser';
import { inProject } from '../../providers/task';
import type { Runtime } from '../../runtime';
import { failureText, isExpectedFailure } from '../../workflow/errors';
import type { Subcommand } from '../../workflow/subcommands';
import { VideoUnavailableError } from '../host';
import { FfmpegError } from '../media/ffmpeg';
import { CONFIRM_EXIT, PriceNotAgreed } from '../wallet';

/** A command's body: prints its JSON itself and returns the exit code (nothing returned means 0). */
export type Body = (args: ParsedArgs, rt: Runtime) => Promise<number | void>;

/** A named set of commands, e.g. the `check` and `write` of `popost video scene`. */
export type Commands = Readonly<Record<string, Subcommand>>;

/** A failure with a message for the user, raised from anywhere in a command: reported with exit code 2. */
export class VideoCommandError extends Error {
  override name = 'VideoCommandError';
}

const expected = (error: unknown): boolean =>
  error instanceof VideoCommandError || error instanceof VideoUnavailableError || error instanceof BrowserUnavailableError || error instanceof FfmpegError || isExpectedFailure(error);

/**
 * A command. projectOf: the video project it works in, from its arguments; its popost.ai requests then carry the
 * project's task, so that the charges of the video are grouped on the account page (providers/task.ts).
 */
export const command = (
  description: string,
  spec: { positionals?: readonly PositionalSpec[]; options?: readonly OptionSpec[] },
  body: Body,
  projectOf?: (args: ParsedArgs) => string | undefined,
): Subcommand => ({
  spec: { description, ...spec },
  run: async (args, rt) => {
    const project = projectOf?.(args);
    try {
      return (await body(args, project ? inProject(rt, project, 'video') : rt)) ?? 0;
    } catch (error) {
      // The price of popost.ai speech or transcription, for the user's agreement: nothing was charged.
      if (error instanceof PriceNotAgreed) {
        printJson(rt, { ok: false, confirm: error.confirm, next: error.next });
        return CONFIRM_EXIT;
      }
      if (!expected(error)) throw error;
      return fail(rt, failureText(error));
    }
  },
});

/** --project of the commands that may pay before the project has files of its own (describe, transcript, voice create). */
export const PROJECT_OPTION: OptionSpec = { flag: '--project', metavar: 'DIR', help: 'the video project this is for: what popost.ai charges for it joins the project\'s line on the account page' };

/** A path the user typed, against the working directory. */
export const userPath = (rt: Runtime, p: string): string => rt.path.resolve(rt.cwd, p);
