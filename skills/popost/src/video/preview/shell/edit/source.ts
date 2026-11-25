/**
 * Pure helpers of edit mode: what in video.json a selection points at (the SOURCE, not the resolved timeline), the
 * paths of its fields, frames of a span and back, snapping, and the entries that adding and duplicating insert.
 * No DOM, so they can be tested in Node.
 */
import type { EditOp, EditPath } from '../../edit/ops';
import type { PreviewState } from '../../protocol';
import type { Resolved, ResolvedSegment } from '../../../types';
import { segmentAt, toTimeline, type Selection } from '../model';

export type Obj = Record<string, unknown>;
export type Path = (string | number)[];
export type { EditOp, EditPath };

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const listOf = (v: unknown, key: string): unknown[] => (isObj(v) && Array.isArray(v[key]) ? v[key] : []);

/** A track (visual, caption or audio), one cue of a caption track, or a segment, with its index in video.json. */
export type Target =
  | { kind: 'track'; index: number; track: Obj }
  | { kind: 'cue'; index: number; cue: number; track: Obj }
  | { kind: 'segment'; index: number; segment: Obj };

export const tracksOf = (s: PreviewState): Obj[] => listOf(s.source, 'tracks').filter(isObj);
export const segmentsOf = (s: PreviewState): Obj[] => listOf(s.source, 'segments').filter(isObj);
export const materialsOf = (s: PreviewState, kinds: readonly string[]): string[] =>
  listOf(s.source, 'materials').filter(isObj).filter((m) => kinds.includes(String(m.kind))).map((m) => String(m.id));

const indexById = (list: unknown[], id: string): number => list.findIndex((x) => isObj(x) && x.id === id);

/** "cap#2" -> the caption track "cap" and its cue 2 (the resolved item, or its id when the project has errors). */
const cueOf = (s: PreviewState, id: string): { track: string; index: number } | undefined => {
  const item = s.resolved?.items.find((x) => x.id === id);
  if (item) return item.cue;
  const m = id.match(/^(.+)#(\d+)$/);
  return m ? { track: m[1] ?? '', index: Number(m[2]) } : undefined;
};

export const targetOf = (s: PreviewState, sel: Selection | null): Target | undefined => {
  if (!sel || !isObj(s.source)) return undefined;
  const tracks = listOf(s.source, 'tracks');
  if (sel.kind === 'segment') {
    const index = indexById(listOf(s.source, 'segments'), sel.id);
    const segment = listOf(s.source, 'segments')[index];
    return isObj(segment) ? { kind: 'segment', index, segment } : undefined;
  }
  if (sel.kind !== 'item' && sel.kind !== 'audio') return undefined;
  const direct = indexById(tracks, sel.id);
  const track = tracks[direct];
  if (isObj(track) && track.type !== 'caption') return { kind: 'track', index: direct, track };
  const cue = sel.kind === 'item' ? cueOf(s, sel.id) : undefined;
  const index = cue ? indexById(tracks, cue.track) : -1;
  const owner = tracks[index];
  return cue && isObj(owner) && cue.index < listOf(owner, 'cues').length ? { kind: 'cue', index, cue: cue.index, track: owner } : undefined;
};

export const basePath = (t: Target): Path => (t.kind === 'segment' ? ['segments', t.index] : ['tracks', t.index]);

/** Where the frames of the target are: its "during" (a cue's own), or undefined (a segment; an audio track without one). */
export const spanPath = (t: Target): Path | undefined => {
  if (t.kind === 'cue') return ['tracks', t.index, 'cues', t.cue, 'during'];
  if (t.kind === 'track' && isObj(t.track.during)) return ['tracks', t.index, 'during'];
  return undefined;
};

/** Where the box of the target is (a cue's box is its track's). */
export const boxPath = (t: Target): Path | undefined => (t.kind !== 'segment' && Array.isArray(t.track.box) ? ['tracks', t.index, 'box'] : undefined);

export const valueAt = (root: unknown, path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>((node, k) => (Array.isArray(node) ? node[k as number] : isObj(node) ? node[String(k)] : undefined), root);

/** The box of a target as four numbers, or undefined. */
export const boxOf = (s: PreviewState, t: Target): [number, number, number, number] | undefined => {
  const p = boxPath(t);
  const b = p ? valueAt(s.source, p) : undefined;
  return Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number') ? (b as [number, number, number, number]) : undefined;
};

/**
 * The operation that gives path this value: set where the parent exists; otherwise set the nearest missing object
 * with the rest of the path inside it. undefined removes the field (nothing to do when it is absent).
 */
export const opFor = (root: unknown, path: Path, value: unknown): EditOp | undefined => {
  if (value === undefined) return valueAt(root, path) === undefined ? undefined : { op: 'remove', path };
  let i = path.length - 1;
  while (i > 0 && !isObj(valueAt(root, path.slice(0, i))) && !Array.isArray(valueAt(root, path.slice(0, i)))) i--;
  const nested = path.slice(i + 1).reduceRight<unknown>((v, k) => ({ [String(k)]: v }), value);
  return { op: 'set', path: path.slice(0, i + 1), value: nested };
};

/** A span placed in a segment, as absolute frames start .. end-1 before clamping; undefined for a phrase span. */
export const rawSpan = (r: Resolved, span: unknown): { start: number; end: number; segment: ResolvedSegment } | undefined => {
  if (!isObj(span) || span.phrase !== undefined || typeof span.segment !== 'string') return undefined;
  const segment = r.segments.find((x) => x.id === span.segment);
  if (!segment) return undefined;
  const from = typeof span.from === 'number' ? span.from : 0;
  const to = typeof span.to === 'number' ? span.to : segment.end - segment.start;
  return { start: segment.start + from, end: segment.start + to, segment };
};

/**
 * The span for frames start .. end-1: in its own segment while the start stays inside it, else in the segment the
 * start falls in (so a bar dragged into the next shot belongs to that shot).
 */
export const spanFor = (r: Resolved, span: Obj, start: number, end: number): Obj => {
  const own = r.segments.find((x) => x.id === span.segment);
  const seg = own && start >= own.start && start < own.end ? own : (segmentAt(r, start) ?? own ?? r.segments[0]);
  const base = seg?.start ?? 0;
  return { ...span, segment: seg?.id ?? span.segment, from: start - base, to: end - base };
};

export type SnapKind = 'frame' | 'playhead' | 'segment' | 'reference';
export interface SnapTarget { frame: number; kind: SnapKind }

/** What an edge may snap to: the playhead, segment borders, and the reference's measured boundaries (timeline frames). */
export const snapTargets = (s: PreviewState, playhead: number, segments = true): SnapTarget[] => {
  const r = s.resolved;
  const fps = r?.canvas.fps ?? 30;
  const m = s.referenceMeasure?.measure;
  return [
    { frame: playhead, kind: 'playhead' },
    ...(segments && r ? r.segments.flatMap((x) => [x.start, x.end]).map((frame) => ({ frame, kind: 'segment' as const })) : []),
    ...(m ? m.boundaries.map((b) => ({ frame: Math.round(toTimeline(b.frame, m.source.fps, fps)), kind: 'reference' as const })) : []),
  ];
};

/** Pixels within which an edge snaps. */
export const SNAP_PX = 4;

/** The nearest target within SNAP_PX of frame f (pxPerFrame: the lane's scale), else f itself, a whole frame. */
export const snapFrame = (f: number, targets: readonly SnapTarget[], pxPerFrame: number): SnapTarget => {
  const near = targets
    .map((t) => ({ t, d: Math.abs(t.frame - f) * pxPerFrame }))
    .filter((x) => x.d <= SNAP_PX)
    .sort((a, b) => a.d - b.d)[0];
  return near ? near.t : { frame: Math.round(f), kind: 'frame' };
};

/** The first of base, base-2, base-3, ... that no entry of the list uses. */
export const freeId = (taken: readonly Obj[], base: string): string => {
  const ids = new Set(taken.map((x) => String(x.id)));
  const stem = base.replace(/-\d+$/, '');
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) if (!ids.has(stem + '-' + n)) return stem + '-' + n;
};

/** A new text track at frame n, in the segment under it: two seconds long (or to the segment's end), centred. */
export const newTextTrack = (s: PreviewState, n: number, text: string): { op: EditOp; select: Selection } | undefined => {
  const r = s.resolved;
  const seg = r ? (segmentAt(r, n) ?? r.segments[r.segments.length - 1]) : undefined;
  if (!r || !seg) return undefined;
  const tracks = tracksOf(s);
  const id = freeId(tracks, 'text');
  const from = Math.max(0, n - seg.start);
  const to = Math.max(from + 1, Math.min(seg.end - seg.start, from + 2 * r.canvas.fps));
  const value = { id, type: 'text', text, box: [0.1, 0.42, 0.8, 0.12], during: { segment: seg.id, from, to }, style: 'subtitle' };
  return { op: { op: 'insert', path: ['tracks', tracks.length], value }, select: { kind: 'item', id } };
};

const shifted = (box: unknown): unknown =>
  Array.isArray(box) && box.length === 4 ? box.map((v, i) => (i < 2 && typeof v === 'number' ? Math.round((v + 0.03) * 1e5) / 1e5 : v)) : box;

/** A copy inserted after the original: a track with a new id and its box moved a little; a cue right after its end. */
export const duplicate = (s: PreviewState, t: Target): { op: EditOp; select: Selection } | undefined => {
  if (t.kind === 'segment') {
    const id = freeId(segmentsOf(s), String(t.segment.id));
    return { op: { op: 'insert', path: ['segments', t.index + 1], value: { ...t.segment, id } }, select: { kind: 'segment', id } };
  }
  if (t.kind === 'cue') {
    const cue = listOf(t.track, 'cues')[t.cue];
    const r = s.resolved;
    const span = r && isObj(cue) ? rawSpan(r, cue.during) : undefined;
    if (!isObj(cue) || !r || !span || !isObj(cue.during)) return undefined;
    const during = spanFor(r, cue.during, span.end, span.end + (span.end - span.start));
    return { op: { op: 'insert', path: ['tracks', t.index, 'cues', t.cue + 1], value: { ...cue, during } }, select: { kind: 'item', id: String(t.track.id) + '#' + (t.cue + 1) } };
  }
  const id = freeId(tracksOf(s), String(t.track.id));
  const value = { ...t.track, id, ...(Array.isArray(t.track.box) ? { box: shifted(t.track.box) } : {}) };
  return { op: { op: 'insert', path: ['tracks', t.index + 1], value }, select: { kind: t.track.type === 'audio' ? 'audio' : 'item', id } };
};

/** The operation that deletes the target. */
export const removal = (t: Target): EditOp =>
  t.kind === 'cue' && Array.isArray(t.track.cues) && t.track.cues.length > 1 ? { op: 'remove', path: ['tracks', t.index, 'cues', t.cue] } : { op: 'remove', path: basePath(t) };

/** Fractions rounded to 1e-5 (a fiftieth of a pixel on a 1920-pixel canvas), so the file stays readable. */
export const roundBox = (b: readonly number[]): [number, number, number, number] => b.map((v) => Math.round(v * 1e5) / 1e5) as [number, number, number, number];
