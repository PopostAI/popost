/**
 * The sound of a video as planned (references/video-sound.md): the modes of a clip request and their inference from
 * the reading, the music plan from the reading (R2, R5) with what departs from it resting on the user's words, the
 * exceptions under which a clip carries music (R4), and generated music that is not available (the platform's 503):
 * no generated bed, said once, nothing asked again. The platform is the in-memory fake.
 */
import { describe, expect, it } from 'vitest';
import { createTestRuntime, runCli, type TestRuntime } from '../../src/testing/memory';
import { makeMaterials, type Generator, type GenerateRequest, type MaterialRequest } from '../../src/video/generate/index';
import { basisOf, departure, exceptionFor, letterOf, proposal, withException, type Reading } from '../../src/video/music/plan';
import { readMusicPlan, writeMusicPlan } from '../../src/video/music/provenance';
import { inferMode, modeContextOf, modeProblems, musicBasisOf, readModeReceipt, soundTail } from '../../src/video/sound/modes';
import type { SoundFacts } from '../../src/video/sound/reading';
import { ENV, fakePlatform, type FakeOptions } from './hosted-fake';

const facts = (music: SoundFacts['music'], more: Partial<SoundFacts> = {}): SoundFacts => ({
  music, ambience: 'no', effects: [], sfx: 'no', plan: { music: music === 'yes' ? 'bed' : music === 'no' ? 'none' : 'ask', sfx: 'no', ambience: 'no', says: [] }, ...more,
});
const reading = (music: SoundFacts['music'], more: Partial<SoundFacts> = {}): Reading => ({ facts: facts(music, more), from: 'ref/sound.json', seconds: 20 });

describe('the mode of a clip request', () => {
  it('is the one it names; else speech for a clip with lines; else silent under a narrator whose places are not heard; else ambience', () => {
    expect(inferMode({ sound: 'exhibit' })).toBe('exhibit');
    expect(inferMode({ speech: { mode: 'native' } })).toBe('speech');
    expect(inferMode({}, { narrated: true, ambience: 'no' })).toBe('silent');
    expect(inferMode({}, { narrated: true, ambience: 'unknown' })).toBe('silent');
    expect(inferMode({}, { narrated: true, ambience: 'yes' })).toBe('ambience');
    expect(inferMode({}, { narrated: false })).toBe('ambience');
    expect(inferMode({})).toBe('ambience');
    expect(modeContextOf({ speech: { kinds: ['narration', 'on-camera'] }, sound: { ambience: 'no' } })).toEqual({ narrated: true, ambience: 'no' });
    expect(modeContextOf({})).toEqual({});
  });

  it('ends the prompt by its role, without music unless an exception is recorded; an exhibit is left free', () => {
    expect(soundTail('speech')).toContain('voice is the lead');
    expect(soundTail('ambience')).toContain('Nobody speaks');
    for (const m of ['speech', 'ambience'] as const) {
      expect(soundTail(m)).toContain('No background music');
      expect(soundTail(m, { music: 'in-scene' })).not.toContain('No background music');
    }
    expect(soundTail('silent')).toContain('mouths stay closed');
    expect(soundTail('exhibit')).toBe('');
  });

  it('is checked before anything is paid: the mode, lines that fit it, and music only under an exception recorded for the clip', () => {
    const at = (r: Record<string, unknown>, recorded: { basis: 'in-scene' | 'sung'; clip: string }[] = []) => modeProblems({ file: 'assets/a.mp4', ...r }, '[0]', recorded, true).map((p) => p.at);
    expect(at({ sound: 'loud' })).toEqual(['[0].sound']);
    expect(at({ sound: 'speech' })).toEqual(['[0].sound']);
    expect(at({ sound: 'silent', speech: { mode: 'native' } })).toEqual(['[0].sound']);
    expect(at({ clipMusic: 'in-scene' })).toEqual(['[0].clipMusic']);
    expect(at({ clipMusic: 'in-scene' }, [{ basis: 'in-scene', clip: 'assets/a.mp4' }])).toEqual([]);
    expect(at({ clipMusic: 'in-scene' }, [{ basis: 'in-scene', clip: 'all' }])).toEqual([]);
    expect(at({ clipMusic: 'in-scene' }, [{ basis: 'in-scene', clip: 'assets/b.mp4' }])).toEqual(['[0].clipMusic']);
    expect(at({ clipMusic: 'in-scene', sound: 'silent' }, [{ basis: 'in-scene', clip: 'all' }])).toEqual(['[0].clipMusic']);
    expect(modeProblems({ file: 'assets/a.png', sound: 'ambience' }, '[0]', [], false).map((p) => p.at)).toEqual(['[0].sound']);
    // A recorded exception counts for its clip without the request naming it.
    expect(musicBasisOf({ file: 'assets/a.mp4' }, [{ basis: 'sung', clip: 'assets/a.mp4' }])).toBe('sung');
    expect(musicBasisOf({ file: 'assets/a.mp4' }, [{ basis: 'sung', clip: 'assets/b.mp4' }])).toBeUndefined();
  });
});

describe('the plan helpers', () => {
  it('name the exceptions by letter, find a clip\'s, and leave no bed under (a)', () => {
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(basisOf)).toEqual(['single-clip', 'per-segment', 'in-scene', 'sung', 'brand-sting', 'own-footage', 'user-wish']);
    expect([basisOf('In-Scene'), basisOf('h'), letterOf('sung')]).toEqual(['in-scene', undefined, 'd']);
    const list = [{ basis: 'in-scene' as const, clip: 'assets/a.mp4', why: 'x' }, { basis: 'user-wish' as const, clip: 'all', why: 'y' }];
    expect(exceptionFor(list, 'assets/a.mp4')?.basis).toBe('in-scene');
    expect(exceptionFor(list, 'assets/b.mp4')?.basis).toBe('user-wish');
    expect(withException({ version: 1, music: 'generated', style: 'jazz' }, { basis: 'single-clip', clip: 'all', why: 'one take' })).toEqual({ version: 1, music: 'none', clipMusic: [{ basis: 'single-clip', clip: 'all', why: 'one take' }] });
  });

  it('propose from the reading: the user\'s file first, a generated bed where the reference has music, none where it has none, ask where it cannot tell', () => {
    const offer = { available: true as const, quote: { credits: 36, model: 'clip', maxTrackSeconds: 30 } };
    expect(proposal({ reading: reading('yes', { style: 'lo-fi; relaxed' }), ownFile: false, offer })).toMatchObject({ music: 'generated', style: 'lo-fi; relaxed', says: expect.stringContaining('About 36 credits (clip)') });
    expect(proposal({ reading: reading('yes'), ownFile: true })).toMatchObject({ music: 'own' });
    expect(proposal({ reading: reading('no'), ownFile: false })).toMatchObject({ music: 'none' });
    expect(proposal({ reading: reading('likely'), ownFile: false })).toMatchObject({ music: 'ask' });
    expect(proposal({ ownFile: false })).toMatchObject({ music: 'ask' });
    expect(proposal({ reading: reading('yes'), ownFile: false, offer: { available: false, why: 'Generated music is not available on popost.ai right now.' } })).toMatchObject({ music: 'none', says: expect.stringContaining('not available') });
    // Departing from the reading needs the user's words; the user's own file never does.
    expect(departure('generated', reading('no'), undefined)).toContain('R5');
    expect(departure('generated', reading('no'), 'add some music please')).toBeUndefined();
    expect(departure('none', reading('yes'), undefined)).toContain('--asked');
    expect(departure('own', reading('no'), undefined)).toBeUndefined();
    expect(departure('generated', undefined, undefined)).toBeUndefined();
  });
});

const setup = async (music: SoundFacts['music'], o: FakeOptions = {}) => {
  const platform = fakePlatform({ balance: 500, ...o });
  const rt = createTestRuntime({ env: ENV, fetchHandler: platform.handler });
  await rt.fs.writeFile('/work/ref/sound.json', JSON.stringify({ format: 'popost-video-sound', version: 1, measured: { seconds: 20 }, analysis: { status: 'done' }, facts: facts(music, music === 'yes' ? { style: 'lo-fi hip hop; relaxed; piano' } : {}) }));
  await rt.fs.mkdir('/work/p');
  const plan = (...more: string[]) => runCli(rt, ['video', 'music', 'plan', '--project', '/work/p', '--reading', '/work/ref', ...more]);
  const quotes = () => platform.sent.filter((s) => s.path === '/music/quote').length;
  return { rt, platform, plan, quotes };
};

/** A generator that writes what it is asked for and keeps the requests. */
const keeping = (rt: TestRuntime): Generator & { asked: GenerateRequest[] } => {
  const asked: GenerateRequest[] = [];
  return { asked, make: async (_kind, r, out) => { asked.push(r); await rt.fs.writeFile(out, 'x'); return { credits: 5 }; } };
};

describe('popost video music plan', () => {
  it('proposes a generated bed in the reference\'s style with its price when the reference has music, and records it', async () => {
    const { rt, plan, quotes } = await setup('yes');
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, plan: null, proposed: { music: 'generated', style: 'lo-fi hip hop; relaxed; piano' }, show: [expect.stringContaining('About 36 credits')], next: expect.stringContaining('--music generated --style "lo-fi hip hop; relaxed; piano"') });
    expect((await plan('--music', 'generated', '--style', 'lo-fi hip hop, relaxed, piano')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, plan: { music: 'generated', style: 'lo-fi hip hop, relaxed, piano' }, show: [expect.stringContaining('about 36 credits')] });
    expect(await readMusicPlan(rt, '/work/p')).toMatchObject({ music: 'generated', basis: expect.stringContaining('music yes') });
    expect(quotes()).toBe(2);
    // None where the reference has music needs the user's words (R5).
    expect((await plan('--music', 'none')).code).toBe(2);
    expect(String(rt.json().error)).toContain('--asked');
    expect((await plan('--music', 'none', '--asked', 'no music, I add my own when I post')).code).toBe(0);
    expect(await readMusicPlan(rt, '/work/p')).toMatchObject({ music: 'none', asked: 'no music, I add my own when I post' });
  });

  it('follows a reference without music: none, and generated music only on the user\'s words', async () => {
    const { rt, plan, quotes } = await setup('no');
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ proposed: { music: 'none' } });
    expect((await plan('--music', 'generated')).code).toBe(2);
    expect(String(rt.json().error)).toContain('R5');
    expect(quotes()).toBe(0);
    expect((await plan('--music', 'generated', '--asked', 'put some calm music under it')).code).toBe(0);
    expect(await readMusicPlan(rt, '/work/p')).toMatchObject({ music: 'generated', asked: 'put some calm music under it' });
  });

  it('reads a gateway error page on the music quote (plain-text 502) as unavailable too, never as a failure', async () => {
    const { rt, plan, quotes } = await setup('yes', { musicOff: true, musicOffPage: 502 });
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ proposed: { music: 'none', says: expect.stringContaining('not available on popost.ai right now') } });
    expect(quotes()).toBe(1);
  });

  it('plans no generated bed when the generator is switched off (HTTP 503), says so once, and materials says it in its notes', async () => {
    const { rt, platform, plan, quotes } = await setup('yes', { musicOff: true });
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ proposed: { music: 'none', says: expect.stringContaining('not available on popost.ai right now') } });
    expect((await plan('--music', 'generated', '--style', 'lo-fi')).code).toBe(0);
    expect(rt.json()).toMatchObject({ ok: true, plan: { music: 'none', unavailable: expect.stringContaining('not available') }, show: ['Music: none.', expect.stringContaining('not available on popost.ai right now')] });
    // none is then no departure from the reading.
    expect((await plan('--music', 'none')).code).toBe(0);
    expect(await readMusicPlan(rt, '/work/p')).toMatchObject({ music: 'none', unavailable: expect.stringContaining('user\'s own music file still works') });
    expect(quotes()).toBe(3);
    expect(platform.sent.filter((s) => s.path === '/music' && s.method === 'POST')).toHaveLength(0);
    expect(platform.account.charged).toBe(0);
    const generator = keeping(rt);
    const made = await makeMaterials(rt, { requests: [{ file: 'assets/a.mp4', prompt: 'a street', seconds: 2, cast: [] }], dir: '/work/p', generator });
    expect(made.problems).toEqual([]);
    expect(made.notes?.join(' ')).toContain('not available on popost.ai right now');
    expect(quotes()).toBe(3);
  });

  it('records an exception under which a clip carries music, shows it, and materials asks that clip without the sentence about music', async () => {
    const { rt, plan } = await setup('yes');
    expect((await plan('--clip-music', 'assets/band.mp4', '--basis', 'c', '--why', 'a band plays in the third shot')).code).toBe(2);
    expect(String(rt.json().error)).toContain('Record the music plan first');
    expect((await plan('--music', 'generated')).code).toBe(0);
    expect((await plan('--clip-music', 'assets/band.mp4', '--basis', 'c')).code).toBe(2);
    expect(String(rt.json().error)).toContain('--why');
    expect((await plan('--clip-music', 'assets/band.mp4', '--basis', 'a', '--why', 'one take')).code).toBe(2);
    expect(String(rt.json().error)).toContain('--clip-music all');
    expect((await plan('--clip-music', 'assets/band.mp4', '--basis', 'c', '--why', 'a band plays in the third shot')).code).toBe(0);
    expect(rt.json()).toMatchObject({ plan: { music: 'generated', clipMusic: [{ basis: 'in-scene', clip: 'assets/band.mp4', why: 'a band plays in the third shot' }] }, show: [expect.any(String), expect.stringContaining('assets/band.mp4: (c) in-scene')] });
    const generator = keeping(rt);
    const requests: MaterialRequest[] = [{ file: 'assets/band.mp4', prompt: 'a band plays on a small stage', seconds: 2, cast: [] }, { file: 'assets/street.mp4', prompt: 'a street', seconds: 2, cast: [] }];
    const made = await makeMaterials(rt, { requests, dir: '/work/p', generator, music: true, anchor: false });
    expect(made.problems).toEqual([]);
    expect(generator.asked.map((a) => a.prompt)).toEqual(['a band plays on a small stage' + soundTail('ambience', { music: 'in-scene' }), 'a street' + soundTail('ambience')]);
    expect(made.clipMusic).toEqual([{ file: 'assets/band.mp4', basis: 'in-scene', means: expect.stringContaining('music is in the scene'), why: 'a band plays in the third shot' }]);
    expect(await readModeReceipt(rt, '/work/p/assets/band.mp4')).toEqual({ version: 1, sound: 'ambience', clipMusic: 'in-scene' });
    // One continuous clip for the whole video: no bed, and a bed cannot come back while it is recorded.
    expect((await plan('--clip-music', 'all', '--basis', 'a', '--why', 'the reference is one continuous take')).code).toBe(0);
    expect(rt.json()).toMatchObject({ plan: { music: 'none' }, note: expect.stringContaining('no bed') });
    expect((await plan('--music', 'generated')).code).toBe(2);
    expect((await plan('--drop-clip-music', 'all')).code).toBe(0);
    expect((await readMusicPlan(rt, '/work/p'))?.clipMusic?.map((c) => c.clip)).toEqual(['assets/band.mp4']);
  });

  it('proposes the user\'s own file first, and prints the plan on record', async () => {
    const { rt, plan, quotes } = await setup('yes');
    await rt.fs.writeFile('/work/p/assets/song.mp3', 'song');
    await rt.fs.writeFile('/work/p/assets/song.mp3.sound.json', '{}');
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ proposed: { music: 'own' } });
    expect(quotes()).toBe(0);
    await writeMusicPlan(rt, '/work/p', { version: 1, music: 'own' });
    expect((await plan()).code).toBe(0);
    expect(rt.json()).toMatchObject({ plan: { music: 'own' }, show: ['Music: the user\'s own file, as the one bed of the video.'] });
  });
});
