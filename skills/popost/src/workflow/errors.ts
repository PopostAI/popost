/**
 * Which failures the Python workflow commands caught. `ValueError`, `KeyError` and OS errors were printed as
 * `{"ok": false, "error": …}` with exit code 2; anything else (a broken project, a corrupt archive) escaped as a
 * traceback with exit code 1, which here is the generic handler in `main.ts`.
 */
import { KeyError, OsError, ValueError } from '../core/errors';
import { ImageError } from '../core/image';
import { pyRepr } from '../core/pyjson';

export { KeyError, OsError, ValueError };

const errnoCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** `(ValueError, OSError, KeyError)` of the Python CLI, plus what replaces JSONDecodeError and PIL's image errors. */
export const isExpectedFailure = (error: unknown): boolean =>
  error instanceof ValueError ||
  error instanceof KeyError ||
  error instanceof SyntaxError ||
  error instanceof ImageError ||
  errnoCode(error) !== undefined;

/** `str(error)` of an expected failure. */
export const failureText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const path = /'([^']*)'\s*$/.exec(error.message)?.[1];
  if (error instanceof OsError || path === undefined) return error.message;
  if (errnoCode(error) === 'ENOENT') return `[Errno 2] No such file or directory: ${pyRepr(path)}`;
  if (errnoCode(error) === 'EISDIR') return `[Errno 21] Is a directory: ${pyRepr(path)}`;
  return error.message;
};
