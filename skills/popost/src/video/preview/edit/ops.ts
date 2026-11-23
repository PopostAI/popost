/**
 * The operations of POST /api/edit: small, exact changes to the JSON of video.json, addressed by a path of object keys
 * and array indexes (["tracks", 2, "box"], or the same as text: "tracks[2].box", the form check's problems use).
 * Pure: nothing here reads or writes a file. Whether the result is a valid project is decided afterwards by the
 * schema and check (edit/check.ts); here only the path is checked against the JSON it walks.
 */
import { pathText } from '../../project/issues';
import type { Problem } from '../../types';

export type PathKey = string | number;
export type EditPath = readonly PathKey[];

/**
 * set:    the value at path: an object's field (new or existing), or an existing entry of an array.
 * insert: path ends in an index of an array; the value goes in before that entry (index = length appends).
 * remove: an array's entry (the entries after it move up) or an object's field.
 * move:   path ends in an index of an array; the entry moves to index "to" of the same array (the order of tracks).
 */
export type EditOp =
  | { op: 'set'; path: EditPath; value: unknown }
  | { op: 'insert'; path: EditPath; value: unknown }
  | { op: 'remove'; path: EditPath }
  | { op: 'move'; path: EditPath; to: number };

export const OP_KINDS = ['set', 'insert', 'remove', 'move'] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Deeper than any field of video.json; a longer path is a mistake or an attack. */
const MAX_DEPTH = 24;
/** Keys that would reach the prototype of an object instead of a field. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIndex = (k: PathKey): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 0;

const refuse = (path: EditPath, message: string, fix: string): Problem => ({ level: 'error', at: path.length ? pathText(path) : '(root)', message, fix });

const KEY_RE = /\[(\d+)\]|([^.[\]]+)/g;

/** ["tracks", 2, "box"] from "tracks[2].box"; undefined when the text is not a path in that form. */
export const parsePath = (text: string): PathKey[] | undefined => {
  const keys = Array.from(text.matchAll(KEY_RE), (m) => (m[1] !== undefined ? Number(m[1]) : (m[2] ?? '')));
  return keys.length > 0 && pathText(keys) === text ? keys : undefined;
};

const readPath = (raw: unknown): PathKey[] | string => {
  if (typeof raw === 'string') return parsePath(raw) ?? 'the path "' + raw + '" is not in the form tracks[2].box';
  if (!Array.isArray(raw)) return '"path" must be a list of keys and indexes, like ["tracks", 2, "box"], or the text "tracks[2].box"';
  const bad = raw.find((k) => !(typeof k === 'string' && k.length > 0) && !isIndex(k as PathKey));
  return bad === undefined ? (raw as PathKey[]) : 'the key ' + JSON.stringify(bad) + ' is neither a field name nor a whole index from 0';
};

const OP_FIX = 'Send { "op": "set", "path": ["tracks", 0, "box"], "value": [0.1, 0.1, 0.8, 0.2] }; ops: ' + OP_KINDS.join(', ') + '.';

/** The operation in a request body, or a problem that says what is wrong with it. */
export const readOp = (body: unknown): { op: EditOp } | { problem: Problem } => {
  if (!isObj(body) || typeof body.op !== 'string' || !(OP_KINDS as readonly string[]).includes(body.op))
    return { problem: { level: 'error', at: '(request)', message: 'The body is not an edit operation: "op" must be one of ' + OP_KINDS.join(', ') + '.', allowed: [...OP_KINDS], fix: OP_FIX } };
  const path = readPath(body.path);
  if (typeof path === 'string') return { problem: { level: 'error', at: '(request)', message: 'The operation cannot be applied: ' + path + '.', fix: OP_FIX } };
  if (path.length === 0 || path.length > MAX_DEPTH) return { problem: refuse(path, 'The path must name a field inside the project, at most ' + MAX_DEPTH + ' keys deep.', 'Name the field, for example ["tracks", 0, "text"].') };
  const forbidden = path.find((k) => typeof k === 'string' && FORBIDDEN.has(k));
  if (forbidden !== undefined) return { problem: refuse(path, 'The key "' + String(forbidden) + '" is not a field of video.json.', 'Use the names of the project format only.') };
  const kind = body.op as OpKind;
  if ((kind === 'set' || kind === 'insert') && !('value' in body)) return { problem: refuse(path, '"' + kind + '" needs a "value".', kind === 'set' ? 'Add "value", or use "remove" to delete the field.' : 'Add "value": the entry to insert.') };
  if (kind === 'move' && !isIndex(body.to as PathKey)) return { problem: refuse(path, '"move" needs "to", a whole index from 0.', 'Add "to": the index the entry should have afterwards.') };
  switch (kind) {
    case 'set': case 'insert': return { op: { op: kind, path, value: body.value } };
    case 'remove': return { op: { op: kind, path } };
    case 'move': return { op: { op: kind, path, to: body.to as number } };
  }
};

const kindOf = (v: unknown): string => (Array.isArray(v) ? 'a list' : isObj(v) ? 'an object' : v === undefined ? 'nothing' : 'a ' + (v === null ? 'null' : typeof v) + ' value');

/** The container at path (all but the last key), or a problem naming the first key that does not fit what it walks. */
const walk = (json: Json, path: EditPath): { parent: Json } | { problem: Problem } => {
  let node = json;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as PathKey;
    const here = path.slice(0, i + 1);
    if (Array.isArray(node) ? !(isIndex(key) && key < node.length) : !(isObj(node) && typeof key === 'string' && Object.hasOwn(node, key)))
      return { problem: refuse(here, 'There is nothing at ' + pathText(here) + ': ' + (i > 0 ? pathText(path.slice(0, i)) : 'the project') + ' is ' + kindOf(node) + (Array.isArray(node) ? ' of ' + node.length + ' entries' : '') + '.', 'Set the nearest field that exists, with the whole value under it.') };
    node = Array.isArray(node) ? node[key as number] : (node as Obj)[key as string];
  }
  return { parent: node };
};

/** Checks the last key against its container for the operation; undefined when it fits. */
const lastKeyProblem = (op: EditOp, parent: Json): Problem | undefined => {
  const key = op.path[op.path.length - 1] as PathKey;
  const where = op.path.length > 1 ? pathText(op.path.slice(0, -1)) : 'the project';
  if (Array.isArray(parent)) {
    const max = op.op === 'insert' ? parent.length : parent.length - 1;
    if (!isIndex(key) || key > max) return refuse(op.path, where + ' is a list of ' + parent.length + ' entries; ' + JSON.stringify(key) + ' is not an index ' + (op.op === 'insert' ? 'to insert at (0..' + max + ')' : 'of it') + '.', op.op === 'set' ? 'Use "insert" to add an entry.' : 'Use an index from 0 to ' + max + '.');
    if (op.op === 'move' && op.to > parent.length - 1) return refuse(op.path, '"to" is ' + op.to + ', but ' + where + ' has ' + parent.length + ' entries.', 'Use "to" from 0 to ' + (parent.length - 1) + '.');
    return undefined;
  }
  if (!isObj(parent)) return refuse(op.path, where + ' is ' + kindOf(parent) + ', which has no fields.', 'Set ' + where + ' itself.');
  if (typeof key !== 'string') return refuse(op.path, where + ' is an object; an index cannot address it.', 'Use a field name.');
  if (op.op === 'insert' || op.op === 'move') return refuse(op.path, '"' + op.op + '" works on the entries of a list, and ' + where + ' is an object.', 'Use "set" or "remove" for a field.');
  if (op.op === 'remove' && !Object.hasOwn(parent, key)) return refuse(op.path, where + ' has no field "' + key + '" to remove.', 'Remove a field that exists.');
  return undefined;
};

const changeLast = (op: EditOp, parent: Json): Json => {
  const key = op.path[op.path.length - 1] as PathKey;
  if (Array.isArray(parent)) {
    const i = key as number;
    switch (op.op) {
      case 'set': return parent.map((x, j) => (j === i ? op.value : x));
      case 'insert': return [...parent.slice(0, i), op.value, ...parent.slice(i)];
      case 'remove': return parent.filter((_x, j) => j !== i);
      case 'move': {
        const rest = parent.filter((_x, j) => j !== i);
        return [...rest.slice(0, op.to), parent[i], ...rest.slice(op.to)];
      }
    }
  }
  const obj = parent as Obj;
  if (op.op === 'remove') return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
  return { ...obj, [key as string]: (op as { value: unknown }).value };
};

/** A copy of node with the container at path replaced by fn of it; containers off the path are shared. */
const replaceAt = (node: Json, path: EditPath, fn: (parent: Json) => Json): Json => {
  if (path.length === 0) return fn(node);
  const [key, ...rest] = path as [PathKey, ...PathKey[]];
  if (Array.isArray(node)) return node.map((x, j) => (j === key ? replaceAt(x, rest, fn) : x));
  return { ...(node as Obj), [key as string]: replaceAt((node as Obj)[key as string], rest, fn) };
};

/** The JSON after the operation, or the problem with its path. The input is not changed. */
export const applyOp = (json: Json, op: EditOp): { json: Json } | { problem: Problem } => {
  const walked = walk(json, op.path);
  if ('problem' in walked) return walked;
  const problem = lastKeyProblem(op, walked.parent);
  if (problem) return { problem };
  return { json: replaceAt(json, op.path.slice(0, -1), (parent) => changeLast(op, parent)) };
};

/** The value at path, or undefined. */
export const valueAt = (json: Json, path: EditPath): Json =>
  path.reduce<Json>((node, k) => (Array.isArray(node) ? node[k as number] : isObj(node) ? (Object.hasOwn(node, String(k)) ? node[String(k)] : undefined) : undefined), json);

const ID_LISTS = new Set(['tracks', 'segments', 'materials']);

/**
 * A name for what an operation touched, for the status line: an entry of tracks, segments or materials by its id
 * ("title.box" for tracks[2].box), anything else by its path.
 */
export const labelOf = (json: Json, path: EditPath): string => {
  const [list, index, ...rest] = path;
  const entry = typeof list === 'string' && ID_LISTS.has(list) && typeof index === 'number' ? valueAt(json, [list, index]) : undefined;
  const id = isObj(entry) && typeof entry.id === 'string' ? entry.id : undefined;
  if (id === undefined) return pathText(path);
  return rest.length ? id + (typeof rest[0] === 'number' ? '' : '.') + pathText(rest) : id;
};

/** The label of an operation: for an insert, the id of the inserted entry when it has one. */
export const opLabel = (before: Json, after: Json, op: EditOp): string => (op.op === 'remove' ? labelOf(before, op.path) : op.op === 'move' ? labelOf(after, [...op.path.slice(0, -1), op.to]) : labelOf(after, op.path));
