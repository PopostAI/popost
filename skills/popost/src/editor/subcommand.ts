/**
 * Run another CLI command in the same runtime and read its JSON answer, so the editor server and `export --final` use
 * the `package`, `unpack` and `build` commands through their public contract instead of their internals.
 */
import type { Runtime } from '../runtime';

export interface SubcommandResult {
  readonly code: number;
  /** The JSON document the command printed, or `null` when it printed none. */
  readonly json: Record<string, unknown> | null;
}

export const runSubcommand = async (rt: Runtime, argv: readonly string[]): Promise<SubcommandResult> => {
  const { run } = await import('../main');
  const out: string[] = [];
  const code = await run(argv, { ...rt, stdout: (text) => void out.push(text), stderr: () => undefined });
  try {
    const parsed: unknown = JSON.parse(out.join('').trim());
    return { code, json: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { code, json: null };
  }
};
