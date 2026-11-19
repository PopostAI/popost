/**
 * Fast path for edits that only touch attributes inside start tags (`setStyle`, `setAttr` and the undo/redo of
 * such entries). Instead of re-parsing the whole document, the next `DocIndex` is derived from the previous one:
 * offsets after the edit are shifted by the length delta and the touched elements' attributes are recomputed by
 * tokenising just their new start tags.
 *
 * Eligibility is strict. `patchAttributes` returns null (the caller then takes the full parse) unless every splice
 * lies strictly inside one element's start tag (after the tag name, before the closing `>`), that start tag still
 * tokenises as exactly one start tag with the same name and self-closing state, and no attribute of the new tag
 * could change how the tree is built or how a foreign-content attribute name is spelled.
 */
import { Tokenizer } from 'parse5';
import type { Token, TokenHandler } from 'parse5';
import type { AttrInfo, DocIndex, ElementInfo, NodeId, Splice } from '../contracts';

/** Counters for tests: how often the fast path produced the index versus declined. */
export const fastPathStats = { taken: 0, declined: 0 };

export function resetFastPathStats(): void {
  fastPathStats.taken = 0;
  fastPathStats.declined = 0;
}

/** Splice lists longer than this go through the full path (they are not drag/nudge-sized edits). */
const MAX_SPLICES = 64;

/**
 * Tags whose attributes can change how the surrounding tree is built (`<input type=hidden>` inside a table,
 * `<font color>` breaking out of foreign content, `annotation-xml` integration points, declarative shadow roots).
 */
const TREE_SENSITIVE_TAGS = new Set(['input', 'font', 'annotation-xml', 'template', 'frameset', 'frame']);

/** Lower-cased names of SVG attributes parse5 re-cases in foreign content, plus MathML `definitionurl`. */
const ADJUSTED_ATTRS = new Set([
  'attributename', 'attributetype', 'basefrequency', 'baseprofile', 'calcmode', 'clippathunits', 'diffuseconstant',
  'edgemode', 'filterunits', 'glyphref', 'gradienttransform', 'gradientunits', 'kernelmatrix', 'kernelunitlength',
  'keypoints', 'keysplines', 'keytimes', 'lengthadjust', 'limitingconeangle', 'markerheight', 'markerunits',
  'markerwidth', 'maskcontentunits', 'maskunits', 'numoctaves', 'pathlength', 'patterncontentunits',
  'patterntransform', 'patternunits', 'pointsatx', 'pointsaty', 'pointsatz', 'preservealpha', 'preserveaspectratio',
  'primitiveunits', 'refx', 'refy', 'repeatcount', 'repeatdur', 'requiredextensions', 'requiredfeatures',
  'specularconstant', 'specularexponent', 'spreadmethod', 'startoffset', 'stddeviation', 'stitchtiles',
  'surfacescale', 'systemlanguage', 'tablevalues', 'targetx', 'targety', 'textlength', 'viewbox', 'viewtarget',
  'xchannelselector', 'ychannelselector', 'zoomandpan', 'definitionurl',
]);

interface TagAttr {
  name: string;
  value: string;
  /** Offsets relative to the start tag text. */
  start: number;
  end: number;
}

export interface TagInfo {
  /** Lower-cased tag name as tokenised. */
  name: string;
  selfClosing: boolean;
  attrs: TagAttr[];
}

/** Tokenise `text`; non-null only when it is exactly one complete start tag (nothing before, after or unterminated). */
export function tokenizeStartTag(text: string): TagInfo | null {
  const tags: Token.TagToken[] = [];
  let stray = false;
  const mark = (): void => {
    stray = true;
  };
  const handler: TokenHandler = {
    onStartTag: (token) => void tags.push(token),
    onComment: mark,
    onDoctype: mark,
    onEndTag: mark,
    onCharacter: mark,
    onNullCharacter: mark,
    onWhitespaceCharacter: mark,
    onEof: () => {},
  };
  new Tokenizer({ sourceCodeLocationInfo: true }, handler).write(text, true);
  const tag = tags[0];
  if (stray || tags.length !== 1 || !tag.location) return null;
  if (tag.location.startOffset !== 0 || tag.location.endOffset !== text.length) return null;

  // Same pairing the full parse uses: locations sorted by offset against the attributes in tag order.
  const locs = tag.location.attrs ? Object.values(tag.location.attrs).sort((a, b) => a.startOffset - b.startOffset) : [];
  if (locs.length !== tag.attrs.length) return null;
  const attrs = tag.attrs.map((a, i) => ({ name: a.name, value: a.value, start: locs[i].startOffset, end: locs[i].endOffset }));
  return { name: tag.tagName, selfClosing: tag.selfClosing, attrs };
}

interface Group {
  el: ElementInfo;
  splices: Splice[];
}

/** Group sorted splices by the element whose start tag contains them; null when any splice is not strictly inside one. */
function groupByStartTag(prev: DocIndex, splices: readonly Splice[]): Group[] | null {
  const groups: Group[] = [];
  const inside = (s: Splice, el: ElementInfo): boolean => s.start >= el.start + 1 + el.tag.length && s.end < el.startTagEnd;
  for (const s of splices) {
    const last = groups[groups.length - 1];
    if (last && inside(s, last.el)) {
      last.splices.push(s);
      continue;
    }
    let owner: ElementInfo | undefined;
    for (const el of prev.elements.values()) {
      if (el.startTagEnd !== el.start && inside(s, el)) {
        owner = el;
        break;
      }
    }
    if (!owner || prev.source[owner.start] !== '<') return null;
    groups.push({ el: owner, splices: [s] });
  }
  return groups;
}

/** New attribute list of `el` (offsets in the new source, given the `base` shift of everything before the element). */
function patchAttrs(prev: DocIndex, el: ElementInfo, local: readonly Splice[], base: number): { attrs: AttrInfo[]; delta: number } | null {
  if (TREE_SENSITIVE_TAGS.has(el.tag.toLowerCase())) return null;
  const oldText = prev.source.slice(el.start, el.startTagEnd);
  let newText = '';
  let pos = 0;
  let delta = 0;
  for (const s of local) {
    newText += oldText.slice(pos, s.start - el.start) + s.text;
    pos = s.end - el.start;
    delta += s.text.length - (s.end - s.start);
  }
  newText += oldText.slice(pos);

  const before = tokenizeStartTag(oldText);
  const after = tokenizeStartTag(newText);
  if (!before || !after) return null;
  if (before.name !== el.tag.toLowerCase() || after.name !== before.name || after.selfClosing !== before.selfClosing) return null;
  if (before.attrs.length !== el.attrs.length) return null;

  // Old attributes that no splice touches keep their (possibly foreign-adjusted) names and values, shifted.
  const kept = new Map<string, AttrInfo>();
  for (const a of el.attrs) {
    if (local.some((s) => s.start <= a.end && s.end >= a.start)) continue;
    const shift = local.reduce((sum, s) => (s.end <= a.start ? sum + s.text.length - (s.end - s.start) : sum), 0);
    kept.set(`${a.start + shift - el.start}:${a.end + shift - el.start}`, a);
  }

  const attrs: AttrInfo[] = [];
  for (const a of after.attrs) {
    const start = base + el.start + a.start;
    const end = base + el.start + a.end;
    const old = kept.get(`${a.start}:${a.end}`);
    if (old) {
      if (old.name.toLowerCase() !== a.name || old.value !== a.value) return null;
      attrs.push({ name: old.name, value: old.value, start, end });
      continue;
    }
    // A touched attribute must be spelled the same in HTML and in foreign content.
    if (ADJUSTED_ATTRS.has(a.name) || a.name.includes(':') || a.name.startsWith('xmlns')) return null;
    attrs.push({ name: a.name, value: a.value, start, end });
  }
  return { attrs, delta };
}

/**
 * Derive the index of `source` (= `prev.source` with `splices` applied) without a full parse, or null when the edit
 * is not an attribute-local change of existing start tags. Element ids, tree and order are unchanged; nothing of
 * `prev` is mutated (unchanged elements are shared, changed ones are copied).
 */
export function patchAttributes(prev: DocIndex, splices: readonly Splice[], source: string): DocIndex | null {
  const next = tryPatch(prev, splices, source);
  if (next) fastPathStats.taken++;
  else fastPathStats.declined++;
  return next;
}

function tryPatch(prev: DocIndex, splices: readonly Splice[], source: string): DocIndex | null {
  if (splices.length === 0 || splices.length > MAX_SPLICES) return null;
  const groups = groupByStartTag(prev, splices);
  if (!groups) return null;

  const patched = new Map<NodeId, AttrInfo[]>();
  const pivots: Array<{ at: number; delta: number }> = [];
  let total = 0;
  for (const { el, splices: local } of groups) {
    const patch = patchAttrs(prev, el, local, total);
    if (!patch) return null;
    patched.set(el.id, patch.attrs);
    pivots.push({ at: el.startTagEnd, delta: patch.delta });
    total += patch.delta;
  }
  if (prev.source.length + total !== source.length) return null;

  const shift = (o: number): number => {
    let sum = 0;
    for (const p of pivots) {
      if (p.at > o) break;
      sum += p.delta;
    }
    return o + sum;
  };

  const elements = new Map<NodeId, ElementInfo>();
  for (const [id, el] of prev.elements) {
    const start = shift(el.start);
    const end = shift(el.end);
    const startTagEnd = shift(el.startTagEnd);
    const endTagStart = el.endTagStart === null ? null : shift(el.endTagStart);
    const attrs = patched.get(id);
    if (!attrs && start === el.start && end === el.end && startTagEnd === el.startTagEnd && endTagStart === el.endTagStart) {
      elements.set(id, el);
      continue;
    }
    elements.set(id, {
      ...el,
      start,
      end,
      startTagEnd,
      endTagStart,
      attrs: attrs ?? (start === el.start ? el.attrs : el.attrs.map((a) => ({ ...a, start: shift(a.start), end: shift(a.end) }))),
    });
  }
  return { source, elements, order: prev.order, html: prev.html, head: prev.head, body: prev.body };
}
