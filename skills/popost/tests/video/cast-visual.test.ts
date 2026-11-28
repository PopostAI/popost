import { describe, expect, it } from 'vitest';
import { castImages, castPrompt, completeCast, readCast, type CastRole } from '../../src/video/generate/cast';
import { sha256 } from '../../src/core/util';
import { cli, newScene, tinyPng } from '../image-helpers';

const elder: CastRole = {
  id: 'guide', description: 'An original retired gardener with a calm delivery.', identity: 'new', shots: ['intro', 'lesson'],
  visual: { medium: 'watercolor illustration', style: ['soft paper texture', 'hand-painted contours'],
    archetype: { ageFeel: 'older adult', build: 'broad and sturdy', wardrobe: 'practical gardening clothes', presence: 'calm and patient' },
    evidence: [{ kind: 'observed', source: 'reference-shot-01', detail: 'The reference uses an older illustrated garden guide.', at: [0, 90] }] },
};
const scene = (roles: unknown[]) => newScene({ files: { '/work/project/cast.json': JSON.stringify({ version: 1, roles }) } });
const strictSource = (frame: Uint8Array) => ({
  format: 'popost-video-replication', version: 1, source: { fingerprint: 'a'.repeat(64), fps: 24, frames: 240 },
  audio: { sourceSpeech: 'absent', sourceRoles: ['music'], narration: 'forbid', evidence: [] },
  visual: { medium: 'polished stylized 3D animation', style: ['sculpted facial forms', 'soft cinematic materials'],
    evidence: [{ kind: 'observed', detail: 'Inspected the actual animated source frame.', file: 'reference/frame.png', sha256: sha256(frame), media: 'frame' }] },
  events: [],
});

describe('cast visual medium and reference archetype', () => {
  it('preserves the legacy photographic preparation when visual is absent', () => {
    const prompt = castPrompt({ id: 'host', description: 'A new presenter in a jacket.' });
    expect(prompt).toContain('single clean photographic character identity reference');
    expect(prompt).toContain('distinct fictional individual');
  });
  it('keeps an evidenced illustrated older, sturdy archetype without converting it to a photographic or young thin character', () => {
    const prompt = castPrompt(elder);
    expect(prompt).toContain('watercolor illustration');
    expect(prompt).toContain('older adult');
    expect(prompt).toContain('broad and sturdy');
    expect(prompt).toContain('practical gardening clothes');
    expect(prompt).not.toContain('photographic character');
    expect(prompt).toContain('A new identity changes facial identity, not these traits');
    expect(prompt).toContain('Do not reproduce a real reference person');
  });
  it('supports a user-selected live-action medium and does not treat a style-only description as photography', () => {
    expect(castPrompt({ ...elder, visual: { medium: 'photographic live action', style: ['natural daylight'] } })).toContain('photographic live action');
    const prompt = castPrompt({ ...elder, visual: { style: ['cel shading', 'flat ink outlines'] } });
    expect(prompt).not.toContain('photographic character identity');
    expect(prompt).toContain('Keep the evidenced visual medium');
  });
  it('inherits strict reference 3D medium, style and bound evidence when the role omits visual', async () => {
    const frame = tinyPng([90, 110, 140]);
    const { rt } = await scene([{ id: 'guide', description: 'An original friendly guide.', shots: ['intro', 'outro'] }]);
    await rt.fs.writeFile('/work/project/reference/frame.png', frame);
    await rt.fs.writeFile('/work/project/replication.json', JSON.stringify(strictSource(frame)));
    const role = (await readCast(rt, '/work/project')).roles[0]!;
    expect(role.visual).toEqual(strictSource(frame).visual);
    expect(castPrompt(role)).toContain('polished stylized 3D animation');
    expect(castPrompt(role)).not.toContain('photographic character identity');
    const prepared = await cli(rt, 'video', 'cast', 'prepare', '/work/project');
    expect(prepared.code).toBe(0);
    expect(prepared.stdout).toContain('sculpted facial forms');
    expect(prepared.stdout).not.toContain('photographic character identity');
  });
  it('fills missing strict visual fields while preserving explicit role choices and observed archetype', async () => {
    const frame = tinyPng([90, 110, 140]);
    const roles = [
      { ...elder, visual: { archetype: elder.visual!.archetype, style: ['user-requested ink contours'], evidence: [{ kind: 'user', detail: 'Keep this ink finish.' }] } },
      { ...elder, id: 'guest', visual: { medium: 'user-requested clay animation' } },
    ];
    const { rt } = await scene(roles);
    await rt.fs.writeFile('/work/project/reference/frame.png', frame);
    await rt.fs.writeFile('/work/project/replication.json', JSON.stringify(strictSource(frame)));
    const cast = await readCast(rt, '/work/project');
    expect(cast.roles[0]!.visual).toMatchObject({ medium: 'polished stylized 3D animation', style: ['user-requested ink contours'], archetype: elder.visual!.archetype });
    expect(cast.roles[0]!.visual!.evidence).toHaveLength(2);
    expect(cast.roles[1]!.visual).toMatchObject({ medium: 'user-requested clay animation', style: strictSource(frame).visual.style });
    await rt.fs.writeFile('/work/project/cast.json', JSON.stringify(cast));
    expect((await readCast(rt, '/work/project')).roles[0]!.visual!.evidence).toHaveLength(2);
  });
  it('does not silently fall back to photographic legacy cast for malformed or changed strict evidence', async () => {
    const frame = tinyPng([90, 110, 140]);
    const { rt } = await scene([{ id: 'guide', description: 'An original guide.' }]);
    await rt.fs.writeFile('/work/project/replication.json', JSON.stringify({ ...strictSource(frame), version: 99 }));
    await expect(readCast(rt, '/work/project')).rejects.toThrow('Invalid replication.json for cast');
    await rt.fs.writeFile('/work/project/replication.json', JSON.stringify(strictSource(frame)));
    await rt.fs.writeFile('/work/project/reference/frame.png', tinyPng([1, 2, 3]));
    await expect(readCast(rt, '/work/project')).rejects.toThrow('evidence changed');
  });
  it('carries visual instructions to both direct single-clip generation and recurring locked cast', async () => {
    const { rt } = await scene([elder]);
    const direct = await castImages(rt, '/work/project', ['guide'], new Map([['guide', 1]]));
    expect(direct.images).toEqual([]);
    expect(direct.instruction).toContain('watercolor illustration');
    expect(direct.instruction).toContain('older adult');
    await rt.fs.writeFile('/work/project/reference.png', tinyPng([80, 100, 70]));
    await completeCast(rt, '/work/project', 'guide', '/work/project/reference.png', 'image_gen');
    const locked = await castImages(rt, '/work/project', ['guide'], new Map([['guide', 2]]));
    expect(locked.images).toEqual(['assets/cast/guide.png']);
    expect(locked.instruction).toContain('watercolor illustration');
    expect((await readCast(rt, '/work/project')).roles[0]?.visual).toEqual(elder.visual);
  });
  it('prints medium and style in prepared host jobs and single-appearance instructions', async () => {
    const { rt } = await scene([elder, { ...elder, id: 'guest', shots: ['one'] }]);
    const prepared = await cli(rt, 'video', 'cast', 'prepare', '/work/project');
    expect(prepared.code).toBe(0);
    expect(prepared.data).toMatchObject({ channel: 'host', jobs: [{ id: 'guide', visual: elder.visual }], direct: [{ id: 'guest', visual: elder.visual }] });
    expect(prepared.stdout).not.toContain('photographic character identity');
  });
  it('keeps user-supplied image hashes and same-person authorization requirements across visual styles', async () => {
    const image = tinyPng([90, 80, 50]);
    const { rt } = await scene([{ ...elder, identity: 'user', image: 'assets/user.png', sha256: sha256(image), provenance: 'user' }]);
    await rt.fs.writeFile('/work/project/assets/user.png', image);
    expect((await castImages(rt, '/work/project', ['guide'])).images).toEqual(['assets/user.png']);
    await rt.fs.writeFile('/work/project/cast.json', JSON.stringify({ version: 1, roles: [{ ...elder, identity: 'reference', permission: 'Keep the avatar layout.' }] }));
    await expect(readCast(rt, '/work/project')).rejects.toThrow('explicit instruction');
  });
  it('does not present unknown reference evidence as an observed match and rejects malformed visual data', async () => {
    expect(castPrompt({ ...elder, visual: { evidence: [{ kind: 'unknown', detail: 'The reference medium has not been checked.' }] } })).toContain('Unresolved visual evidence is not a fact');
    for (const visual of [{ medium: '' }, { style: 'anime' }, { archetype: { build: 10 } }, { evidence: [{ kind: 'observed', detail: 'x', at: [90, 20] }] }]) {
      const { rt } = await scene([{ ...elder, visual }]);
      await expect(readCast(rt, '/work/project')).rejects.toThrow('Cast visual');
    }
  });
});
