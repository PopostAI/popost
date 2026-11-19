/**
 * The reader of our output went away (`popost font list | head`, an Agent that stops reading): Node emits `EPIPE` on the
 * stream and, with no listener, dies with a stack trace. That is the normal end of a pipe, not a failure: stop quietly
 * with the exit code the command already set. Any other stream error is reported in one line.
 */
import { msg } from './i18n';

interface ErrorSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface PipeGuard {
  /** Ends the process with this code. */
  readonly exit: (code: number) => void;
  /** The code the command set so far (`process.exitCode`). */
  readonly exitCode: () => number;
  /** Best-effort one-line report for an unexpected stream error. */
  readonly report: (text: string) => void;
}

export const guardBrokenPipe = (streams: readonly ErrorSource[], guard: PipeGuard): void => {
  for (const stream of streams)
    stream.on('error', (error) => {
      if (error.code === 'EPIPE') return guard.exit(guard.exitCode());
      const reason = error.code ?? error.message;
      guard.report(msg(`popost: output stream failed (${reason})\n`, `popost：输出流出错（${reason}）\n`));
      return guard.exit(1);
    });
};
