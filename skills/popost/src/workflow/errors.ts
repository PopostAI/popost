/**
 * Which failures the Python workflow commands caught. `ValueError`, `KeyError` and OS errors were printed as
 * `{"ok": false, "error": …}` with exit code 2; anything else (a broken project, a corrupt archive) escaped as a
 * traceback with exit code 1, which here is the generic handler in `main.ts`.
 */
import { KeyError, OsError, ValueError } from '../core/errors';
import { errorText } from '../core/error-text';
import { ImageError } from '../core/image';

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

/** The text of an expected failure: its message, a file-system error as "file not found: <path>". */
export const failureText = (error: unknown): string => errorText(error);
