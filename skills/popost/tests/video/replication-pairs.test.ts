import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createTestRuntime } from '../../src/testing/memory';
import type { Runtime } from '../../src/runtime';
import { checkPairs, readPairs, validatePairs, type PairEvidence, type PairFileFacts, type PairManifest, type PairUse } from '../../src/video/replication/pairs';

const a = new Uint8Array([1, 2, 3]), b = new Uint8Array([4, 5, 6]);
const evidence: PairEvidence = { kind: 'observed', source: 'https://example.org/demos#pair-a', sourcePairId: 'official-a',
  referenceSha256: sha256(a), remakeSha256: sha256(b), detail: 'The original and remake are explicitly paired by the publisher; the product and presenter changes were inspected.' };
const manifest = (): PairManifest => ({ version: 1, pairs: [{ id: 'demo-a', sourcePairId: 'official-a', relationship: 'Original and remake, with a new presenter.', evidence: [evidence],
  reference: { file: 'assets/original.mp4', sha256: sha256(a), source: 'https://example.org/original.mp4', product: 'lash product', character: 'presenter A', stage: 'product demonstration', sourceFps: 30, trim: { in: 420, out: 804, unit: 'frames' } },
  remake: { file: 'assets/remake.mp4', sha256: sha256(b), source: 'https://example.org/remake.mp4', product: 'lash product', character: 'presenter B', stage: 'product demonstration', sourceFps: 24, trim: { in: 0, out: 307, unit: 'frames' } },
}] });
const files: Record<string, PairFileFacts> = { 'assets/original.mp4': { sha256: sha256(a), fps: 30, frames: 812 }, 'assets/remake.mp4': { sha256: sha256(b), fps: 24, frames: 351 } };
const use: PairUse = { pairId: 'demo-a', side: 'reference', file: 'assets/original.mp4', sourceFps: 30, trim: { in: 420, out: 600, unit: 'frames' } };

describe('real source/remake pairing evidence', () => {
  it('verifies explicit source pairing against both exact byte hashes and separate source clocks', () => {
    expect(validatePairs(manifest(), { files, uses: [use] })).toMatchObject({ status: 'verified', problems: [] });
  });
  it('keeps different files pending when semantic pairing or stage evidence is unknown', () => {
    const m = manifest();
    m.pairs[0]!.evidence = [{ ...evidence, kind: 'unknown', detail: 'Two videos were downloaded; their relationship has not been watched.' }];
    delete m.pairs[0]!.reference.stage;
    const checked = validatePairs(m, { files });
    expect(checked.status).toBe('pending');
    expect(checked.problems.every((p) => p.level === 'warning')).toBe(true);
  });
  it('does not turn filenames or two distinct SHA values alone into a verified pairing', () => {
    const m = manifest();
    delete m.pairs[0]!.evidence;
    expect(validatePairs(m, { files }).status).toBe('pending');
    expect(validatePairs(manifest()).status).toBe('pending');
    const measuredOnly = manifest(); measuredOnly.pairs[0]!.evidence = [{ ...evidence, kind: 'measured', detail: 'Only byte hashes and frame rates were measured.' }];
    expect(validatePairs(measuredOnly, { files }).status).toBe('pending');
  });
  it('rejects evidence bound to another pair or to a different reference/remake hash', () => {
    for (const patch of [{ sourcePairId: 'official-b' }, { referenceSha256: sha256(b) }]) {
      const m = manifest(); m.pairs[0]!.evidence = [{ ...evidence, ...patch }];
      expect(validatePairs(m, { files }).status).toBe('invalid');
    }
    const m = manifest(); m.pairs[0]!.evidence = [{ ...evidence, referenceSha256: '' }];
    expect(validatePairs(m, { files }).status).toBe('pending');
  });
  it('rejects the same file or renamed identical bytes being presented as a remake', () => {
    for (const same of ['path', 'bytes']) {
      const m = manifest();
      if (same === 'path') m.pairs[0]!.remake.file = m.pairs[0]!.reference.file;
      else m.pairs[0]!.remake.sha256 = m.pairs[0]!.reference.sha256;
      expect(validatePairs(m, { files }).status).toBe('invalid');
    }
  });
  it('rejects the wrong comparison side or unknown pair rather than accepting an arbitrary hot/new combination', () => {
    expect(validatePairs(manifest(), { files, uses: [{ ...use, file: 'assets/unrelated-hot.mp4' }] }).status).toBe('invalid');
    expect(validatePairs(manifest(), { files, uses: [{ ...use, pairId: 'different-pair' }] }).status).toBe('invalid');
  });
  it('refuses a source FPS that substitutes the project clock, including24/30 confusion', () => {
    const m = manifest(); m.pairs[0]!.remake.sourceFps = 30;
    expect(validatePairs(m, { files }).problems).toEqual(expect.arrayContaining([expect.objectContaining({ at: 'pairs[0].remake.sourceFps', level: 'error' })]));
    expect(validatePairs(manifest(), { files, uses: [{ ...use, sourceFps: 24 }] }).status).toBe('invalid');
  });
  it('accepts equivalent explicit seconds and source frames, but not intervals outside the selected narrative stage', () => {
    expect(validatePairs(manifest(), { files, uses: [{ ...use, trim: { in: 14, out: 20, unit: 'seconds' } }] }).status).toBe('verified');
    expect(validatePairs(manifest(), { files, uses: [{ ...use, trim: { in: 0, out: 180, unit: 'frames' } }] }).status).toBe('invalid');
    expect(validatePairs(manifest(), { files, uses: [{ ...use, trim: { in: 420, out: 850, unit: 'frames' } }] }).status).toBe('invalid');
  });
  it('validates unit/range shape and rejects ambiguous or fractional frame offsets', () => {
    for (const trim of [{ in: 1, out: 2, unit: 'project-frames' }, { in: 1.5, out: 20, unit: 'frames' }, { in: 20, out: 10, unit: 'seconds' }]) {
      const m = manifest() as unknown as { pairs: { reference: { trim: unknown } }[] }; m.pairs[0]!.reference.trim = trim;
      expect(validatePairs(m, { files }).status).toBe('invalid');
    }
  });
  it('rejects unsafe local paths, duplicate ids and out-of-file trims', () => {
    for (const file of ['../other.mp4', '/tmp/other.mp4', '\\outside.mp4', 'C:\\other.mp4', 'https://example.org/other.mp4']) {
      const m = manifest(); m.pairs[0]!.reference.file = file;
      expect(validatePairs(m, { files }).status).toBe('invalid');
    }
    const duplicate = manifest(); duplicate.pairs.push(structuredClone(duplicate.pairs[0]!));
    expect(validatePairs(duplicate, { files }).status).toBe('invalid');
    const tooLong = manifest(); tooLong.pairs[0]!.reference.trim.out = 900;
    expect(validatePairs(tooLong, { files }).status).toBe('invalid');
  });
  it('reads a valid manifest and checks actual local bytes without remote calls or content recognition', async () => {
    const rt = createTestRuntime({ files: { '/work/replication.pairs.json': JSON.stringify(manifest()), '/work/assets/original.mp4': a, '/work/assets/remake.mp4': b } });
    const m = await readPairs(rt, '/work');
    const measured = async (_rt: Runtime, file: string) => ({ width: 480, height: 854, fps: file.endsWith('original.mp4') ? 30 : 24, frames: file.endsWith('original.mp4') ? 812 : 351, duration: 27, hasAudio: true });
    expect((await checkPairs(rt, '/work', m, { probe: measured })).status).toBe('verified');
    await rt.fs.writeFile('/work/assets/remake.mp4', a);
    expect((await checkPairs(rt, '/work', m, { probe: measured })).status).toBe('invalid');
  });
});
