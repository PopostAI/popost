/**
 * Python-compatible `json.dumps(value, sort_keys=True, ensure_ascii=…)` with the default `", "` / `": "` separators.
 * Quote ids, request hashes and integrity hashes are SHA-256 of this text, so a quote written by the Python Skill still
 * verifies here (and the other way round). Plain `JSON.stringify` would differ in separators and key order.
 */
const compareCodePoints = (a: string, b: string): number => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
};

const ascii = (text: string): string =>
  text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** `sortKeys=false` keeps insertion order, as `json.dumps` without `sort_keys` does (the ledger's one-line records). */
export const canonicalJson = (value: unknown, ensureAscii = false, sortKeys = true): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, ensureAscii, sortKeys)).join(', ')}]`;
  if (typeof value === 'object') {
    const defined = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const entries = (sortKeys ? defined.sort(([a], [b]) => compareCodePoints(a, b)) : defined).map(
      ([k, v]) => `${canonicalJson(k, ensureAscii)}: ${canonicalJson(v, ensureAscii, sortKeys)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  const text = JSON.stringify(value);
  return ensureAscii && typeof value === 'string' ? ascii(text) : text;
};

/** Python `str(value)` for the JSON scalars that end up in endpoint-binding material. */
export const pyStr = (value: unknown, whenMissing = ''): string => {
  if (value === undefined) return whenMissing;
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : canonicalJson(value, true);
};
