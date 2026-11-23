/**
 * scoreMeasures: two measurements compared dimension by dimension (design section 13.1). The videos may differ in
 * size and frame rate: everything is compared in seconds, boundaries within toleranceFrames of the reference's
 * frame rate (default 2). A dimension with nothing to compare (n = 0) is left out of the composite.
 */
import type { Dimension, DimensionScore, Measure, Score } from '../types';
import { DIMENSIONS } from '../types';
import { DEFAULT_WEIGHTS } from './weights';
import { fpsOf } from './pair';
import { camera, motion, structure, transitions } from './time';
import { colour, picture, rhythm } from './picture';

export interface ScoreOptions {
  weights?: Partial<Record<Dimension, number>>;
  toleranceFrames?: number;
}

export const scoreMeasures = (reference: Measure, other: Measure, opts: ScoreOptions = {}): Score => {
  const tol = (opts.toleranceFrames ?? 2) / fpsOf(reference);
  const dimensions: Record<Dimension, DimensionScore> = {
    structure: structure(reference, other, tol),
    transitions: transitions(reference, other, tol),
    camera: camera(reference, other),
    motion: motion(reference, other),
    rhythm: rhythm(reference, other),
    colour: colour(reference, other),
    picture: picture(reference, other),
  };
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  let sum = 0, wsum = 0;
  for (const d of DIMENSIONS) {
    const s = dimensions[d];
    if (s.n > 0 && weights[d] > 0) { sum += weights[d] * s.score; wsum += weights[d]; }
  }
  return { dimensions, composite: wsum > 0 ? Math.round((sum / wsum) * 1000) / 1000 : 0 };
};

const detailText = (d: DimensionScore['detail']): string =>
  Object.entries(d).map(([k, v]) => k + ' ' + (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v)).join(', ');

/** A small plain-text table: one line per dimension, then the composite. */
export const formatScore = (score: Score): string => {
  const rows = DIMENSIONS.map((d) => {
    const s = score.dimensions[d];
    return d.padEnd(12) + (s.n > 0 ? s.score.toFixed(3) : '  -  ').padStart(6) + String(s.n).padStart(6) + '  ' + detailText(s.detail);
  });
  return ['dimension    score     n  detail', ...rows, 'composite'.padEnd(12) + score.composite.toFixed(3).padStart(6)].join('\n');
};
