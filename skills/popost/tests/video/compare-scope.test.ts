import { describe, expect, it } from 'vitest';
import { comparisonScope } from '../../src/video/commands/compare-scope';
import { referenceFingerprint } from '../../src/video/template/fingerprint';
import type { ReferenceFacts } from '../../src/video/template/facts';
import type { Measure } from '../../src/video/types';

const reference: Measure = {
  version: 1, source: { width: 960, height: 720, fps: 30, frames: 300, duration: 10, hasAudio: true },
  shots: [0, 90, 210].map((start, index) => ({ index, start, end: [90, 210, 300][index]!, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#111111', palette: [], events: [] })),
  boundaries: [{ frame: 90, start: 89, end: 90, kind: 'cut', confidence: 1 }, { frame: 210, start: 209, end: 210, kind: 'cut', confidence: 1 }],
  rhythm: { step: 3, change: Array.from({ length: 100 }, () => 0.1) },
  signature: { every: 3, width: 1, height: 1, count: 100, data: 'reference-visual-samples' },
};
const facts: ReferenceFacts = { format: 'popost-video-reference-facts', version: 1, template: { name: 'demo', label: 'demo', measure: 'sha256:kept', fingerprint: referenceFingerprint(reference) }, canvas: { width: 960, height: 720, fps: 30 }, shots: [], omittedShots: [{ shot: 3, seconds: [7, 10], reason: 'Platform endcard' }] };

describe('reference scope for a recreated video', () => {
  it('excludes only the declared platform tail after verifying the full source identity', () => {
    const r = comparisonScope(reference, facts);
    expect(r.measure.source.frames).toBe(210);
    expect(r.measure.shots).toHaveLength(2);
    expect(r.measure.rhythm.change).toHaveLength(70);
    expect(r.omitted).toEqual(facts.omittedShots);
    expect(reference.source.frames).toBe(300);
  });
  it('keeps the complete source for an unrelated reference, missing provenance or an interior omission', () => {
    expect(comparisonScope({ ...reference, signature: { ...reference.signature, data: 'other-source' } }, facts).omitted).toBeUndefined();
    expect(comparisonScope(reference, { ...facts, template: { ...facts.template, fingerprint: undefined } }).measure).toBe(reference);
    expect(comparisonScope(reference, { ...facts, omittedShots: [{ shot: 2, seconds: [3, 7], reason: 'Interior' }] }).measure).toBe(reference);
    expect(comparisonScope(reference, { ...facts, omittedShots: [{ shot: 3, seconds: [6, 10], reason: 'Not a whole shot' }] }).measure).toBe(reference);
  });
});
