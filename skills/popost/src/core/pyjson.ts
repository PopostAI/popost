/**
 * Python-compatible renderings of JSON values. The Skill hashes some of them (the series plan digest) and prints others
 * inside generated prompts and error messages, so the text has to match what the Python Skill produced: projects made
 * by it keep their stored digests, and agents keep seeing the same messages.
 */

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Python truthiness of a JSON value: null, false, 0, "", [] and {} are falsy. */
export const truthy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
};

/** Order of Python `str` comparison (by code point; JS compares UTF-16 units). */
export const compareCodePoints = (a: string, b: string): number => {
  const x = Array.from(a, (ch) => ch.codePointAt(0)!);
  const y = Array.from(b, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

/** `json.dumps(value, ensure_ascii=False[, sort_keys=True])` with Python's default `", "` and `": "` separators. */
export const pyJson = (value: unknown, sortKeys = false): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => pyJson(item, sortKeys)).join(', ')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (sortKeys) keys.sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pyJson(value[key], sortKeys)}`).join(', ')}}`;
};

const reprString = (text: string): string => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return quote + out + quote;
};

/** Python `repr()` of a JSON value, as `%r` puts it into messages. */
export const pyRepr = (value: unknown): string => {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(', ')}}`;
  return String(value);
};

/** Python `str()` of a JSON value, as `%s` and f-strings put it into text. */
export const pyStr = (value: unknown): string => (typeof value === 'string' ? value : pyRepr(value));

/** Structural equality of two JSON values (object key order does not matter, as for Python dicts). */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return a === b;
};

/** `urllib.parse.unquote`: percent-decode as UTF-8, leaving malformed escapes as they are. */
export const pyUnquote = (text: string): string =>
  text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16));
    return new TextDecoder().decode(bytes);
  });
