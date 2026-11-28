/**
 * What is refused because nobody asked for it: a voice-over on a reference without narration, a sound without a
 * record of where it came from, an on-camera line no clip says, an audio track written into a project by hand. Each
 * refusal is an error with its fix. The reference is written by hand; the commands run through the CLI; nothing is
 * spoken or generated.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { readReference } from '../../src/video/describe/parts';
import type { SpeechFile, SpeechKind, SpeechStatus } from '../../src/video/describe/speech-kind';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { hasMusicTrack, ownSound, readMusicPlan, soundProblems, soundSource } from '../../src/video/music/provenance';
import { soundRecords, writeVoiceReceipt } from '../../src/video/project/check-sound';
import { spokenLinesOf } from '../../src/video/retarget/speak';
import { loadTemplate } from '../../src/video/template/save';
import { beatsNotSpoken, dialogueFillProblems, readVoiceAsked, VOICE_FIX, voiceProblems, voiceWanted } from '../../src/video/template/speech-rules';
import type { TextTrack } from '../../src/video/text/types';
import { ToolError } from '../../src/video/tool';
import type { Measure, Problem, Project } from '../../src/video/types';

const rt = await createDiskRuntime();
afterAll(async () => { await rt.cleanup(); });
const ffmpeg = await hasFfmpeg(rt);
const at = (...parts: string[]): string => path.join(rt.dir, ...parts);
const put = async (file: string, value: unknown): Promise<void> => { await mkdir(path.dirname(at(file)), { recursive: true }); await writeFile(at(file), typeof value === 'string' ? value : JSON.stringify(value)); };
const problems = (): Problem[] => (rt.json() as { problems: Problem[] }).problems;
const cli = async (...argv: string[]): Promise<number> => (await runCli(rt, ['video', ...argv])).code;

const still = { kind: 'static' as const, zoomPerS: 0, panPerS: [0, 0] as [number, number], confidence: 1 };
const shot = (index: number, start: number, end: number) => ({ index, start, end, camera: still, background: '#203040', palette: [{ hex: '#203040', share: 0.5 }], events: [] });
/** Two shots of 5 s, with three caption lines. */
const measure: Measure = {
  version: 1, source: { width: 720, height: 1280, fps: 30, frames: 300, duration: 10, hasAudio: true },
  boundaries: [{ frame: 150, kind: 'cut', start: 149, end: 150, confidence: 1 }], shots: [shot(0, 0, 150), shot(1, 150, 300)],
  rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' },
};
const cue = (text: string, start: number, end: number) => ({ text, start, end, box: [0.25, 0.825, 0.5, 0.05] as [number, number, number, number], role: 'caption' as const, size: 0.05, samples: 5, confidence: 0.95 });
const text: TextTrack = { step: 6, sampled: 50, cues: [cue('First line here', 0, 90), cue('Second line here', 90, 150), cue('Third line here', 160, 290)] };
const record = (status: SpeechStatus, kinds: SpeechKind[], phrases: SpeechFile['phrases'] = []): SpeechFile =>
  ({ format: 'popost-video-speech', version: 1, status, fps: 30, seconds: { spoken: 0, video: 10 }, confirmed: true, kinds, phrases });
/** A template of the reference above whose speech has the given record, saved through the CLI. */
const template = async (name: string, speech: SpeechFile): Promise<string> => {
  await put('ref-' + name + '/measure.json', measure);
  await put('ref-' + name + '/text.json', text);
  await put('ref-' + name + '/speech.json', speech);
  expect(await cli('template', 'save', 'ref-' + name, '--out', 'tpl-' + name, '--name', name)).toBe(0);
  return 'tpl-' + name;
};
const FILL = { shots: [{ color: '#101014' }, { color: '#e9c46a' }], captions: ['One short line', 'Another one', 'And the last'] };

describe('a voice the reference gives no reason for', () => {
  it('is an error for every kind without narration, with the fix: leave the voice out', () => {
    const wants = voiceWanted({ voice: 'popost:default-male' }, { speak: true });
    expect(wants).toEqual(['"voice"', '--speak']);
    for (const kinds of [['none'], ['fragments'], ['sung'], ['unknown'], ['on-camera'], ['on-camera', 'sung']] as SpeechKind[][]) {
      const p = voiceProblems({ status: 'transcribed', kinds }, wants, undefined);
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ level: 'error', at: '"voice"', fix: VOICE_FIX });
      expect(p[0]?.message).toContain('The reference has no narration');
    }
    expect(VOICE_FIX).toContain('Leave the voice out');
    expect(VOICE_FIX).toContain('--voice-asked');
    expect(voiceProblems({ status: 'skipped', kinds: ['unknown'] }, wants, undefined)[0]?.message).toContain('an unknown kind is treated as no narration');
    // Narration, the user's own words, no voice asked for, and a template saved before the kinds existed: nothing.
    expect(voiceProblems({ status: 'transcribed', kinds: ['narration', 'on-camera'] }, wants, undefined)).toEqual([]);
    expect(voiceProblems({ status: 'transcribed', kinds: ['none'] }, wants, 'please add a narrator')).toEqual([]);
    expect(voiceProblems({ status: 'transcribed', kinds: ['none'] }, voiceWanted({}), undefined)).toEqual([]);
    expect(voiceProblems(undefined, wants, undefined)).toEqual([]);
    expect(voiceWanted({ say: [{ text: 'SaaS', as: 'sass' }] })).toEqual(['"say"']);
  });

  it('is refused by template check and template fill, and let through with the user\'s words, which the project keeps', async () => {
    const tpl = await template('silent', record('skipped', ['unknown']));
    await put('fill-voice.json', { ...FILL, voice: 'popost:default-male' });
    expect(await cli('template', 'check', tpl, '--fill', 'fill-voice.json')).toBe(2);
    expect(problems().filter((p) => p.level === 'error')).toMatchObject([{ at: '"voice"', fix: VOICE_FIX }]);
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-voice.json', '--out', 'project-silent')).toBe(2);
    // --speak alone asks for a voice too.
    await put('fill-plain.json', FILL);
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-plain.json', '--out', 'project-silent', '--speak')).toBe(2);
    expect(problems().find((p) => p.level === 'error')).toMatchObject({ at: '--speak', fix: VOICE_FIX });
    // Without a voice the fill is fine.
    expect(await cli('template', 'check', tpl, '--fill', 'fill-plain.json')).toBe(0);
    // The user asked for a narration: the flag carries their words, the project keeps them, later commands need no flag.
    expect(await cli('template', 'check', tpl, '--fill', 'fill-voice.json', '--voice-asked', 'please add a narrator')).toBe(0);
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-voice.json', '--out', 'project-silent', '--voice-asked', 'please add a narrator')).toBe(0);
    const filled = rt.json() as { written: string[]; notes: string[] };
    expect(filled.written).toContain('voice-asked.json');
    expect(filled.notes.join(' ')).toContain('the voice-over is there because the user asked for it ("please add a narrator")');
    expect(await readVoiceAsked(rt, at('project-silent'))).toBe('please add a narrator');
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-voice.json', '--out', 'project-silent')).toBe(0);
    expect(await cli('template', 'check', tpl, '--fill', 'fill-voice.json', '--assets', 'project-silent')).toBe(0);
    // plan --voice would time the voice (paid): refused first.
    expect(await cli('plan', tpl, '--brief', 'a coffee grinder', '--dry', '--voice', 'popost:default-male')).toBe(2);
    expect(problems()[0]).toMatchObject({ at: '--voice', fix: VOICE_FIX });
  });

  it('is not held against a reference that has narration', async () => {
    const tpl = await template('narrated', record('transcribed', ['narration'], [{ index: 0, start: 0, end: 290, text: 'x', kind: 'narration' }]));
    await put('fill-voice.json', { ...FILL, voice: 'popost:default-male' });
    expect(await cli('template', 'check', tpl, '--fill', 'fill-voice.json')).toBe(0);
  });
});

describe('a sound without a record', () => {
  it('is refused where it enters, and taken in as the user\'s file with their words', async () => {
    const tpl = await template('sound', record('transcribed', ['none']));
    await put('project-sound/assets/music.mp3', 'a track mixed by hand');
    await put('fill-sound.json', { ...FILL, sound: 'assets/music.mp3' });
    // Without the files at hand nothing is looked at; with them, the sound has to say where it came from.
    expect(await cli('template', 'check', tpl, '--fill', 'fill-sound.json')).toBe(0);
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-sound.json', '--out', 'project-sound')).toBe(2);
    const refused = problems().find((p) => p.at === 'sound');
    expect(refused?.message).toContain('"assets/music.mp3" has no record of where it came from');
    expect(refused?.fix).toContain('popost video music own --file');
    expect(refused?.fix).toContain('never take the sound out of the reference');
    // The user's own file, with the words that gave it.
    await put('downloads/my-song.mp3', 'the user\'s song');
    expect(await cli('music', 'own', '--file', 'downloads/my-song.mp3', '--out', 'project-sound/assets/music.mp3', '--given', 'use my song for the music')).toBe(0);
    expect(await soundSource(rt, at('project-sound/assets/music.mp3'))).toBe('user');
    expect(JSON.parse(await readFile(at('project-sound/assets/music.mp3.sound.json'), 'utf8'))).toMatchObject({ source: 'user', given: 'use my song for the music', from: 'my-song.mp3' });
    expect(await cli('template', 'fill', tpl, '--fill', 'fill-sound.json', '--out', 'project-sound')).toBe(0);
    // A file changed after its record was written has no record any more.
    await put('project-sound/assets/music.mp3', 'something else');
    expect(await soundProblems(rt, at('project-sound'), 'assets/music.mp3', 'sound')).toHaveLength(1);
  });

  it('is never a video\'s sound or a narration made with a voice tool, and generated music is known by its receipt', async () => {
    await put('own/reference.mp4', 'video');
    await expect(ownSound(rt, { file: at('own/reference.mp4'), out: at('own/assets/sound.mp3'), given: 'the music of the reference' })).rejects.toThrow('The sound of a reference or of another video is never taken');
    await put('own/narration.wav', 'speech');
    await put('own/narration.wav.voice.json', {});
    await expect(ownSound(rt, { file: at('own/narration.wav'), out: at('own/assets/sound.wav'), given: 'narration' })).rejects.toThrow('A voice-over is the fill\'s "voice"');
    await expect(ownSound(rt, { file: at('own/narration.wav'), out: at('own/assets/sound.wav'), given: ' ' })).rejects.toThrow('--given quotes the user\'s words');
    await put('own/assets/music.mp3', 'generated');
    await put('own/assets/music.mp3.music.json', { audioSha256: sha256(new TextEncoder().encode('generated')) });
    expect(await soundSource(rt, at('own/assets/music.mp3'))).toBe('generated');
    expect(await hasMusicTrack(rt, at('own'))).toBe(true);
    expect(await hasMusicTrack(rt, at('nowhere'))).toBe(false);
    // The plan the user agreed to is on record; none says the clips keep their own sound.
    expect(await cli('music', 'plan', '--project', 'own', '--music', 'none')).toBe(0);
    expect(await readMusicPlan(rt, at('own'))).toEqual({ version: 1, music: 'none' });
    expect(await hasMusicTrack(rt, at('own'))).toBe(false);
    expect(await cli('music', 'plan', '--project', 'own', '--music', 'own')).toBe(0);
    expect(await hasMusicTrack(rt, at('own'))).toBe(true);
  });

  it('is refused as an audio track written into a project made from a reference', async () => {
    const dir = at('project-tracks');
    const project: Project = {
      version: 1, canvas: { width: 320, height: 180, fps: 30 },
      materials: [{ id: 'voice', kind: 'audio', file: 'assets/voice.m4a' }, { id: 'extra', kind: 'audio', file: 'assets/narration.mp3' }],
      segments: [{ id: 'shot-01', frames: 60, base: { color: '#101010' } }],
      tracks: [{ id: 'sound', type: 'audio', material: 'voice', role: 'voice', lines: [[0, 30]] }, { id: 'narration', type: 'audio', material: 'extra' }],
    };
    await put('project-tracks/assets/voice.m4a', 'voice');
    await put('project-tracks/assets/narration.mp3', 'put together with other tools');
    // A project written by hand, with no reference behind it, is held to nothing.
    expect(await soundRecords(rt, dir, project)).toEqual([]);
    await put('project-tracks/reference.facts.json', {});
    const both = await soundRecords(rt, dir, project);
    expect(both.map((p) => p.at)).toEqual(['tracks.sound', 'tracks.narration']);
    expect(both[1]?.message).toContain('has no record of where it came from');
    // The voice the engine mixed has its record.
    await writeVoiceReceipt(rt, at('project-tracks/assets/voice.m4a'), 1);
    expect((await soundRecords(rt, dir, project)).map((p) => p.at)).toEqual(['tracks.narration']);
  });
});

describe('a line the reference says on camera', () => {
  const phrases: SpeechFile['phrases'] = [{ index: 0, start: 0, end: 150, text: 'x', kind: 'narration' }, { index: 1, start: 160, end: 290, text: 'y', kind: 'on-camera' }];
  let tpl = '';
  beforeAll(async () => { tpl = await template('talk', record('transcribed', ['narration', 'on-camera'], phrases)); });
  const fill = { shots: [{ color: '#101014' }, { footage: 'assets/talk.mp4', in: 0 }], captions: FILL.captions, voice: 'popost:default-male' };

  it('is never read by the voice-over', async () => {
    const pkg = await loadTemplate(rt, at(tpl));
    expect(pkg.template.captions?.beats.map((b) => b.speech)).toEqual([undefined, undefined, 'on-camera']);
    expect(beatsNotSpoken(pkg, new Map(), undefined)).toEqual([2]);
    expect(spokenLinesOf(fill as never, [2])).toEqual(['One short line', 'Another one', '']);
    // A narration the user asked for reads the on-camera lines no clip says, and leaves alone those a clip says.
    expect(beatsNotSpoken(pkg, new Map(), 'narrate everything')).toEqual([]);
    expect(beatsNotSpoken(pkg, new Map([[2, ['assets/talk.mp4']]]), 'narrate everything')).toEqual([2]);
  });

  it('must be said by a clip of the fill: silent footage with a voice over it is refused', async () => {
    const pkg = await loadTemplate(rt, at(tpl));
    const dir = at('project-talk');
    await put('project-talk/assets/talk.mp4', 'clip');
    const open = await dialogueFillProblems(rt, pkg, fill as never, dir, undefined);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ level: 'error', at: 'captions[2]' });
    expect(open[0]?.message).toContain('The reference says beat 2 on camera, and no clip of the fill says its line');
    expect(open[0]?.fix).toContain('"speech": {"mode": "native"');
    expect(open[0]?.fix).toContain('Never replace a person who speaks with silent footage and a voice-over');
    expect(open[0]?.fix).toContain('stop and tell the user the price');
    // The clip that says the line has a receipt naming the beat.
    await put('project-talk/assets/talk.mp4.speech.json', { version: 1, mode: 'native', language: 'en-US', lines: [{ speaker: 'host', text: 'And the last', at: 0.3, to: 4.6, beat: 2 }] });
    expect(await dialogueFillProblems(rt, pkg, fill as never, dir, undefined)).toEqual([]);
    // A clip made with the first form of speech (one speaker's words, no beat named) says the on-camera beats of its shot.
    await put('project-talk/assets/talk.mp4.speech.json', { version: 1, mode: 'native', speaker: 'host', text: 'And the last' });
    expect(await dialogueFillProblems(rt, pkg, fill as never, dir, undefined)).toEqual([]);
    // An empty line asks for nothing; the user's own words for a narration lift the refusal.
    await put('project-talk/assets/talk.mp4.speech.json', {});
    expect(await dialogueFillProblems(rt, pkg, { ...fill, captions: ['a', 'b', ''] } as never, dir, undefined)).toEqual([]);
    expect(await dialogueFillProblems(rt, pkg, fill as never, dir, 'narrate everything')).toEqual([]);
  });
});

describe.skipIf(!ffmpeg)('a transcription that fails', () => {
  it('leaves the rest of the reading standing and is reported as failed, not as a missing tool', async () => {
    const video = at('failing.mp4');
    await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x64:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    const r = await readReference(rt, video, { transcriber: { transcribe: () => Promise.reject(new ToolError('The popost.ai transcription failed; run the same command again to start a new one.')) } });
    expect(r.measure.shots.length).toBeGreaterThan(0);
    expect(r.transcript).toBeUndefined();
    expect(r.speechFailed).toBe('The popost.ai transcription failed; run the same command again to start a new one.');
    // Anything that is not a tool's failure (a price, a refusal) still stops the reading.
    await expect(readReference(rt, video, { transcriber: { transcribe: () => Promise.reject(new Error('not a tool error')) } })).rejects.toThrow('not a tool error');
  }, 120_000);
});
