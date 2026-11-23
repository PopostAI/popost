/**
 * A shot longer than a material can be is cut into parts of equal length, with hard cuts between them. A template
 * whose shots are filled by generated clips needs this: a generator makes clips of a few seconds, and one of them
 * cannot cover a shot of thirteen. The cuts are ours, not the reference's: they are written with confidence 0.
 */
import type { Boundary, Measure, ShotMeasure } from '../types';

export const splitLongShots = (m: Measure, maxSeconds: number): { measure: Measure; added: number } => {
  const max = Math.max(1, Math.floor(maxSeconds * m.source.fps));
  const shots: ShotMeasure[] = [];
  const boundaries: Boundary[] = [];
  for (const [k, s] of m.shots.entries()) {
    const into = k > 0 ? m.boundaries[k - 1] : undefined;
    if (into) boundaries.push(into);
    const parts = Math.max(1, Math.ceil((s.end - s.start) / max));
    for (let p = 0; p < parts; p++) {
      const start = s.start + Math.round(((s.end - s.start) * p) / parts);
      const end = s.start + Math.round(((s.end - s.start) * (p + 1)) / parts);
      if (p > 0) boundaries.push({ frame: start, kind: 'cut', start: start - 1, end: start, confidence: 0 });
      shots.push({ ...s, index: shots.length, start, end, events: s.events.filter((e) => e.start >= start && e.start < end) });
    }
  }
  return { measure: { ...m, shots, boundaries }, added: shots.length - m.shots.length };
};
