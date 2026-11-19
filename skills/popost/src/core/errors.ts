/**
 * The error classes the Python commands distinguished. `ValueError`, `KeyError` and OS errors were caught by the
 * workflow commands and printed as `{"ok": false, "error": …}`; see `workflow/errors.ts` for which ones are "expected".
 */
import { pyRepr } from './pyjson';

/** Input the user can fix. */
export class ValueError extends Error {
  override name = 'ValueError';
}

/** A required key is missing from a JSON document; Python printed the key in quotes. */
export class KeyError extends Error {
  override name = 'KeyError';
  constructor(key: string) {
    super(pyRepr(key));
  }
}

/** A file the user pointed at is missing or is a directory; the message reads as Python's `OSError`. */
export class OsError extends Error {
  override name = 'OSError';
  constructor(
    readonly code: 'ENOENT' | 'EISDIR',
    path: string,
  ) {
    super(
      code === 'ENOENT'
        ? `[Errno 2] No such file or directory: ${pyRepr(path)}`
        : `[Errno 21] Is a directory: ${pyRepr(path)}`,
    );
  }
}
