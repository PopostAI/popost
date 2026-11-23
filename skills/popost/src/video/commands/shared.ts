/**
 * What every `popost video` command shares: one way to declare a command, and one place that turns the failures a user
 * (or the model driving the CLI) can fix into `{"ok": false, "error": …}` with exit code 2. Anything else is a bug and
 * is left to the generic handler in `main.ts` (exit code 1).
 */
import type { OptionSpec, ParsedArgs, PositionalSpec } from '../../args';
import { fail } from '../../core/util';
import { BrowserUnavailableError } from '../../render/browser';
import type { Runtime } from '../../runtime';
import { failureText, isExpectedFailure } from '../../workflow/errors';
import type { Subcommand } from '../../workflow/subcommands';
import { VideoUnavailableError } from '../host';
import { FfmpegError } from '../media/ffmpeg';

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

export const command = (
  description: string,
  spec: { positionals?: readonly PositionalSpec[]; options?: readonly OptionSpec[] },
  body: Body,
): Subcommand => ({
  spec: { description, ...spec },
  run: async (args, rt) => {
    try {
      return (await body(args, rt)) ?? 0;
    } catch (error) {
      if (!expected(error)) throw error;
      return fail(rt, failureText(error));
    }
  },
});

/** A path the user typed, against the working directory. */
export const userPath = (rt: Runtime, p: string): string => rt.path.resolve(rt.cwd, p);
