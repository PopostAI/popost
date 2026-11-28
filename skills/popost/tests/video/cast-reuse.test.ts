import { describe, expect, it } from 'vitest';
import { castImages, readCast, type CastVisualEvidence } from '../../src/video/generate/cast';
import { materialSignature, materialSignatures, type MaterialProvenance } from '../../src/video/generate/provenance';
import { sha256 } from '../../src/core/util';
import { newScene, tinyPng } from '../image-helpers';

const root = '/work/project';
const frame = tinyPng([90, 110, 140]);
const face = tinyPng([190, 150, 130]);
const evidence = (file: string): CastVisualEvidence => ({ kind: 'observed', detail: 'The source guide is illustrated, older and broad.', file, sha256: sha256(frame), media: 'frame', at: [0, 5] });
const setup = async (sourcePath = 'reference.png', stored = [evidence('reference.png')]) => {
  const role = { id: 'guide', description: 'An original older guide.', identity: 'new', image: 'assets/guide.png', sha256: sha256(face), provenance: 'image_gen',
    visual: { medium: 'watercolor illustration', style: ['soft paper grain'], archetype: { ageFeel: 'older adult', build: 'broad' }, evidence: stored } };
  const source = { format: 'popost-video-replication', version: 1, source: { fingerprint: 'a'.repeat(64), fps: 24, frames: 240 },
    audio: { sourceSpeech: 'absent', sourceRoles: ['music'], narration: 'forbid', evidence: [] },
    visual: { medium: 'watercolor illustration', style: ['soft paper grain'], evidence: [evidence(sourcePath)] }, events: [] };
  const { rt } = await newScene({ files: { [root+'/cast.json']: JSON.stringify({ version: 1, roles: [role] }), [root+'/replication.json']: JSON.stringify(source) } });
  await rt.fs.writeFile(root+'/'+sourcePath, frame);
  await rt.fs.writeFile(root+'/assets/guide.png', face);
  return { rt, role, source };
};
const payload = (instruction: string): MaterialProvenance => ({
  request: { file: 'assets/take.mp4', prompt: 'Explain the lesson. '+instruction, cast: ['guide'], images: ['assets/guide.png'], speech: { mode: 'native', text: 'A new lesson.' } },
  voiceHash: 'b'.repeat(64), dependencies: [['assets/guide.png', sha256(face)], ['assets/voice.wav', 'b'.repeat(64)]],
  lines: [{ speaker: 'guide', text: 'A new lesson.', at: 0, to: 3 }],
});
const candidates = (current: Awaited<ReturnType<typeof castImages>>) => materialSignatures(payload(current.instruction), current.legacyInstructions?.map(s => payload(s).request));

describe('cast evidence portability and material provenance', () => {
  it('returns the original canonical prompt and stamp after a verified same-SHA file is moved', async () => {
    const a = await setup();
    const initial = await castImages(a.rt, root, ['guide']);
    const b = await setup('replication-evidence/frame.png');
    const portable = await castImages(b.rt, root, ['guide']);
    expect(portable.instruction).toBe(initial.instruction);
    expect(candidates(portable)).toContain(materialSignature(payload(initial.instruction)));
    expect((await readCast(b.rt, root)).roles[0]!.visual!.evidence).toEqual([evidence('replication-evidence/frame.png')]);
  });
  it('reconstructs a bounded historical duplicate prompt without rewriting the old stamp', async () => {
    const a = await setup('portable/frame.png');
    const current = await castImages(a.rt, root, ['guide']);
    const duplicate = current.legacyInstructions!.find(s => s.split(evidence('').detail).length === 3)!;
    expect(duplicate).toBeTruthy();
    const historicalStamp = materialSignature(payload(duplicate));
    expect(historicalStamp).not.toBe(materialSignature(payload(current.instruction)));
    expect(candidates(current)).toContain(historicalStamp);
    expect(current.legacyInstructions!.length).toBeLessThanOrEqual(2);
  });
  it('retains an earlier stored duplicate count after another portable copy', async () => {
    const a = await setup('portable/current.png', [evidence('old/a.png'), evidence('old/b.png')]);
    const current = await castImages(a.rt, root, ['guide']);
    expect(current.legacyInstructions!.some(s => s.split(evidence('').detail).length === 3)).toBe(true);
    expect(current.legacyInstructions!.some(s => s.split(evidence('').detail).length === 4)).toBe(true);
    expect(current.legacyInstructions!.length).toBe(2);
  });
  it.each(['kind', 'detail', 'at', 'media'] as const)('does not collapse different %s evidence even with identical bytes', async key => {
    const other: CastVisualEvidence = { ...evidence('old.png'), ...(key === 'kind' ? { kind: 'user' as const } : key === 'detail' ? { detail: 'A genuinely changed visual fact.' } : key === 'at' ? { at: [2, 4] as [number, number] } : { media: 'data' as const }) };
    const a = await setup('portable/frame.png', [other]);
    expect((await readCast(a.rt, root)).roles[0]!.visual!.evidence).toHaveLength(2);
  });
  it('never treats unbound equal details as a verified portable duplicate', async () => {
    const a = await setup('portable/frame.png', [{ kind: 'observed', detail: evidence('').detail, file: 'other.png' }]);
    expect((await readCast(a.rt, root)).roles[0]!.visual!.evidence).toHaveLength(2);
  });
  it('rejects changed source bytes rather than trusting the declared SHA', async () => {
    const a = await setup('portable/frame.png');
    await a.rt.fs.writeFile(root+'/portable/frame.png', tinyPng([1, 2, 3]));
    await expect(castImages(a.rt, root, ['guide'])).rejects.toThrow('evidence changed');
  });
  it.each(['style', 'archetype'] as const)('cannot reuse an old stamp after a real %s change', async key => {
    const a = await setup('portable/frame.png');
    const before = await castImages(a.rt, root, ['guide']);
    const old = materialSignature(payload(before.instruction));
    if (key === 'style') a.role.visual.style = ['hard ink contours']; else a.role.visual.archetype.build = 'slender';
    await a.rt.fs.writeFile(root+'/cast.json', JSON.stringify({ version: 1, roles: [a.role] }));
    expect(candidates(await castImages(a.rt, root, ['guide']))).not.toContain(old);
  });
  it('keeps picture, voice, words, timed slots and separate-music constraints in every legacy candidate', async () => {
    const a = await setup('portable/frame.png');
    const cast = await castImages(a.rt, root, ['guide']);
    const base = payload(cast.instruction), old = materialSignature(base);
    const changes: MaterialProvenance[] = [
      { ...base, dependencies: [['assets/guide.png', 'c'.repeat(64)], ['assets/voice.wav', 'b'.repeat(64)]] },
      { ...base, voiceHash: 'c'.repeat(64) },
      { ...base, request: { ...base.request, speech: { mode: 'native', text: 'Different words.' } } },
      { ...base, lines: [{ speaker: 'guide', text: 'A new lesson.', at: 1, to: 4 }] },
      { ...base, separateMusic: true },
    ];
    for (const changed of changes) {
      const alternatives = cast.legacyInstructions!.map(s => ({ ...changed.request, prompt: 'Explain the lesson. '+s }));
      expect(materialSignatures(changed, alternatives)).not.toContain(old);
    }
  });
});
