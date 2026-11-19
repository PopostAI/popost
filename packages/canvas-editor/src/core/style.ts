/**
 * Inline `style` attribute handling with minimal textual change: declarations the caller does not
 * touch stay byte-identical (including their spacing, comments and odd formatting).
 */

export interface StyleDecl {
  /** Property name exactly as written (comments stripped). */
  name: string;
  /** Value text without a trailing `!important`. */
  value: string;
  important: boolean;
  /** Whole declaration, from the first character of the name to the end of the value. */
  start: number;
  end: number;
  /** Value range excluding `!important` (starts after the colon and following whitespace). */
  valueStart: number;
  valueEnd: number;
}

interface Segment {
  /** Trimmed content range of one `;`-separated chunk. */
  start: number;
  end: number;
  /** Index of the terminating `;`, null for the last chunk without one. */
  semi: number | null;
  decl: StyleDecl | null;
}

const IMPORTANT = /\s*!\s*important\s*$/i;
const PROP_NAME = /^(?:--[^\s]+|-?[a-zA-Z_][\w-]*)$/;

/**
 * Walk `text`, calling `visit` for every character that sits at bracket depth 0 outside strings
 * and comments (outermost braces included). Returns false when strings/comments/brackets are unbalanced.
 */
function scanTop(text: string, visit: (i: number, ch: string) => void): boolean {
  let depth = 0;
  let ok = true;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '"' || ch === "'") {
      const close = findStringEnd(text, i);
      if (close < 0) return false;
      i = close + 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return false;
      i = close + 2;
    } else {
      if (ch === '(' || ch === '[' || ch === '{') {
        if (depth === 0 && ch === '{') visit(i, ch);
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) ok = false;
        else depth--;
        if (depth === 0 && ch === '}') visit(i, ch);
      } else if (depth === 0) visit(i, ch);
      i++;
    }
  }
  return ok && depth === 0;
}

function findStringEnd(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
    else if (text[i] === '\n') return -1;
  }
  return -1;
}

function segmentsOf(text: string): Segment[] {
  const cuts: Array<{ from: number; semi: number | null }> = [];
  let from = 0;
  scanTop(text, (i, ch) => {
    if (ch === ';') {
      cuts.push({ from, semi: i });
      from = i + 1;
    }
  });
  cuts.push({ from, semi: null });

  const out: Segment[] = [];
  for (const cut of cuts) {
    const stop = cut.semi ?? text.length;
    const raw = text.slice(cut.from, stop);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const start = cut.from + lead;
    const end = start + trimmed.length;
    out.push({ start, end, semi: cut.semi, decl: parseDecl(text, start, end) });
  }
  return out;
}

function parseDecl(text: string, start: number, end: number): StyleDecl | null {
  const chunk = text.slice(start, end);
  let colon = -1;
  scanTop(chunk, (i, ch) => {
    if (ch === ':' && colon < 0) colon = i;
  });
  if (colon < 0) return null;
  const name = chunk.slice(0, colon).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!PROP_NAME.test(name)) return null;

  let valueStart = start + colon + 1;
  while (valueStart < end && /\s/.test(text[valueStart])) valueStart++;
  const body = text.slice(valueStart, end);
  const m = IMPORTANT.exec(body);
  const valueEnd = m ? valueStart + m.index : end;
  return {
    name,
    value: text.slice(valueStart, valueEnd).trim(),
    important: m !== null,
    start,
    end,
    valueStart,
    valueEnd,
  };
}

/** Declarations of an inline style value, in order. Chunks that are not `name: value` are ignored. */
export function parseStyle(value: string): StyleDecl[] {
  return segmentsOf(value).flatMap((s) => (s.decl ? [s.decl] : []));
}

/** Lower-case a property name, except custom properties (`--x`), which are case-sensitive. */
export function normalizeProp(name: string): string {
  const n = name.trim();
  return n.startsWith('--') ? n : n.toLowerCase();
}

export function isValidPropName(name: string): boolean {
  return PROP_NAME.test(name.trim());
}

/** A value is safe to splice in when it cannot terminate or break out of its declaration. */
export function isSafeStyleValue(value: string): boolean {
  let plain = true;
  const balanced = scanTop(value, (_i, ch) => {
    if (ch === ';' || ch === '{' || ch === '}') plain = false;
  });
  return balanced && plain && !/\\$/.test(value);
}

/** Effective (last) value of `prop`, including `!important` when present, or null. */
export function getStyleValue(value: string, prop: string): string | null {
  const name = normalizeProp(prop);
  const found = parseStyle(value).filter((d) => normalizeProp(d.name) === name);
  const last = found[found.length - 1];
  return last ? (last.important ? `${last.value} !important` : last.value) : null;
}

/**
 * Merge declarations into an inline style value. `null` (or an empty string) removes a property;
 * existing declarations get only their value replaced (an existing `!important` is kept unless
 * the new value brings its own); new ones are appended as `; prop: value`.
 */
export function mergeStyle(value: string, props: Readonly<Record<string, string | null>>): string {
  let out = value;
  for (const [rawName, rawValue] of Object.entries(props)) {
    const name = normalizeProp(rawName);
    const next = rawValue === null ? '' : rawValue.trim();
    out = next === '' ? removeProp(out, name) : setProp(out, name, next);
  }
  return out;
}

function matching(value: string, name: string): Segment[] {
  return segmentsOf(value).filter((s) => s.decl && normalizeProp(s.decl.name) === name);
}

function setProp(value: string, name: string, next: string): string {
  let found = matching(value, name);
  while (found.length > 1) {
    value = removeSegment(value, found[0]);
    found = matching(value, name);
  }
  const target = found[0]?.decl;
  if (!target) return appendProp(value, name, next);
  const hasOwnImportant = IMPORTANT.test(next);
  const end = hasOwnImportant ? target.end : target.valueEnd;
  return value.slice(0, target.valueStart) + next + value.slice(end);
}

function appendProp(value: string, name: string, next: string): string {
  const segs = segmentsOf(value);
  const last = segs[segs.length - 1];
  if (!last) return `${name}: ${next}`;
  if (last.semi !== null) return `${value.slice(0, last.semi + 1)} ${name}: ${next};${value.slice(last.semi + 1)}`;
  return `${value.slice(0, last.end)}; ${name}: ${next}${value.slice(last.end)}`;
}

function removeProp(value: string, name: string): string {
  let found = matching(value, name);
  while (found.length > 0) {
    value = removeSegment(value, found[0]);
    found = matching(value, name);
  }
  return value;
}

/** Remove one chunk together with exactly one separator. */
function removeSegment(value: string, target: Segment): string {
  const segs = segmentsOf(value);
  const at = segs.findIndex((s) => s.start === target.start);
  const prev = segs[at - 1];
  const next = segs[at + 1];
  let from: number;
  let to: number;
  if (next) {
    from = target.start;
    to = next.start;
  } else if (target.semi !== null) {
    from = prev && prev.semi !== null ? prev.semi + 1 : target.start;
    to = target.semi + 1;
  } else {
    from = prev ? prev.end : target.start;
    to = target.end;
  }
  return value.slice(0, from) + value.slice(to);
}
