import path from 'node:path/posix';
import { describe, expect, it } from 'vitest';
import type { Runtime } from '../../src/runtime';
import { sha256 } from '../../src/core/util';
import { copyObservedSpeech, observedSeconds, OBSERVED_SPEECH, readObservedSpeech, type NativeSpeechObservation } from '../../src/video/replication/speech-observed';
import { outputAudioProblems } from '../../src/video/replication/production';
import { speechSpans } from '../../src/video/media/footage';
import { resolve } from '../../src/video/timeline/resolve';
import { speechOverlap } from '../../src/video/project/check-sound';
import type { Project, Resolved } from '../../src/video/types';
import type { ReplicationContract } from '../../src/video/replication/contract';

// Keep pure observation checks independent of CLI and provider integrations.
const memory = () => {
  const files = new Map<string, Uint8Array>(), encoder = new TextEncoder();
  const fs = {
    writeFile: async (p: string, v: string | Uint8Array) => { files.set(path.resolve(p), typeof v === 'string' ? encoder.encode(v) : v.slice()); },
    readFile: async (p: string) => { const v = files.get(path.resolve(p)); if (!v) throw new Error('missing ' + p); return v; },
    readText: async (p: string) => new TextDecoder().decode(await fs.readFile(p)),
    stat: async (p: string) => { const v = files.get(path.resolve(p)); return v ? { isFile: true, isDirectory: false, size: v.length, mtimeMs: 0 } : null; },
    rm: async (p: string) => { files.delete(path.resolve(p)); },
  };
  return { rt: { fs, path, cwd: '/work' } as unknown as Runtime, files };
};
const root = '/work/project', clip = 'assets/native.mp4', bytes = new TextEncoder().encode('controlled native fixture');
const clipHash = sha256(bytes), clock = { fps: 24, frames: 120 };
const asr = { language: 'en', fps: 25, words: [{ text: 'Hello', start: 2, end: 10 }, { text: 'again', start: 25, end: 50 }] };
const review = () => ({ words: 'passed' as const, articulation: 'passed' as const, evidence: [
  { kind: 'observed' as const, detail: 'Inspected first mouth motion in the controlled test fixture.', file: clip, sha256: clipHash, media: 'video' as const, frame: 2 },
  { kind: 'observed' as const, detail: 'Inspected later articulation in the controlled fixture.', file: clip, sha256: clipHash, media: 'video' as const, frame: 47 },
  { kind: 'observed' as const, detail: 'Audible words inspected on this exact native clip.', file: clip, sha256: clipHash, media: 'video' as const, at: [.08, 2] as [number, number] },
] });
const fixture = async () => {
  const { rt, files } = memory();
  await rt.fs.writeFile(root + '/' + clip, bytes);
  const transcriptBytes = JSON.stringify(asr); await rt.fs.writeFile(root + '/asr.json', transcriptBytes);
  const o: NativeSpeechObservation = {
    format: 'popost-native-speech-observation', version: 1, videoSha256: clipHash, source: clock,
    transcript: { file: 'asr.json', sha256: sha256(encoder(transcriptBytes)), fps: 25, media: 'data' },
    spansSeconds: [[.08, .4], [1, 2]], review: review(),
  };
  await rt.fs.writeFile(root + '/' + clip + '.speech.json', JSON.stringify({ version: 1, mode: 'native', videoSha256: clipHash, lines: [{ at: 2.5, to: 4.8, speaker: 'host', text: 'Requested words' }] }));
  const save = async () => rt.fs.writeFile(root + '/' + clip + OBSERVED_SPEECH, JSON.stringify(o));
  await save(); return { rt, files, o, save };
};
const encoder = (v: string) => new TextEncoder().encode(v);

describe('independent native speech observations', () => {
  it('converts the actual ASR clock to seconds without treating ASR25 as native24', () => {
    expect(observedSeconds(asr, 5)).toEqual({ fps: 25, spans: [[.08, .4], [1, 2]] });
    expect(() => observedSeconds({ ...asr, words: [{ text: 'late', start: 130, end: 140 }] }, 5)).toThrow('media duration');
    expect(() => observedSeconds({ ...asr, words: [...asr.words].reverse() }, 5)).toThrow('ordered');
  });
  it('reads actual timing independently of unchanged requested lead-in slots', async () => {
    const { rt } = await fixture();
    const before = await rt.fs.readText(root + '/' + clip + '.speech.json');
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).spans).toEqual([[.08, .4], [1, 2]]);
    expect(await rt.fs.readText(root + '/' + clip + '.speech.json')).toBe(before);
    // The legacy receipt API remains unchanged; strict probing chooses the observation instead.
    expect(await speechSpans(rt, root + '/' + clip, 5)).toEqual([[2.5, 4.8]]);
  });
  it('allows a missing observation for a first draft but never strict final acceptance', async () => {
    const { rt } = await fixture(); await rt.fs.rm(root + '/' + clip + OBSERVED_SPEECH);
    expect(await readObservedSpeech(rt, root, clip, { clock })).toEqual({ problems: [] });
    const final = await readObservedSpeech(rt, root, clip, { clock, required: true, final: true });
    expect(final.problems[0]?.message).toContain('requested line slots are not evidence');
  });
  it('does not treat ASR timing as proof that words or lips are correct', async () => {
    const { rt, o, save } = await fixture(); delete o.review; await save();
    expect((await readObservedSpeech(rt, root, clip, { clock })).spans).toEqual([[.08, .4], [1, 2]]);
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).problems[0]?.message).toContain('not both passed');
    o.review = { ...review(), evidence: [{ kind: 'observed', detail: 'pass' }] }; await save();
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).problems).toHaveLength(2);
  });
  it('requires distinct in-range video frames and an audible interval from the same clip', async () => {
    const { rt, o, save } = await fixture(); o.review!.evidence[1]!.frame = 2; await save();
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).problems.some(p => p.message.includes('two distinct'))).toBe(true);
    o.review = review(); o.review.evidence[1]!.frame = 121; await save();
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).problems.some(p => p.message.includes('outside'))).toBe(true);
    o.review = review(); o.review.evidence[1]!.frame = 100; await save();
    expect((await readObservedSpeech(rt, root, clip, { clock, final: true })).problems.some(p => p.message.includes('outside the actually observed speech'))).toBe(true);
  });
  it('rejects media, ASR, native FPS/frame-count and manually edited timing changes', async () => {
    const a = await fixture(); await a.rt.fs.writeFile(root + '/' + clip, 'changed clip');
    expect((await readObservedSpeech(a.rt, root, clip, { clock })).problems[0]?.message).toContain('media changed');
    const b = await fixture(); await b.rt.fs.writeFile(root + '/asr.json', JSON.stringify({ ...asr, fps: 24 }));
    expect((await readObservedSpeech(b.rt, root, clip, { clock })).problems.length).toBeGreaterThan(0);
    const d = await fixture();
    expect((await readObservedSpeech(d.rt, root, clip, { clock: { fps: 25, frames: 120 } })).problems[0]?.message).toContain('clock differs');
    d.o.spansSeconds[0] = [2.5, 4.8]; await d.save();
    expect((await readObservedSpeech(d.rt, root, clip, { clock })).problems[0]?.message).toContain('ASR clock/words');
  });
  it('copies the independent sidecar and every bound ASR/review file portably', async () => {
    const { rt, o, save } = await fixture();
    const reviewBytes = JSON.stringify(o.review); await rt.fs.writeFile(root + '/actual-review.json', reviewBytes);
    o.reviewSource = { file: 'actual-review.json', sha256: sha256(encoder(reviewBytes)), media: 'data' }; await save();
    const dest = '/work/copy';
    await rt.fs.writeFile(dest + '/' + clip, bytes);
    await rt.fs.writeFile(dest + '/' + clip + '.speech.json', await rt.fs.readFile(root + '/' + clip + '.speech.json'));
    await copyObservedSpeech(rt, root, dest, clip);
    await rt.fs.rm(root + '/asr.json'); await rt.fs.rm(root + '/actual-review.json');
    const copied = await readObservedSpeech(rt, dest, clip, { clock, final: true });
    expect(copied.problems).toEqual([]); expect(copied.spans).toEqual([[.08, .4], [1, 2]]);
    expect(copied.observation!.transcript.file).toMatch(/^replication-speech-evidence\//);
  });
  it('does not silently copy stale observations or fall back to requested timing', async () => {
    const { rt } = await fixture(); await rt.fs.writeFile(root + '/asr.json', '{}');
    await expect(copyObservedSpeech(rt, root, '/work/copy', clip)).rejects.toThrow();
    expect(await rt.fs.stat('/work/copy/' + clip + OBSERVED_SPEECH)).toBeNull();
  });
  it('maps observed seconds through native24 source-in,2x playback and target30 for real ducking', async () => {
    const { rt } = await fixture(); const actual = await readObservedSpeech(rt, root, clip, { clock });
    const project: Project = {
      version: 1, canvas: { width: 320, height: 180, fps: 30 },
      materials: [{ id: 'native', kind: 'video', file: clip }, { id: 'music', kind: 'audio', file: 'bed.wav' }],
      segments: [{ id: 'take', frames: 60, base: { material: 'native', in: 12, speed: 2 } }],
      tracks: [{ id: 'music', type: 'audio', material: 'music', role: 'music' }],
    };
    const r = resolve(project, { native: { width: 320, height: 180, ...clock, hasAudio: true, speech: actual.spans } });
    expect(r.speech?.dialogue[0]?.spans).toEqual([[8, 23]]);
    expect(r.audio.find(a => a.id === 'music')?.duck?.spans).toEqual([[8, 23]]);
    expect(r.audio.find(a => a.src === clip)).toMatchObject({ from: { frame: 12, fps: 24 }, speed: 2 });
  });
  it('requires observations for actual strict audible native routes but leaves silent clips alone', async () => {
    const { rt } = await fixture();
    const c: ReplicationContract = { format: 'popost-video-replication', version: 1, source: { fingerprint: clipHash, ...clock }, audio: { sourceSpeech: 'present', sourceRoles: ['dialogue'], narration: 'preserve', evidence: [] }, visual: { medium: 'live action', style: ['photographic'], evidence: [] }, inventory: { status: 'complete', evidence: [] }, events: [] };
    const r: Resolved = { canvas: { width: 320, height: 180, fps: 30 }, frames: 150, segments: [], items: [], audio: [{ id: 'native.audio', src: clip, start: 0, end: 150, gain: 0 }], footage: { native: { src: clip, ...clock } } };
    await rt.fs.writeFile(root + '/replication.audio.json', JSON.stringify({ version: 1, items: [{ file: clip, sha256: clipHash, kind: 'native', role: 'dialogue', speech: 'present', evidence: [] }] }));
    expect(await outputAudioProblems(rt, root, c, r)).toEqual([]);
    await rt.fs.rm(root + '/' + clip + OBSERVED_SPEECH);
    expect((await outputAudioProblems(rt, root, c, r)).some(p => p.at.endsWith(OBSERVED_SPEECH))).toBe(true);
    const silent = { ...c, audio: { sourceSpeech: 'absent' as const, sourceRoles: [], narration: 'preserve' as const, evidence: [] } };
    expect(await outputAudioProblems(rt, root, silent, { ...r, audio: [] })).toEqual([]);
  });
});

describe('strict observed speech carried by a native bed', () => {
  const project = (visible = false): Project => ({
    version: 1, canvas: { width: 320, height: 180, fps: 30 },
    materials: [{ id: 'native', kind: 'video', file: clip }, { id: 'music', kind: 'audio', file: 'music.wav' }],
    segments: [{ id: 'scene', frames: 60, base: visible ? { material: 'native', in: 12 } : { color: '#101020' } }],
    tracks: [{ id: 'native-bed', type: 'audio', material: 'native', bed: true, in: 12 }, { id: 'music', type: 'audio', material: 'music', role: 'music' }],
  });
  const facts = (observed = true) => ({ native: { width: 320, height: 180, ...clock, hasAudio: true, speech: [[.08, .4], [1, 2]] as [number, number][], ...(observed ? { speechObserved: true as const } : {}) } });
  it('uses actual bed-only speech under B-roll for music ducking on its source clock', () => {
    const r = resolve(project(), facts());
    expect(r.speech?.dialogue).toEqual([{ id: 'native-bed', spans: [[15, 45]] }]);
    expect(r.audio.find(a => a.id === 'music')?.duck?.spans).toEqual([[15, 45]]);
    expect(r.audio.find(a => a.id === 'native-bed')?.duck).toBeUndefined();
  });
  it('plays a visible native clip through its same-source bed once and reports one speech interval', () => {
    const r = resolve(project(true), facts());
    expect(r.audio.filter(a => a.src === clip)).toHaveLength(1);
    expect(r.speech?.dialogue).toEqual([{ id: 'native-bed', spans: [[15, 45]] }]);
    expect(r.audio.find(a => a.id === 'music')?.duck?.spans).toEqual([[15, 45]]);
  });
  it('detects a narrator over actual native-bed speech and ducks other ambience/music', () => {
    const p = project();
    p.materials.push({ id: 'voice', kind: 'audio', file: 'voice.wav' }, { id: 'ambience', kind: 'video', file: 'ambience.mp4' });
    p.tracks.push({ id: 'voice', type: 'audio', material: 'voice', role: 'voice', lines: [[12, 18]] }, { id: 'ambience', type: 'audio', material: 'ambience', bed: true });
    const r = resolve(p, { ...facts(), ambience: { width: 320, height: 180, ...clock, hasAudio: true } });
    expect(speechOverlap(r).some(p => p.message.includes('two speeches'))).toBe(true);
    expect(r.audio.find(a => a.id === 'ambience')?.duck?.spans).toEqual([[12, 45]]);
    expect(r.audio.find(a => a.id === 'music')?.duck?.spans).toEqual([[12, 45]]);
  });
  it('keeps legacy bed-only requested timing behavior unchanged and never upgrades it to observed', () => {
    const r = resolve(project(), facts(false));
    expect(r.speech).toBeUndefined(); expect(r.audio.find(a => a.id === 'music')?.duck).toBeUndefined();
  });
});
