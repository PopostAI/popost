/**
 * Running a tool the user named in the environment (POPOST_OCR_CMD, POPOST_ASR_CMD, POPOST_TTS_CMD): its own words,
 * then the arguments of its contract. The engine knows nothing about the model behind a tool; it hands the tool files
 * and reads the file the tool writes, so the tools in skills/popost/tools/video/ and a user's own work the same way.
 */
import type { Runtime } from '../runtime';
import { cpuBudgetOf, programsOf, toolCommand, VideoUnavailableError } from './host';

/** A tool could not be started, failed, or wrote something that is not in its format. The message says what to check. */
export class ToolError extends VideoUnavailableError {
  override name = 'ToolError';
}

/** The last `n` lines of a program's standard error, on one line. */
export const lastLines = (stderr: string, n: number): string => stderr.trim().split('\n').slice(-n).join(' | ');

/** Threads a tool gets when the user did not say: measured, a text reader gains little beyond four. */
export const TOOL_THREADS = 4;

/**
 * The environment the engine adds for a tool it starts: POPOST_TOOL_THREADS, the threads it may use. The user's own
 * setting wins; else `threads` (a caller that runs several copies divides the budget), else the CPU budget, at most
 * TOOL_THREADS. The tools in skills/popost/tools/video/ read it (threads.py), so they need no setting of their own.
 */
export const toolEnv = (rt: Runtime, threads?: number): Record<string, string> => {
  const own = rt.env.POPOST_TOOL_THREADS?.trim();
  const n = threads ?? Math.min(TOOL_THREADS, cpuBudgetOf(rt).cpus);
  return { POPOST_TOOL_THREADS: own || String(Math.max(1, Math.floor(n))) };
};

/**
 * Runs the tool named in `variable` with `args` after its own words, to its end. Its standard output is not kept: a
 * tool writes its result to a file. Throws a ToolError with the last lines of its standard error when it cannot be
 * started or exits with an error. `what` names the tool in messages, e.g. "The text reader".
 */
export const runTool = async (rt: Runtime, variable: string, what: string, args: readonly string[], o: { threads?: number } = {}): Promise<void> => {
  const words = toolCommand(rt, variable);
  if (!words) throw new ToolError(what + ' is not set up: set ' + variable + ' to a tool of yours; skills/popost/tools/video/ has examples.');
  const r = await programsOf(rt).run([...words, ...args], { onStdout: () => undefined, env: toolEnv(rt, o.threads), lowPriority: true }).catch((e: unknown) => {
    throw new ToolError(what + ' could not be started (' + (e instanceof Error ? e.message : String(e)) + '). Check ' + variable + '.');
  });
  if (r.code !== 0) throw new ToolError(what + ' exited with ' + r.code + ': ' + lastLines(r.stderr, 2));
};
