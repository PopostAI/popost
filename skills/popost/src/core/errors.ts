/**
 * The error classes the Python commands distinguished. `ValueError`, `KeyError` and OS errors were caught by the
 * workflow commands and printed as `{"ok": false, "error": …}`; see `workflow/errors.ts` for which ones are "expected".
 * The class names stay as each error's `name` (hosts tell errors apart by it); the printed text is the message alone.
 */
import { msg } from '../i18n';
import { fileErrorText } from './error-text';

/** Input the user can fix. */
export class ValueError extends Error {
  override name = 'ValueError';
}

/** A required key is missing from a JSON document. */
export class KeyError extends Error {
  override name = 'KeyError';
  constructor(
    readonly key: string,
    where?: string,
  ) {
    super(
      where === undefined
        ? msg(`missing field "${key}"`, `缺少字段 "${key}"`)
        : msg(`${where} has no "${key}" field`, `${where} 缺少字段 "${key}"`),
    );
  }
}

/** A file the user pointed at is missing or is a directory. */
export class OsError extends Error {
  override name = 'OSError';
  constructor(
    readonly code: 'ENOENT' | 'EISDIR',
    readonly path: string,
  ) {
    super(fileErrorText(code, path));
  }
}
