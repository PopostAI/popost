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

/** A title for the task of a video project that has none yet, from what a command reads (titleOf). */
export type TitleOf = (args: ParsedArgs, rt: Runtime) => Promise<string | undefined> | string | undefined;

/**
 * A command. projectOf: the video project it works in, from its arguments; its popost.ai requests then carry the
 * project's task, so that the charges of the video are grouped on the account page (providers/task.ts). titleOf: what
 * the command is about, the task's title while the project has none.
 */
export const command = (
  description: string,
  spec: { positionals?: readonly PositionalSpec[]; options?: readonly OptionSpec[] },
  body: Body,
  projectOf?: (args: ParsedArgs) => string | undefined,
  titleOf?: TitleOf,
): Subcommand => ({
  spec: { description, ...spec },
  run: async (args, rt) => {
    const project = projectOf?.(args);
    try {
      const title = project && titleOf ? await Promise.resolve().then(() => titleOf(args, rt)).catch(() => undefined) : undefined;
      return (await body(args, project ? inProject(rt, project, 'video', title) : rt)) ?? 0;
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

const TITLE_WORDS = 60;

/** The first line of a text, cut to its first 60 characters at a space where there is one. */
export const firstWords = (text: unknown): string | undefined => {
  const line = typeof text === 'string' ? text.split('\n').find((l) => l.trim()) : undefined;
  const chars = Array.from(line?.replace(/\s+/g, ' ').trim() ?? '');
  if (chars.length <= TITLE_WORDS) return chars.join('') || undefined;
  const cut = chars.slice(0, TITLE_WORDS).join('');
  if (chars[TITLE_WORDS] === ' ') return cut.trim();
  const space = cut.lastIndexOf(' ');
  return (space > TITLE_WORDS / 3 ? cut.slice(0, space) : cut).trim();
};

/** A video's name as a title: its file name without the extension, but not "reference", which says nothing. */
export const videoTitle: TitleOf = (args, rt) => {
  const file = args.string('video');
  const name = file ? rt.path.basename(file, rt.path.extname(file)) : '';
  return name && name.toLowerCase() !== 'reference' ? name : undefined;
};

/** The first words of a brief: the text of the option, or of the file it names. */
export const briefTitle = (option: string): TitleOf => async (args, rt) => {
  const given = args.string(option);
  return given ? firstWords(await rt.fs.readText(userPath(rt, given)).catch(() => given)) : undefined;
};

/** The first words of a fill or a plan: its first caption. */
export const captionTitle = (option: string): TitleOf => async (args, rt) => {
  const file = args.string(option);
  const data: unknown = file ? JSON.parse(await rt.fs.readText(userPath(rt, file))) : undefined;
  const captions = data !== null && typeof data === 'object' ? (data as { captions?: unknown }).captions : undefined;
  const first: unknown = Array.isArray(captions) ? captions.find((c) => typeof c === 'string' && c.trim()) : undefined;
  // *Words* in asterisks are drawn in the highlight colour; the marks are not part of the words.
  return typeof first === 'string' ? firstWords(first.replace(/\*/g, '')) : undefined;
};

/** A path the user typed, against the working directory. */
export const userPath = (rt: Runtime, p: string): string => rt.path.resolve(rt.cwd, p);
