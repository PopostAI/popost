/**
 * How each value of a reading is known: measured, inferred or unknown, with a confidence where the measurement has one
 * and a few words on what it rests on. One rule per kind of value, so that measure.json ("known", by the value's path)
 * and the files a model reads (a tag in square brackets at the end of a line) say the same thing. Pure.
 */
import type { Boundary, Measure, ShotMeasure, Status, Trajectory } from '../types';
import { shotAmount } from '../measure/amount';
import { fitsPoorly } from './frames';

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** When the picture changes: always measured. */
export const whenKnown = (b: Boundary): Status => ({ status: 'measured', confidence: r2(b.confidence), basis: b.kind === 'cut' ? 'a jump of the picture between two frames' : 'the frames that differ from the settled pictures on both sides' });

/**
 * A change that a standard transition does not make: an object leads it, or its edge is neither straight nor a circle
 * about the middle of the frame (the two shapes of the engine's wipe).
 */
export const ownEffect = (t: Trajectory): boolean => {
  const e = t.reveal?.edge;
  if (t.of !== 'transition' || !e) return false;
  const centred = e.shape === 'circle' && e.centre !== undefined && Math.hypot(e.centre[0] - 0.5, e.centre[1] - 0.5) <= 0.15;
  return t.what === 'object' || !(e.shape === 'straight' || centred);
};

/**
 * The kind of a change: measured when its model explains the frames; inferred (the nearest model, named) when it does
 * not, or when the path measured for the change (track) is an effect of its own, which no standard kind makes.
 */
export const kindKnown = (b: Boundary, track?: Trajectory): Status => {
  if (b.kind === 'cut') return { status: 'measured', confidence: r2(b.confidence), basis: 'no frame in between' };
  if (track && ownEffect(track))
    return { status: 'inferred', confidence: r2(b.confidence), basis: 'its measured path is an effect of its own (' + (track.what === 'object' ? 'an object leads it' : 'its edge is ' + (track.reveal?.edge.shape === 'irregular' ? 'no standard shape' : 'a ' + track.reveal?.edge.shape)) + '); ' + b.kind + ' is the nearest standard kind' };
  if (fitsPoorly(b) || b.confidence < 0.4) return { status: 'inferred', confidence: r2(b.confidence), basis: 'no standard transition explains the frames' + (b.residual !== undefined ? ' (' + Math.round(b.residual * 100) + '% of the change unexplained)' : '') + '; ' + b.kind + ' is the nearest' };
  return { status: 'measured', confidence: r2(b.confidence), basis: 'the ' + b.kind + ' model explains the frames' + (b.residual !== undefined ? ' but ' + Math.round(b.residual * 100) + '% of the change' : '') };
};

export const cameraKnown = (s: ShotMeasure): Status =>
  s.camera.kind === 'unknown' ? { status: 'unknown', basis: 'the frames could not be laid onto each other: too little texture, or too short a shot' }
    : { status: 'measured', confidence: r2(s.camera.confidence), basis: 'frames a third of a second apart laid onto each other' };

export const trackKnown = (t: Trajectory): Status => ({ status: 'measured', confidence: r2(t.confidence), basis: t.method });

/** The shape of a transition's edge: unknown when no model parts the two pictures. */
export const edgeKnown = (t: Trajectory): Status | undefined => {
  const e = t.reveal?.edge;
  if (!e) return undefined;
  return e.shape === 'irregular' ? { status: 'unknown', basis: 'neither a straight edge, a circle nor a wedge parts the two pictures (best fit ' + e.fit.toFixed(2) + ')' }
    : { status: 'measured', confidence: e.fit, basis: 'a ' + e.shape + ' parts the two pictures on ' + Math.round(e.share * 100) + '% of the frames' };
};

/** The path of a change that is not a cut and has no trajectory: unknown, and why. */
export const NO_PATH: Status = { status: 'unknown', basis: 'the pictures move or mix during the change, or do not hold still around it' };
const COLOUR: Status = { status: 'measured', basis: 'the largest colour on the border of the shot\'s frames' };
const AMOUNT: Status = { status: 'measured', basis: 'the mean change of the gray picture between frames 1/15 s apart' };
const NO_AMOUNT: Status = { status: 'unknown', basis: 'the shot holds no frames clear of the changes around it' };

export const amountKnown = (m: Measure, k: number): Status => (shotAmount(m, k) === undefined ? NO_AMOUNT : AMOUNT);

/** Every labelled value of a measurement, by its path. */
export const knownOf = (m: Measure): Record<string, Status> => {
  const out: Record<string, Status> = {};
  m.boundaries.forEach((b, k) => {
    out['boundaries[' + k + '].frame'] = whenKnown(b);
    out['boundaries[' + k + '].kind'] = kindKnown(b, m.tracks?.find((t) => t.of === 'transition' && t.shot === k + 2));
    if (b.kind !== 'cut' && m.tracks && !m.tracks.some((t) => t.of === 'transition' && t.shot === k + 2)) out['boundaries[' + k + '].path'] = NO_PATH;
  });
  m.shots.forEach((s, k) => {
    out['shots[' + k + '].camera'] = cameraKnown(s);
    out['shots[' + k + '].background'] = COLOUR;
    if (m.motion) out['shots[' + k + '].motion'] = amountKnown(m, k);
    s.events.forEach((e, j) => { out['shots[' + k + '].events[' + j + ']'] = { status: 'measured', confidence: r2(e.confidence), basis: 'cells of the picture that change while the rest holds' }; });
  });
  (m.tracks ?? []).forEach((t, i) => {
    out['tracks[' + i + ']'] = trackKnown(t);
    const edge = edgeKnown(t);
    if (edge) out['tracks[' + i + '].reveal.edge'] = edge;
  });
  return out;
};

/** The tag at the end of a line: " [measured 0.76]", " [inferred 0.21: why]", " [unknown: why]". */
export const tag = (s: Status): string =>
  ' [' + s.status + (s.confidence !== undefined ? ' ' + s.confidence.toFixed(2) : '') + (s.status === 'measured' ? '' : ': ' + s.basis) + ']';

/** The legend of the tags, for the card. */
export const LEGEND = 'Every value says how it is known, in square brackets where it is given: [measured 0.76] was read off the frames by a program (with its confidence, 0 to 1, when it has one); [inferred: ...] is concluded from measured facts and may be wrong: the frames confirm or correct it; [unknown: ...] could not be read, with the reason. "(unsure)" marks an inferred value in timeline.md.';
