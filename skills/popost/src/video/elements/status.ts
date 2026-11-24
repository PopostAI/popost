/**
 * The labels of elements.json ("status": measured, inferred, unknown) held to the reading. A field labelled "measured"
 * must be something the reading measures and must agree with it; a field the reading measured that the entry
 * contradicts must say why (a note on its label, or the description of the change), labelled or not. Counts the labels,
 * for the summary. Pure.
 */
import { fitsPoorly, transitionFile } from '../describe/frames';
import { ownEffect, trackBrief } from '../describe/paths';
import { warning } from '../project/check-common';
import type { Boundary, KnownAs, Measure, Problem, Trajectory } from '../types';
import type { ReadElements } from './read';
import { labelOf, MEASURABLE, type FieldStatus, type ShotReading } from './types';

/** A length in seconds contradicts the measured one when it is off by more than SECONDS_OFF of it, and by more than SECONDS_SLACK. */
export const SECONDS_OFF = 0.3;
export const SECONDS_SLACK = 0.2;

const two = (n: number): string => String(n).padStart(2, '0');

/** How long the change into shot n (from 1) lasts in the measurement: its path's whole span when it has one, else its mixed frames. */
export const measuredSeconds = (m: Measure, n: number): { seconds: number; from: string; track?: Trajectory } | undefined => {
  const b = m.boundaries[n - 2];
  if (!b || b.kind === 'cut') return undefined;
  const track = m.tracks?.find((t) => t.of === 'transition' && t.shot === n);
  const fps = m.source.fps;
  return track?.reveal ? { seconds: Math.round(((track.reveal.end - track.reveal.start) / fps) * 100) / 100, from: 'its path, frames ' + track.reveal.start + '-' + track.reveal.end, track }
    : { seconds: Math.round((Math.max(0, b.end - b.start - 1) / fps) * 100) / 100, from: 'its mixed frames ' + (b.start + 1) + '-' + (b.end - 1) };
};

/** Fields labelled "measured" that the reading does not measure: what a thing is, what it is for, how to draw it. */
const notMeasurable = (status: FieldStatus | undefined, at: string, what: string): Problem[] =>
  Object.keys(status ?? {}).filter((k) => labelOf(status, k).status === 'measured' && !MEASURABLE.includes(k)).map((k) =>
    warning(at + '.status.' + k, '"' + k + '" of ' + what + ' is labelled "measured", and the reading measures no such thing: it is what you saw in the frames.', 'Write "' + k + '": "inferred" ("measured" is for a value copied from shots/NN.md or timeline.md).'));

const transitionProblems = (s: ShotReading, b: Boundary, m: Measure, at: string): Problem[] => {
  const t = s.transitionIn;
  if (!t) return [];
  const here = at + '.transitionIn', out: Problem[] = [];
  const kind = labelOf(t.status, 'kind'), seconds = labelOf(t.status, 'seconds');
  const pic = b.kind === 'cut' ? 'shots/' + two(s.shot) + '-frames.jpg' : transitionFile(s.shot);
  const said = Boolean(t.description || kind.note);
  const measured = measuredSeconds(m, s.shot);
  const track = measured?.track;
  // A change the measurement followed as an object-led or shaped reveal is no standard transition.
  if (track && ownEffect(track) && t.kind !== 'custom' && !said)
    out.push(warning(here + '.kind', 'The measurement followed the change into shot ' + s.shot + ' as an effect of its own (' + trackBrief(track, m.source.fps).replace('path: ', '') + '), and the entry calls it "' + t.kind + '" without saying why.',
      'Look at ' + pic + ' and the "Paths" of shots/' + two(s.shot) + '.md. Write "kind": "custom" with a "description" set from the measured path, or say in "description" what makes it a ' + t.kind + '.'));
  else if (t.kind !== 'custom' && t.kind !== b.kind && !fitsPoorly(b) && b.confidence >= 0.4 && !said)
    out.push(warning(here + '.kind', 'The measurement read the change into shot ' + s.shot + ' as "' + b.kind + '" (confidence ' + b.confidence.toFixed(2) + ', its model explains the frames), and the entry says "' + t.kind + '" without saying why.',
      'Look at ' + pic + '. Keep "' + b.kind + '" with "status": {"kind": "measured"}, or keep "' + t.kind + '" and say what the frames show: "status": {"kind": {"status": "inferred", "note": "..."}}.'));
  if (kind.status === 'measured' && t.kind !== b.kind)
    out.push(warning(here + '.status.kind', 'The kind of the change into shot ' + s.shot + ' is labelled "measured", and the measurement says "' + b.kind + '", not "' + t.kind + '".', 'Label it "inferred" (what you saw in the frames), or copy the measured kind.'));
  if (measured && t.seconds !== undefined && Math.abs(t.seconds - measured.seconds) > Math.max(SECONDS_SLACK, SECONDS_OFF * measured.seconds) && (seconds.status === 'measured' || !seconds.note))
    out.push(warning(here + '.seconds', 'The change into shot ' + s.shot + ' lasts ' + measured.seconds.toFixed(2) + ' s in the measurement (' + measured.from + '), and the entry says ' + t.seconds + ' s' + (seconds.status === 'measured' ? ', labelled "measured"' : '') + '.',
      'Copy ' + measured.seconds.toFixed(2) + ' with "status": {"seconds": "measured"}, or keep yours and say why: "status": {"seconds": {"status": "inferred", "note": "..."}}.'));
  return [...out, ...notMeasurable(t.status, here, 'the change into shot ' + s.shot)];
};

/** The problems of the labels against the measurement. */
export const statusProblems = (r: ReadElements, m: Measure, at: (shot: number) => string): Problem[] =>
  r.elements.shots.flatMap((s) => {
    const here = at(s.shot), b = m.boundaries[s.shot - 2];
    return [
      ...notMeasurable(s.status, here, 'shot ' + s.shot),
      ...(b ? transitionProblems(s, b, m, here) : []),
      ...s.layers.flatMap((l, j) => notMeasurable(l.status, here + '.layers[' + j + ']', 'layer "' + l.id + '"')),
    ];
  });

/** A shot with a field labelled "unknown" has an entry in "unrecovered" that says what was assumed instead. */
export const unknownProblems = (r: ReadElements, at: (shot: number) => string): Problem[] =>
  r.elements.shots.flatMap((s) => {
    const maps: [FieldStatus | undefined, string, number][] = [[s.status, 'shot ' + s.shot, s.shot], [s.transitionIn?.status, 'the change into shot ' + s.shot, s.shot], ...s.layers.map((l): [FieldStatus | undefined, string, number] => [l.status, 'layer "' + l.id + '" of shot ' + s.shot, s.shot])];
    const unknown = maps.flatMap(([m, what]) => Object.keys(m ?? {}).filter((k) => labelOf(m, k).status === 'unknown').map((k) => '"' + k + '" of ' + what));
    const listed = (r.elements.unrecovered ?? []).some((u) => u.where.shot === s.shot || u.where.transition === s.shot || (u.where.time !== undefined && u.where.time[0] < s.time[1] && u.where.time[1] > s.time[0]));
    return unknown.length && !listed ? [warning(at(s.shot) + '.status', unknown.join(', ') + ' ' + (unknown.length === 1 ? 'is' : 'are') + ' labelled "unknown", and "unrecovered" has no entry for shot ' + s.shot + '.',
      'Add to "unrecovered" (beside "shots"): {"what": "...", "where": {"shot": ' + s.shot + '}, "why": "...", "assumed": "what the re-make does instead"}: the delivery notes carry it forward.')] : [];
  });

export interface LabelCounts { measured: number; inferred: number; unknown: number; unlabelledShots: number[] }

/** How many fields carry each label, and the shots whose entry carries none. */
export const countLabels = (r: ReadElements): LabelCounts => {
  const out: LabelCounts = { measured: 0, inferred: 0, unknown: 0, unlabelledShots: [] };
  for (const s of r.elements.shots) {
    const maps = [s.status, s.transitionIn?.status, ...s.layers.map((l) => l.status)];
    const labels = maps.flatMap((x) => Object.keys(x ?? {}).map((k) => labelOf(x, k).status)).filter((x): x is KnownAs => x !== undefined);
    for (const l of labels) out[l]++;
    if (!labels.length) out.unlabelledShots.push(s.shot);
  }
  return out;
};
