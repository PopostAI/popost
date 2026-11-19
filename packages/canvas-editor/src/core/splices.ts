import type { Splice } from '../contracts';

/** Thrown for malformed splice lists (unsorted, overlapping, out of range). */
export class SpliceError extends Error {}

/** Check that splices are sorted and non-overlapping (and inside `length`, when given). */
export function assertValidSplices(splices: readonly Splice[], length?: number): void {
  let prevEnd = 0;
  for (const s of splices) {
    if (s.start > s.end || s.start < prevEnd || (length !== undefined && s.end > length)) {
      throw new SpliceError(`invalid splice [${s.start}, ${s.end})`);
    }
    prevEnd = s.end;
  }
}

export function applySplices(source: string, splices: readonly Splice[]): string {
  assertValidSplices(splices, source.length);
  let out = '';
  let pos = 0;
  for (const s of splices) {
    out += source.slice(pos, s.start) + s.text;
    pos = s.end;
  }
  return out + source.slice(pos);
}

/** Splices that turn `applySplices(source, splices)` back into `source`. */
export function invertSplices(source: string, splices: readonly Splice[]): Splice[] {
  assertValidSplices(splices, source.length);
  const out: Splice[] = [];
  let shift = 0;
  for (const s of splices) {
    const start = s.start + shift;
    out.push({ start, end: start + s.text.length, text: source.slice(s.start, s.end) });
    shift += s.text.length - (s.end - s.start);
  }
  return out;
}

/**
 * Map an offset of the old text to the new text. Offsets inside a replaced range (and the
 * boundary of an insertion) collapse to its start (`assoc` < 0) or end (`assoc` > 0).
 */
export function mapOffset(splices: readonly Splice[], pos: number, assoc: -1 | 1): number {
  let shift = 0;
  for (const s of splices) {
    const len = s.end - s.start;
    if (s.end < pos || (s.end === pos && len > 0)) {
      shift += s.text.length - len;
    } else if (s.start < pos || (s.start === pos && assoc > 0)) {
      return s.start + shift + (assoc > 0 ? s.text.length : 0);
    } else if (s.start === pos) {
      return pos + shift;
    } else {
      break;
    }
  }
  return pos + shift;
}

/** True when `pos` lies in a range that some splice replaces or deletes (`start <= pos < end`). */
export function isInReplaced(splices: readonly Splice[], pos: number): boolean {
  return splices.some((s) => s.end > s.start && s.start <= pos && pos < s.end);
}

/** The splice (if any) that turns `before` into `after`, trimmed to the differing middle. */
export function diffSplices(before: string, after: string): Splice[] {
  if (before === after) return [];
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
  return [{ start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) }];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/* ---- composition: A->B followed by B->C becomes A->C ---- */

type Comp = { t: 'r'; n: number } | { t: 'd'; n: number } | { t: 'i'; s: string };

function toComps(splices: readonly Splice[]): Comp[] {
  const out: Comp[] = [];
  let pos = 0;
  for (const s of splices) {
    if (s.start > pos) out.push({ t: 'r', n: s.start - pos });
    if (s.end > s.start) out.push({ t: 'd', n: s.end - s.start });
    if (s.text) out.push({ t: 'i', s: s.text });
    pos = s.end;
  }
  return out;
}

function fromComps(comps: readonly Comp[]): Splice[] {
  const out: Splice[] = [];
  let pos = 0;
  let cur: Splice | null = null;
  for (const c of comps) {
    if (c.t === 'r') {
      cur = null;
      pos += c.n;
      continue;
    }
    if (!cur) {
      cur = { start: pos, end: pos, text: '' };
      out.push(cur);
    }
    if (c.t === 'd') {
      cur.end += c.n;
      pos += c.n;
    } else {
      cur.text += c.s;
    }
  }
  return out.filter((s) => s.end > s.start || s.text !== '');
}

function compLength(c: Comp | undefined): number {
  if (!c) return Infinity;
  return c.t === 'i' ? c.s.length : c.n;
}

function consume(queue: Comp[], n: number): void {
  const c = queue[0];
  if (!c) return;
  const rest = compLength(c) - n;
  if (rest <= 0) queue.shift();
  else if (c.t === 'i') queue[0] = { t: 'i', s: c.s.slice(n) };
  else queue[0] = { t: c.t, n: rest };
}

/** Compose two splice lists: `second` is expressed in the coordinates produced by `first`. */
export function composeSplices(first: readonly Splice[], second: readonly Splice[]): Splice[] {
  const qa = toComps(first);
  const qb = toComps(second);
  const out: Comp[] = [];
  const push = (c: Comp): void => {
    const last = out[out.length - 1];
    if (last && last.t === c.t) {
      if (last.t === 'i' && c.t === 'i') last.s += c.s;
      else if (last.t !== 'i' && c.t !== 'i') last.n += c.n;
      else out.push(c);
    } else out.push(c);
  };
  for (;;) {
    const x = qa[0];
    const y = qb[0];
    if (!x && !y) break;
    if (y && y.t === 'i') {
      push({ t: 'i', s: y.s });
      qb.shift();
      continue;
    }
    if (x && x.t === 'd') {
      push({ t: 'd', n: x.n });
      qa.shift();
      continue;
    }
    const n = Math.min(compLength(x), compLength(y));
    if (n === Infinity) break;
    const xRetain = !x || x.t === 'r';
    const yRetain = !y || y.t === 'r';
    if (xRetain && yRetain) push({ t: 'r', n });
    else if (xRetain) push({ t: 'd', n });
    else if (yRetain && x && x.t === 'i') push({ t: 'i', s: x.s.slice(0, n) });
    consume(qa, n);
    consume(qb, n);
  }
  return fromComps(out);
}
