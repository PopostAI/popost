/**
 * compareTracks: the trajectories of the reference (measure/tracks.ts) against the other video's, one by one. A path
 * of the reference is paired with the other's path of the same sort that lies nearest in time (the reference's seconds
 * mapped as compareShots maps them); what is told of both is the path angle, the size, the duration and, for a
 * transition, the shape of its edge, and 'differs' names in words what is not alike. An addition to the scores: nothing
 * here changes them.
 */
import type { Measure, Trajectory } from '../types';
import { fpsOf } from './pair';

/** What differs: angles this many degrees apart, sizes or durations in a ratio beyond these, places this far apart (fractions of the canvas). */
export const ANGLE_APART = 15;
export const SIZE_RATIO = 1.5;
export const TIME_RATIO = 1.33;
export const PLACE_APART = 0.15;
/** A path of the other video is the reference's when it starts within this many seconds of it. */
const NEAR_S = 1;

export interface TrackSide {
  /** Seconds of that video. */
  from: number;
  to: number;
  what: Trajectory['what'];
  /** An object or an element: its way and its size (fractions of the canvas). */
  pathAngle?: number;
  start?: [number, number];
  end?: [number, number];
  size?: [number, number];
  seconds: number;
  /** A transition: its edge, with the angle of a straight edge or a wedge and the centre of a circle. */
  edge?: string;
  edgeAngle?: number;
  centre?: [number, number];
}

export interface TrackDifference {
  /** The reference's path (tracks.json) and its shot, from 1. */
  id: string;
  shot: number;
  reference: TrackSide;
  /** Absent when the other video has no path there. */
  other?: TrackSide;
  differs: string[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

const sideOf = (t: Trajectory, fps: number): TrackSide => {
  const whole = t.reveal ?? t;
  const moving = t.what !== 'region';
  return {
    from: r2(whole.start / fps), to: r2(whole.end / fps), what: t.what, seconds: r2((whole.end - whole.start) / fps),
    ...(moving ? { pathAngle: t.path.angle, start: t.path.from, end: t.path.to, size: t.size } : {}),
    ...(t.reveal ? { edge: t.reveal.edge.shape, ...(t.reveal.edge.angle !== undefined ? { edgeAngle: t.reveal.edge.angle } : {}), ...(t.reveal.edge.centre ? { centre: t.reveal.edge.centre } : {}) } : {}),
  };
};

const apart = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const far = (a: [number, number], b: [number, number]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) > PLACE_APART;
const ratio = (a: number, b: number): number => Math.max(a, b) / Math.max(1e-6, Math.min(a, b));
const pct = (v: number): string => Math.round(v * 100) + '%';
const at = (p: [number, number]): string => '[' + p[0].toFixed(2) + ', ' + p[1].toFixed(2) + ']';
const deg = (v: number): string => (Math.round(v) || 0) + ' degrees';

/** What is not alike between the two sides, each as a sentence with both numbers (the reference's first). */
export const trackDifferences = (a: TrackSide, b: TrackSide): string[] => {
  const out: string[] = [];
  if (a.what === 'object' && b.what !== 'object') out.push('the reference\'s change is led by an object of ' + pct(a.size?.[0] ?? 0) + ' x ' + pct(a.size?.[1] ?? 0) + ' of the canvas that travels at ' + deg(a.pathAngle ?? 0) + '; the other\'s has no object large enough to follow');
  if (a.what !== 'object' && b.what === 'object') out.push('the other\'s change is led by an object; the reference\'s is not');
  if (a.pathAngle !== undefined && b.pathAngle !== undefined) {
    if (apart(a.pathAngle, b.pathAngle) > ANGLE_APART) out.push('path angle ' + deg(a.pathAngle) + ' against ' + deg(b.pathAngle));
    if (a.start && b.start && far(a.start, b.start)) out.push('it starts at ' + at(a.start) + ' against ' + at(b.start));
    if (a.end && b.end && far(a.end, b.end)) out.push('it ends at ' + at(a.end) + ' against ' + at(b.end));
    const sa = Math.max(...(a.size ?? [0, 0])), sb = Math.max(...(b.size ?? [0, 0]));
    if (ratio(sa, sb) > SIZE_RATIO) out.push('size ' + pct(a.size?.[0] ?? 0) + ' x ' + pct(a.size?.[1] ?? 0) + ' of the canvas against ' + pct(b.size?.[0] ?? 0) + ' x ' + pct(b.size?.[1] ?? 0));
  }
  if (ratio(a.seconds, b.seconds) > TIME_RATIO) out.push('it lasts ' + a.seconds.toFixed(2) + ' s against ' + b.seconds.toFixed(2) + ' s');
  if (a.edge !== undefined && b.edge !== undefined) {
    if (a.edge !== b.edge) out.push('the new picture opens with a ' + a.edge + ' edge against a ' + b.edge + ' one' + (b.centre ? ' (a circle about ' + at(b.centre) + ')' : ''));
    else if (a.edgeAngle !== undefined && b.edgeAngle !== undefined && apart(a.edgeAngle, b.edgeAngle) > ANGLE_APART) out.push('the ' + a.edge + ' edge points at ' + deg(a.edgeAngle) + ' against ' + deg(b.edgeAngle));
    else if (a.centre && b.centre && far(a.centre, b.centre)) out.push('the circle is about ' + at(a.centre) + ' against ' + at(b.centre));
  }
  return out;
};

/** map: seconds of the reference to seconds of the other video. */
export const compareTracks = (ref: Measure, other: Measure, map: (t: number) => number): TrackDifference[] => {
  const fa = fpsOf(ref), fb = fpsOf(other);
  const taken = new Set<string>();
  return (ref.tracks ?? []).map((t): TrackDifference => {
    const reference = sideOf(t, fa);
    const wanted = map(reference.from);
    const near = (other.tracks ?? []).filter((o) => o.of === t.of && !taken.has(o.id))
      .map((o) => ({ o, d: Math.abs((o.reveal ?? o).start / fb - wanted) })).filter((x) => x.d <= NEAR_S).sort((x, y) => x.d - y.d)[0];
    if (!near) return { id: t.id, shot: t.shot, reference, differs: ['the other video has no path that could be measured within ' + NEAR_S + ' s of ' + r2(wanted) + ' s: ' + (t.of === 'transition' ? 'its change there moves or mixes its pictures, or is a cut' : 'no element travels there')] };
    taken.add(near.o.id);
    const side = sideOf(near.o, fb);
    return { id: t.id, shot: t.shot, reference, other: side, differs: trackDifferences(reference, side) };
  });
};
