/**
 * Turns zod issues into Problems (a JSON path, a message, the allowed values and one fix) and finds unknown fields.
 */
import type { core } from 'zod';
import type { Problem } from '../types';
import { closest } from './suggest';

type Issue = core.$ZodIssue;
type Key = PropertyKey;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "tracks[2].during.segment" from ['tracks', 2, 'during', 'segment']; the root is "(root)". */
export const pathText = (path: readonly Key[]): string =>
  path.reduce<string>((s, k) => (typeof k === 'number' ? s + '[' + k + ']' : s ? s + '.' + String(k) : String(k)), '') || '(root)';

const show = (v: unknown): string => {
  if (v === undefined) return 'nothing';
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 40 ? text.slice(0, 37) + '...' : text;
};

/** Example values by field name, used in fixes. */
const EXAMPLES: Readonly<Record<string, string>> = {
  version: '1', canvas: '{ "width": 1080, "height": 1920, "fps": 30 }', width: '1080', height: '1920', fps: '30',
  frames: '90', id: '"hook"', kind: '"image"', file: '"assets/photo.webp"', base: '{ "color": "#101014" }',
  transition: '"fade"', box: '[0.1, 0.1, 0.8, 0.2]', during: '{ "segment": "hook" }', segment: '"<segment id>"',
  text: '"Hello"', material: '"<material id>"', color: '"#ffffff"', preset: '"fade"', type: '"text"',
  shape: '"rect"', size: '0.05', pan: '[0.02, 0]', zoom: '0.04', gain: '-12', in: '0', speed: '1', audio: '0', segments: '[{ "id": "s1", "frames": 90, "base": { "color": "#101014" } }]',
  moves: '[{ "from": 0, "to": 28, "scale": [1, 2.6], "focus": [1, 0], "ease": "out" }]', scale: '[1, 1.2]', focus: '[0.5, 0.5]',
  stops: '[{ "at": 0, "color": "#ff7a00" }, { "at": 1, "color": "#ffd000" }]', cues: '[{ "text": "Hello", "during": { "segment": "<segment id>" } }]',
  period: '30', side: '"after"', strength: '1', spans: '[{ "from": 0, "to": 3, "color": "#ffd000" }]',
  phrase: '"一键复制"', occurrence: '1', of: '"<audio track id>"', lead: '6', hold: '12', weight: '800',
};
const TYPE_EXAMPLES: Readonly<Record<string, string>> = {
  number: '1', int: '30', string: '"text"', boolean: 'true', object: '{ ... }', array: '[ ... ]', tuple: '[ ... ]',
};
const TUPLES: Readonly<Record<string, string>> = {
  box: 'exactly 4 numbers [x, y, width, height], fractions of the canvas',
  pan: 'exactly 2 numbers [x, y], fractions of the canvas per second',
  scale: 'exactly 2 numbers [at from, at to], scales of at least 1',
  focus: 'exactly 2 numbers [x, y], fractions of the frame',
  shift: 'exactly 2 pairs [[x, y] at from, [x, y] at to], fractions of the canvas',
};

const lastKey = (path: readonly Key[]): string => {
  const k = [...path].reverse().find((p) => typeof p === 'string');
  return typeof k === 'string' ? k : '';
};
const example = (path: readonly Key[], expected = ''): string => EXAMPLES[lastKey(path)] ?? TYPE_EXAMPLES[expected] ?? '"..."';

const problem = (path: readonly Key[], message: string, fix: string, allowed?: string[]): Problem => ({
  level: 'error', at: pathText(path), message, fix, ...(allowed ? { allowed } : {}),
});

const typeProblem = (i: Extract<Issue, { code: 'invalid_type' }>, path: readonly Key[]): Problem => {
  const what = i.expected === 'int' ? 'a whole number' : i.expected === 'array' || i.expected === 'object' ? 'an ' + i.expected : 'a ' + i.expected;
  if (i.input === undefined) return problem(path, pathText(path) + ' is missing; it must be ' + what + '.', 'Add "' + lastKey(path) + '": ' + example(path, i.expected) + '.');
  return problem(path, pathText(path) + ' must be ' + what + ', not ' + show(i.input) + '.', 'Write ' + example(path, i.expected) + ' here.');
};

const rangeProblem = (i: Extract<Issue, { code: 'too_small' | 'too_big' }>, path: readonly Key[]): Problem => {
  const small = i.code === 'too_small';
  const limit = small ? (i as { minimum: number | bigint }).minimum : (i as { maximum: number | bigint }).maximum;
  const key = lastKey(path);
  if (i.origin === 'array' && TUPLES[key]) return problem(path, pathText(path) + ' needs ' + TUPLES[key] + '.', 'Write ' + example(path) + '.');
  if (i.origin === 'array') return problem(path, pathText(path) + ' needs ' + (small ? 'at least ' : 'at most ') + limit + ' item(s).', small ? 'Add one, for example ' + example(path) + '.' : 'Remove the extra items.');
  if (i.origin === 'string') return problem(path, pathText(path) + (small ? ' must not be empty.' : ' is longer than ' + limit + ' characters.'), small ? 'Write a value, for example ' + example(path, 'string') + '.' : 'Shorten it.');
  const bound = small ? (i.inclusive ? 'at least ' : 'greater than ') : (i.inclusive ? 'at most ' : 'less than ');
  return problem(path, pathText(path) + ' is ' + show(i.input) + '; it must be ' + bound + limit + '.', 'Use a value ' + bound + limit + '.');
};

const valueProblem = (i: Extract<Issue, { code: 'invalid_value' }>, path: readonly Key[]): Problem => {
  const allowed = i.values.map((v) => String(v));
  const near = typeof i.input === 'string' ? closest(i.input, allowed) : undefined;
  return problem(path, pathText(path) + ' is ' + show(i.input) + ', which is not allowed here.', near ? 'Use "' + near + '".' : 'Use one of the allowed values, for example ' + JSON.stringify(i.values[0]) + '.', allowed);
};

/** A union's issues: report the branch that matched furthest (the one whose root type fits, with the fewest issues). */
const unionProblems = (i: Extract<Issue, { code: 'invalid_union' }>, path: readonly Key[]): Problem[] => {
  const rich = i as typeof i & { note?: string; discriminator?: string; options?: unknown[] };
  if (rich.note === 'No matching discriminator') {
    const allowed = (rich.options ?? []).map((v) => String(v));
    const key = rich.discriminator ?? 'type';
    const value = isObj(i.input) ? i.input[key] : i.input;
    const near = typeof value === 'string' ? closest(value, allowed) : undefined;
    return [problem(path, pathText(path) + ' is ' + show(value) + ', which is not a known ' + key + '.', near ? 'Use "' + near + '".' : 'Use one of the allowed values, for example "' + (allowed[0] ?? '') + '".', allowed)];
  }
  // Rank 0: the branch's type fits and only nested values are wrong; 1: the type fits but the value does not (an
  // enum); 2: the type does not fit at all.
  const rank = (branch: readonly Issue[]): number =>
    Math.max(0, ...branch.filter((b) => b.path.length === 0).map((b) => (b.code === 'invalid_type' ? 2 : 1)));
  const ranked = i.errors.map((branch) => ({ branch, r: rank(branch) })).sort((a, b) => a.r - b.r || a.branch.length - b.branch.length);
  const best = ranked[0];
  if (!best || best.r === 2) return [problem(path, pathText(path) + ' is ' + show(i.input) + ', which has the wrong type here.', 'Write ' + example(path) + ' here.')];
  return best.branch.flatMap((b) => issueProblem(b, [...path, ...b.path]));
};

const issueProblem = (i: Issue, path: readonly Key[]): Problem[] => {
  switch (i.code) {
    case 'invalid_type':
      return [typeProblem(i, path)];
    case 'too_small':
    case 'too_big':
      return [rangeProblem(i, path)];
    case 'invalid_value':
      return [valueProblem(i, path)];
    case 'invalid_union':
      return unionProblems(i, path);
    case 'invalid_format':
      return [problem(path, pathText(path) + ' ' + i.message + ' (it is ' + show(i.input) + ').', 'Use letters, digits, "-" and "_" only, for example ' + example(path) + '.')];
    case 'custom': {
      const params = (i.params ?? {}) as { allowed?: string[]; fix?: string };
      return [problem(path, pathText(path) + ' ' + i.message + ' (it is ' + show(i.input) + ').', params.fix ?? 'Correct the value.', params.allowed)];
    }
    default:
      return [problem(path, pathText(path) + ': ' + i.message + ' (it is ' + show(i.input) + ').', 'Correct the value, for example ' + example(path) + '.')];
  }
};

export const issueProblems = (issues: readonly Issue[]): Problem[] => issues.flatMap((i) => issueProblem(i, i.path));

// ---------------------------------------------------------------------------------------------------------------------
// Unknown fields

/** The allowed field names of every object in a project, taken from the schema. */
export interface KeyTable {
  root: string[];
  canvas: string[];
  material: string[];
  segment: string[];
  transition: string[];
  camera: string[];
  move: string[];
  gradient: string[];
  stop: string[];
  base: { material: string[]; color: string[]; scene: string[] };
  motion: string[];
  span: string[];
  style: string[];
  stroke: string[];
  background: string[];
  shadow: string[];
  textSpan: string[];
  border: string[];
  loop: string[];
  cue: string[];
  spoken: string[];
  past: string[];
  tracks: Record<string, string[]>;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const join = (at: string, key: string): string => (at ? at + '.' + key : key);

const extra = (v: unknown, allowed: readonly string[], at: string): Problem[] =>
  !isObj(v)
    ? []
    : Object.keys(v).filter((k) => !allowed.includes(k)).map((k) => {
        const near = closest(k, allowed);
        return {
          level: 'warning' as const,
          at: join(at, k),
          message: 'Unknown field "' + k + '" in ' + (at || 'the project') + '; this version ignores it.',
          allowed: [...allowed],
          fix: near ? 'Rename it to "' + near + '" if that is what you meant, otherwise remove it.' : 'Remove it.',
        };
      });

/** A fill that is a gradient: its fields and each stop's. A colour string has none. */
const fillKeys = (f: unknown, at: string, t: KeyTable): Problem[] =>
  !isObj(f) ? [] : [...extra(f, t.gradient, at), ...list(f.stops).flatMap((s, i) => extra(s, t.stop, at + '.stops[' + i + ']'))];

const cameraKeys = (c: unknown, at: string, t: KeyTable): Problem[] =>
  !isObj(c) ? [] : [...extra(c, t.camera, at), ...list(c.moves).flatMap((m, i) => extra(m, t.move, at + '.moves[' + i + ']'))];

const baseKeys = (b: unknown, at: string, t: KeyTable): Problem[] => {
  // With more than one of material / color / scene the schema already reports an error.
  if (!isObj(b) || ['material', 'color', 'scene'].filter((k) => k in b).length > 1) return [];
  const variant = 'material' in b ? t.base.material : 'color' in b ? t.base.color : 'scene' in b ? t.base.scene : t.base.material;
  return [...extra(b, variant, at), ...cameraKeys(b.camera, join(at, 'camera'), t), ...fillKeys(b.color, join(at, 'color'), t)];
};

const spanKeys = (spans: unknown, at: string, t: KeyTable): Problem[] =>
  list(spans).flatMap((s, i) => [...extra(s, t.textSpan, at + '[' + i + ']'), ...extra(isObj(s) ? s.background : undefined, t.background, at + '[' + i + '].background')]);

const spokenKeys = (s: unknown, at: string, t: KeyTable): Problem[] =>
  !isObj(s) ? [] : [...extra(s, t.spoken, at), ...extra(s.background, t.background, join(at, 'background')), ...extra(s.past, t.past, join(at, 'past'))];

const styleKeys = (style: unknown, at: string, t: KeyTable): Problem[] =>
  !isObj(style) ? [] : [
    ...extra(style, t.style, at),
    ...extra(style.stroke, t.stroke, join(at, 'stroke')),
    ...extra(style.background, t.background, join(at, 'background')),
    ...extra(style.shadow, t.shadow, join(at, 'shadow')),
    ...spanKeys(style.spans, join(at, 'spans'), t),
    ...spokenKeys(style.spoken, join(at, 'spoken'), t),
  ];

const cueKeys = (cues: unknown, at: string, t: KeyTable): Problem[] =>
  list(cues).flatMap((c, i) => {
    const here = at + '[' + i + ']';
    return isObj(c) ? [...extra(c, t.cue, here), ...extra(c.during, t.span, join(here, 'during')), ...spanKeys(c.spans, join(here, 'spans'), t)] : [];
  });

const segmentKeys = (s: unknown, at: string, t: KeyTable): Problem[] =>
  !isObj(s) ? [] : [...extra(s, t.segment, at), ...baseKeys(s.base, join(at, 'base'), t), ...extra(s.in, t.transition, join(at, 'in'))];

const trackKeys = (tr: unknown, at: string, t: KeyTable): Problem[] => {
  if (!isObj(tr) || typeof tr.type !== 'string' || !t.tracks[tr.type]) return [];
  return [
    ...extra(tr, t.tracks[tr.type] ?? [], at),
    ...extra(tr.during, t.span, join(at, 'during')),
    ...extra(tr.enter, t.motion, join(at, 'enter')),
    ...extra(tr.exit, t.motion, join(at, 'exit')),
    ...styleKeys(tr.style, join(at, 'style'), t),
    ...extra(tr.border, t.border, join(at, 'border')),
    ...extra(tr.shadow, t.shadow, join(at, 'shadow')),
    ...extra(tr.loop, t.loop, join(at, 'loop')),
    ...fillKeys(tr.color, join(at, 'color'), t),
    ...cueKeys(tr.cues, join(at, 'cues'), t),
  ];
};

/** Warnings for fields the schema does not know (zod strips them silently). */
export const unknownKeyProblems = (json: unknown, t: KeyTable): Problem[] => {
  if (!isObj(json)) return [];
  return [
    ...extra(json, t.root, ''),
    ...extra(json.canvas, t.canvas, 'canvas'),
    ...list(json.materials).flatMap((m, i) => extra(m, t.material, 'materials[' + i + ']')),
    ...list(json.segments).flatMap((s, i) => segmentKeys(s, 'segments[' + i + ']', t)),
    ...list(json.tracks).flatMap((tr, i) => trackKeys(tr, 'tracks[' + i + ']', t)),
  ];
};
