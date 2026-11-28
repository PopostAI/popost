/**
 * The sound rules in the mix (references/video-sound.md): the modes of a clip's sound (speech, exhibit, ambience,
 * silent), the music bed that gives way altogether under a clip with music of its own (60 dB, ramps of 0.5 s), the
 * sound effect (role "sfx") placed on a frame and lowered 6 dB under speech unless it leads, and the checks that hold a
 * project to one music source and one lead voice at a time. The last parts render tones with ffmpeg and measure levels.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createDiskRuntime } from '../../src/testing/disk';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { EFFECT_RECEIPT, writeEffectRecord, writeMusicPlan } from '../../src/video/music/provenance';
import { checkProject } from '../../src/video/project/check';
import { clipMusicRecords, musicOverlap, soundRecords, speakingCuts } from '../../src/video/project/check-sound';
import { parseProject } from '../../src/video/project/schema';
import { duckFilter, encodeArgs } from '../../src/video/render/encode';
import { DUCK_DB, duckAt, duckOf, GIVE_WAY_DB, givingWay, SFX_DUCK_DB } from '../../src/video/timeline/mix';
import { resolve } from '../../src/video/timeline/resolve';
import type { FootageFacts, Project, Resolved, ResolvedAudio } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(() => rt.cleanup());
const ffmpeg = await hasFfmpeg(rt);

const clip: FootageFacts = { width: 320, height: 180, fps: 30, frames: 150, hasAudio: true };

/** Two footage shots of 120 frames, a voice-over with one line over the second (frames 150-210) and a music bed. */
const project = (o: { second?: Record<string, unknown>; tracks?: Project['tracks']; music?: Record<string, unknown> } = {}): Project => ({
  version: 1, canvas: { width: 320, height: 180, fps: 30 },
  materials: [{ id: 'talk', kind: 'video', file: 'assets/talk.mp4' }, { id: 'show', kind: 'video', file: 'assets/show.mp4' }, { id: 'voice', kind: 'audio', file: 'assets/voice.wav' }, { id: 'music', kind: 'audio', file: 'assets/music.mp3' }, { id: 'hit', kind: 'audio', file: 'assets/sfx/hit.wav' }],
  segments: [{ id: 'shot-01', frames: 120, base: { material: 'talk' } }, { id: 'shot-02', frames: 120, base: { material: 'show', ...(o.second ?? {}) } }],
  tracks: o.tracks ?? [{ id: 'sound', type: 'audio', material: 'voice', role: 'voice', lines: [[150, 210]] }, { id: 'music', type: 'audio', material: 'music', role: 'music', ...(o.music ?? {}) }],
});
const by = (r: Resolved): Record<string, ResolvedAudio> => Object.fromEntries(r.audio.map((a) => [a.id, a]));

describe('the modes of a clip\'s sound in the mix', () => {
  it('an exhibit is lowered under the voice-over and the bed gives way altogether for it', () => {
    const r = resolve(project(), { talk: clip, show: { ...clip, sound: 'exhibit' } });
    const a = by(r);
    expect(a['shot-02.audio']).toMatchObject({ gain: 0, duck: { spans: [[150, 210]], db: DUCK_DB } });
    expect(a.music?.duck).toEqual({ spans: [[150, 210]], db: DUCK_DB, ramp: 6, away: { spans: [[120, 240]], db: GIVE_WAY_DB, ramp: 15 } });
    expect(r.music).toEqual({ tracks: [{ id: 'music', span: [0, 240], fixed: false }], clips: [{ id: 'shot-02.audio', file: 'assets/show.mp4', span: [120, 240], exhibit: true }] });
  });

  it('an ambience is lowered under every voice and the bed stays; a silent clip is never heard; a speech clip leads through its length', () => {
    const ambience = resolve(project(), { talk: clip, show: { ...clip, sound: 'ambience' } });
    expect(by(ambience)['shot-02.audio']).toMatchObject({ duck: { spans: [[150, 210]], db: DUCK_DB } });
    expect(by(ambience).music?.duck?.away).toBeUndefined();
    expect(ambience.music?.clips).toEqual([]);
    const silent = resolve(project(), { talk: clip, show: { ...clip, sound: 'silent' } });
    expect(silent.audio.some((x) => x.id === 'shot-02.audio')).toBe(false);
    // The use's own word goes before the clip's receipt.
    expect(resolve(project({ second: { soundMode: 'silent' } }), { talk: clip, show: { ...clip, sound: 'exhibit' } }).audio.some((x) => x.id === 'shot-02.audio')).toBe(false);
    // A clip whose person is the speaker and whose lines' times are not known speaks through its whole use.
    const speech = resolve(project({ tracks: [{ id: 'music', type: 'audio', material: 'music', role: 'music' }] }), { talk: { ...clip, sound: 'speech' }, show: clip });
    expect(speech.speech?.dialogue).toEqual([{ id: 'shot-01.audio', spans: [[0, 120]] }]);
    expect(by(speech).music?.duck?.spans).toEqual([[0, 120]]);
  });

  it('a clip made with music under a recorded exception lets the bed give way, and the check holds it to the record', async () => {
    const r = resolve(project(), { talk: clip, show: { ...clip, sound: 'ambience', clipMusic: 'in-scene' } });
    expect(by(r).music?.duck?.away?.spans).toEqual([[120, 240]]);
    expect(r.music?.clips).toEqual([{ id: 'shot-02.audio', file: 'assets/show.mp4', span: [120, 240], exhibit: false, basis: 'in-scene' }]);
    const dir = rt.path.join(rt.dir, 'records');
    expect((await clipMusicRecords(rt, dir, r)).map((p) => p.at)).toEqual(['tracks.shot-02']);
    await writeMusicPlan(rt, dir, { version: 1, music: 'generated', clipMusic: [{ basis: 'in-scene', clip: 'assets/show.mp4', why: 'a band plays in the shot' }] });
    expect(await clipMusicRecords(rt, dir, r)).toEqual([]);
    // Recorded for another clip only: refused.
    await writeMusicPlan(rt, dir, { version: 1, music: 'generated', clipMusic: [{ basis: 'in-scene', clip: 'assets/other.mp4', why: 'a band plays' }] });
    expect(await clipMusicRecords(rt, dir, r)).toHaveLength(1);
    // One continuous clip (a) for the whole video leaves no room for a bed.
    await writeMusicPlan(rt, dir, { version: 1, music: 'none', clipMusic: [{ basis: 'single-clip', clip: 'all', why: 'one take' }] });
    const whole = await clipMusicRecords(rt, dir, resolve(project(), { talk: clip, show: { ...clip, sound: 'ambience', clipMusic: 'single-clip' } }));
    expect(whole.map((p) => [p.at, p.message.includes('has no bed') || (p.fix ?? '').includes('no bed')])).toEqual([['tracks.music', true]]);
  });
});

describe('the give-way envelope', () => {
  it('adds the lowering of the spans it gives way on to the one under speech, each with its own ramp', () => {
    const duck = givingWay(duckOf([[30, 60]], 30), [[100, 160]], 30);
    expect(duck).toEqual({ spans: [[30, 60]], db: 18, ramp: 6, away: { spans: [[100, 160]], db: 60, ramp: 15 } });
    expect([0, 30, 70, 85, 92, 100, 130, 160, 175, 200].map((f) => Math.round(duckAt(duck, f) * 10) / 10)).toEqual([0, 18, 0, 0, 28, 60, 60, 60, 0, 0]);
    // Without anything to give way on, the envelope under speech is kept as it is; without either, none.
    expect(givingWay(duckOf([[30, 60]], 30), [], 30)).toEqual(duckOf([[30, 60]], 30));
    expect(givingWay(undefined, [], 30)).toBeUndefined();
    // Giving way alone: no lowering under speech, only the spans of the clips.
    expect(givingWay(undefined, [[0, 30]], 30)).toEqual({ spans: [], db: 18, ramp: 6, away: { spans: [[0, 30]], db: 60, ramp: 15 } });
  });

  it('is written for ffmpeg as one volume expression of both lowerings; the old expression stays without one to give way on', () => {
    const duck = givingWay(duckOf([[30, 60]], 30), [[90, 120]], 30);
    expect(duckFilter(duck, 30)).toBe(",volume=volume='pow(10,-(18*min(clip((t-0.8)/0.2,0,1),clip((2.2-t)/0.2,0,1))+60*min(clip((t-2.5)/0.5,0,1),clip((4.5-t)/0.5,0,1)))/20)':eval=frame");
    expect(duckFilter(duckOf([[30, 60]], 30), 30)).toBe(",volume=volume='pow(10,-18/20*min(clip((t-0.8)/0.2,0,1),clip((2.2-t)/0.2,0,1)))':eval=frame");
    // Only the spans heard in the rendered range: a range after the speech still gives way.
    expect(duckFilter(duck, 30, 75, 2)).toBe(",volume=volume='pow(10,-(60*min(clip((t-0)/0.5,0,1),clip((2-t)/0.5,0,1)))/20)':eval=frame");
  });
});

describe('a sound effect (role "sfx")', () => {
  const withHit = (hit: Record<string, unknown>): Project => project({ tracks: [{ id: 'sound', type: 'audio', material: 'voice', role: 'voice', lines: [[150, 210]] }, { id: 'hit-1', type: 'audio', material: 'hit', role: 'sfx', ...hit } as Project['tracks'][number]] });

  it('is accepted by the schema and starts on its frame, at its gain, 6 dB lower under speech unless it leads', () => {
    const p = withHit({ at: 160, gain: -4, cue: 'the door slams' });
    expect(parseProject(p).problems).toEqual([]);
    const a = by(resolve(p, { talk: clip, show: clip }));
    expect(a['hit-1']).toEqual({ id: 'hit-1', src: 'assets/sfx/hit.wav', start: 160, gain: -4, duck: { spans: [[150, 210]], db: SFX_DUCK_DB, ramp: 6 } });
    expect(by(resolve(withHit({ at: 160, gain: -4, lead: true }), { talk: clip, show: clip }))['hit-1']?.duck).toBeUndefined();
    // Away from speech it keeps its level; an effect never makes the footage silent (it has a role).
    const away = by(resolve(withHit({ at: 20 }), { talk: clip, show: clip }));
    expect(away['hit-1']).toEqual({ id: 'hit-1', src: 'assets/sfx/hit.wav', start: 20, gain: 0, duck: { spans: [[150, 210]], db: SFX_DUCK_DB, ramp: 6 } });
    expect(away['shot-02.audio']).toBeDefined();
  });

  it('is checked: its frame inside the video, its keys only on an effect, never a bed', () => {
    const problems = (p: Project) => checkProject(p, { footage: { talk: clip, show: clip } }).map((x) => [x.level, x.at]);
    expect(problems(withHit({ at: 160 }))).toEqual([]);
    expect(problems(withHit({ at: 240 }))).toEqual([['error', 'tracks[1].at']]);
    expect(problems(withHit({}))).toEqual([['warning', 'tracks[1].at']]);
    const music = project({ music: { at: 10, lead: true } });
    expect(problems(music)).toEqual([['error', 'tracks[1].at'], ['error', 'tracks[1].lead']]);
  });

  it('plays in a project made from a reference only with the record of where it came from', async () => {
    const dir = rt.path.join(rt.dir, 'effect');
    await rt.fs.mkdir(rt.path.join(dir, 'assets', 'sfx'));
    await rt.fs.writeFile(rt.path.join(dir, 'reference.facts.json'), '{}');
    await rt.fs.writeFile(rt.path.join(dir, 'assets', 'sfx', 'hit.wav'), 'a hit');
    const p: Project = { ...withHit({ at: 160 }), tracks: [{ id: 'hit-1', type: 'audio', material: 'hit', role: 'sfx', at: 160 }] };
    const refused = await soundRecords(rt, dir, p);
    expect(refused.map((x) => x.at)).toEqual(['tracks.hit-1']);
    expect(refused[0]?.message).toContain('hit.wav.sfx.json');
    const record = await writeEffectRecord(rt, rt.path.join(dir, 'assets', 'sfx', 'hit.wav'), { source: 'catalogue', id: 'impact-hit-01' });
    expect(record).toEqual({ version: 1, source: 'catalogue', id: 'impact-hit-01', audioSha256: sha256(new TextEncoder().encode('a hit')) });
    expect(EFFECT_RECEIPT).toBe('.sfx.json');
    expect(await soundRecords(rt, dir, p)).toEqual([]);
    // The same record does not make the file a music track's.
    const asMusic: Project = { ...p, tracks: [{ id: 'hit-1', type: 'audio', material: 'hit', role: 'music' }] };
    expect(await soundRecords(rt, dir, asMusic)).toHaveLength(1);
  });
});

describe('one music source and one lead voice at a time', () => {
  it('refuses two beds at once, a bed whose gain keeps it up under a clip with music, and two such clips together', () => {
    const two = resolve(project({ tracks: [{ id: 'a', type: 'audio', material: 'music', role: 'music' }, { id: 'b', type: 'audio', material: 'music', role: 'music', during: { segment: 'shot-02', from: 0, to: 60 } }] }), { talk: clip, show: clip });
    expect(musicOverlap(two).map((p) => p.at)).toEqual(['tracks.b']);
    const fixed = resolve(project({ music: { gain: -6 } }), { talk: clip, show: { ...clip, sound: 'exhibit' } });
    expect(musicOverlap(fixed).map((p) => [p.at, (p.fix ?? '').includes('Remove "gain"')])).toEqual([['tracks.music', true]]);
    const both: Project = { ...project({ tracks: [] }), tracks: [{ id: 'over', type: 'video', material: 'show', during: { segment: 'shot-02', from: 0, to: 60 }, box: [0, 0, 0.5, 0.5] } as Project['tracks'][number]] };
    expect(musicOverlap(resolve(both, { talk: clip, show: { ...clip, sound: 'exhibit' } })).map((p) => p.at)).toEqual(['tracks.over']);
    expect(musicOverlap(resolve(project(), { talk: clip, show: { ...clip, sound: 'exhibit' } }))).toEqual([]);
  });

  it('refuses a transition over words a person says on camera', () => {
    const p = project({ tracks: [] });
    const faded: Project = { ...p, segments: [p.segments[0]!, { ...p.segments[1]!, in: { transition: 'dissolve', frames: 12 } }] };
    const talking = { talk: { ...clip, speech: [[3.5, 4.5]] as [number, number][] }, show: clip };
    expect(speakingCuts(resolve(faded, talking)).map((x) => x.at)).toEqual(['segments.shot-02.in']);
    expect(speakingCuts(resolve(p, talking))).toEqual([]);
    expect(speakingCuts(resolve(faded, { talk: { ...clip, speech: [[0.5, 1.5]] as [number, number][] }, show: clip }))).toEqual([]);
  });
});

describe.skipIf(!ffmpeg)('the rules in a render (ffmpeg)', () => {
  const file = (name: string): string => rt.path.join(rt.dir, name);
  const levelsOf = async (out: string): Promise<(from: number, to: number) => number> => {
    const pcm = (await runFfmpegOk(rt, ['-loglevel', 'error', '-i', out, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])).stdout;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    return (from, to) => {
      let sum = 0;
      for (let i = Math.round(from * 8000); i < Math.round(to * 8000); i++) sum += ((samples[i] ?? 0) / 32768) ** 2;
      return 10 * Math.log10(sum / Math.max(1, Math.round((to - from) * 8000)) + 1e-12);
    };
  };
  const render = async (name: string, audio: ResolvedAudio[]): Promise<(from: number, to: number) => number> => {
    const frames = (await runFfmpegOk(rt, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=4', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])).stdout;
    await runFfmpegOk(rt, encodeArgs({ out: file(name), fps: 30, from: 0, to: 120, image: 'png', crf: 30, audio: audio.map((a) => ({ ...a, src: file(a.src) })) }), frames);
    return levelsOf(file(name));
  };

  it('the bed gives way altogether under a clip with music of its own and comes back after it', async () => {
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '48000', '-c:a', 'libmp3lame', file('bed.mp3')]);
    const duck = givingWay(undefined, [[45, 75]], 30);
    const level = await render('give-way.mp4', [{ id: 'music', src: 'bed.mp3', start: 0, gain: 0, ...(duck ? { duck } : {}) }]);
    const before = level(0.3, 0.9), during = level(1.75, 2.25), after = level(3.2, 3.8);
    expect(before - during).toBeGreaterThan(40);
    expect(Math.abs(before - after)).toBeLessThan(1);
  }, 60_000);

  it('an effect starts on its frame and is 6 dB lower while someone speaks, unless it leads', async () => {
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.8', '-ar', '48000', '-c:a', 'pcm_s16le', file('assets-hit.wav')]);
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '4', '-c:a', 'pcm_s16le', file('silence.wav')]);
    const p: Project = {
      version: 1, canvas: { width: 32, height: 32, fps: 30 },
      materials: [{ id: 'voice', kind: 'audio', file: 'silence.wav' }, { id: 'hit', kind: 'audio', file: 'assets-hit.wav' }],
      segments: [{ id: 's', frames: 120, base: { color: '#000000' } }],
      tracks: [{ id: 'sound', type: 'audio', material: 'voice', role: 'voice', lines: [[60, 120]] }, { id: 'hit-1', type: 'audio', material: 'hit', role: 'sfx', at: 30 }, { id: 'hit-2', type: 'audio', material: 'hit', role: 'sfx', at: 75 }],
    };
    const level = await render('sfx.mp4', resolve(p, {}).audio);
    // Nothing before frame 30; the first hit at its level (no speech then); the second under the voice's line.
    expect(level(0.2, 0.9)).toBeLessThan(-60);
    const free = level(1.1, 1.7), under = level(2.6, 3.2);
    expect(free - under).toBeCloseTo(SFX_DUCK_DB, 0);
    const lead: Project = { ...p, tracks: p.tracks.map((t) => (t.id === 'hit-2' ? { ...t, lead: true as const } : t)) };
    const led = await render('sfx-lead.mp4', resolve(lead, {}).audio);
    expect(Math.abs(led(1.1, 1.7) - led(2.6, 3.2))).toBeLessThan(1);
  }, 60_000);
});
