/** Real media transport/clock tests. The controlled transcript/review fixtures are not an ASR or lip-sync quality score. */
import { afterAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/core/util';
import { createDiskRuntime } from '../../src/testing/disk';
import { runCli } from '../../src/testing/memory';
import { hasFfmpeg, runFfmpegOk } from '../../src/video/media/ffmpeg';
import { probeFootage } from '../../src/video/compile/footage';
import { buildPage } from '../../src/video/compile/index';
import { readObservedSpeech, OBSERVED_SPEECH } from '../../src/video/replication/speech-observed';
import { outputAudioProblems } from '../../src/video/replication/production';
import { saveTemplate, loadTemplate } from '../../src/video/template/save';
import { fillPackage } from '../../src/video/template/fill';
import type { ReplicationContract } from '../../src/video/replication/contract';
import type { Measure, Project } from '../../src/video/types';

const rt = await createDiskRuntime({ env: { POPOST_CPUS: '1' } }), available = await hasFfmpeg(rt);
afterAll(async () => rt.cleanup());
const json = async (file: string, value: unknown) => rt.fs.writeFile(file, JSON.stringify(value));
const source = (hash: string): ReplicationContract => ({
  format: 'popost-video-replication', version: 1, source: { fingerprint: hash, fps: 24, frames: 48 },
  audio: { sourceSpeech: 'present', sourceRoles: ['dialogue'], narration: 'preserve', evidence: [{ kind: 'observed', detail: 'Controlled source-audio fixture classification.', file: 'assets/take.mp4', sha256: hash, media: 'video', at: [0, 2] }] },
  visual: { medium: 'photographic', style: ['controlled test image'], evidence: [{ kind: 'observed', detail: 'Controlled source visual fixture.', file: 'assets/take.mp4', sha256: hash, media: 'video', frame: 0 }] }, inventory: { status: 'complete', evidence: [{ kind: 'observed', detail: 'Controlled source inventory fixture.', file: 'assets/take.mp4', sha256: hash, media: 'video', frame: 0 }] }, events: [],
});
const setup = async (name: string) => {
  const dir = rt.dir + '/' + name, file = 'assets/take.mp4'; await rt.fs.mkdir(dir + '/assets');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x96:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dir + '/' + file]);
  const hash = sha256(await rt.fs.readFile(dir + '/' + file));
  const requested = { version: 1, mode: 'native', videoSha256: hash, lines: [{ speaker: 'host', text: 'A requested line', at: 1.5, to: 1.8 }] };
  await json(dir + '/' + file + '.speech.json', requested);
  await json(dir + '/actual-asr.json', { fps: 25, language: 'en', words: [{ text: 'first', start: 2, end: 10 }, { text: 'second', start: 25, end: 40 }] });
  const review = { words: 'passed', articulation: 'passed', evidence: [
    { kind: 'observed', detail: 'Controlled transport fixture audible interval.', file, sha256: hash, media: 'video', at: [.08, 1.6] },
    { kind: 'observed', detail: 'Controlled first review frame.', file, sha256: hash, media: 'video', frame: 6 },
    { kind: 'observed', detail: 'Controlled later review frame.', file, sha256: hash, media: 'video', frame: 30 },
  ] };
  await json(dir + '/actual-review.json', review);
  await json(dir + '/replication.json', source(hash));
  await json(dir + '/replication.audio.json', { version: 1, items: [{ file, sha256: hash, kind: 'native', role: 'dialogue', speech: 'present', evidence: [] }] });
  const project: Project = { version: 1, canvas: { width: 160, height: 96, fps: 24 }, materials: [{ id: 'take', kind: 'video', file }], segments: [{ id: 'take', frames: 48, base: { material: 'take' } }], tracks: [] };
  return { dir, file, hash, requested, project };
};

describe.skipIf(!available)('actual native observation import and portable fill', () => {
  it('imports with the actual CLI, keeps requested receipt bytes, and compiles observed seconds', async () => {
    const { dir, file, project } = await setup('cli');
    const receipt = await rt.fs.readText(dir + '/' + file + '.speech.json');
    const before = await probeFootage(rt, project, dir);
    expect(before.info.take).toMatchObject({ fps: 24, frames: 48, speech: [[0, 2]] });
    expect(await runCli(rt, ['video', 'replication', 'observe', dir, '--media', dir + '/' + file, '--transcript', dir + '/actual-asr.json', '--review', dir + '/actual-review.json'])).toMatchObject({ code: 0 });
    const actual = await readObservedSpeech(rt, dir, file, { required: true, final: true });
    expect(actual.problems).toEqual([]); expect(actual.spans).toEqual([[.08, .4], [1, 1.6]]);
    expect(await rt.fs.readText(dir + '/' + file + '.speech.json')).toBe(receipt);
    expect((await probeFootage(rt, project, dir)).info.take).toMatchObject({ fps: 24, frames: 48, speech: [[.08, .4], [1, 1.6]] });
    await rt.fs.rm(dir + '/replication.json');
    expect((await probeFootage(rt, project, dir)).info.take).toMatchObject({ speech: [[1.5, 1.8]] });
  });
  it('carries independent ASR/review evidence through --assets and a refill after the source folder disappears', async () => {
    const { dir, file, hash } = await setup('portable');
    expect(await runCli(rt, ['video', 'replication', 'observe', dir, '--media', dir + '/' + file, '--transcript', dir + '/actual-asr.json', '--review', dir + '/actual-review.json'])).toMatchObject({ code: 0 });
    const measure: Measure = { version: 1, source: { width: 160, height: 96, fps: 24, frames: 48, duration: 2, hasAudio: true }, boundaries: [], shots: [{ index: 0, start: 0, end: 48, camera: { kind: 'static', zoomPerS: 0, panPerS: [0, 0], confidence: 1 }, background: '#101020', palette: [{ hex: '#000080', share: 1 }], events: [] }], rhythm: { step: 3, change: [] }, signature: { every: 3, width: 16, height: 16, count: 0, data: '' } };
    const templateDir = rt.dir + '/template', projectDir = rt.dir + '/filled';
    expect((await saveTemplate(rt, { measure, name: 'Controlled observation transport', referenceDir: dir, outDir: templateDir })).problems.filter(p => p.level === 'error')).toEqual([]);
    const pkg = await loadTemplate(rt, templateDir), fill = { shots: [{ footage: file }] };
    const filled = await fillPackage(rt, pkg, { outDir: projectDir, assetsDir: dir, fill });
    expect(filled.problems.filter(p => p.level === 'error')).toEqual([]); expect(filled.project).toBeDefined();
    expect(await rt.fs.stat(projectDir + '/' + file + OBSERVED_SPEECH)).not.toBeNull();
    await rt.fs.rm(dir);
    expect((await readObservedSpeech(rt, projectDir, file, { final: true })).problems).toEqual([]);
    const refilled = await fillPackage(rt, pkg, { outDir: projectDir, fill });
    expect(refilled.problems.filter(p => p.level === 'error')).toEqual([]);
    const built = await buildPage(rt, projectDir);
    expect(built.problems.filter(p => p.level === 'error')).toEqual([]);
    expect(built.resolved!.speech?.dialogue[0]?.spans).toEqual([[2, 10], [24, 38]]);
    expect(await outputAudioProblems(rt, projectDir, source(hash), built.resolved!)).toEqual([]);
  });
  it('fails closed after a changed bound ASR and leaves silent legacy video unaffected', async () => {
    const { dir, file, project } = await setup('changed');
    expect(await runCli(rt, ['video', 'replication', 'observe', dir, '--media', dir + '/' + file, '--transcript', dir + '/actual-asr.json'])).toMatchObject({ code: 0 });
    const observed = JSON.parse(await rt.fs.readText(dir + '/' + file + OBSERVED_SPEECH));
    await rt.fs.writeFile(dir + '/' + observed.transcript.file, '{}');
    expect((await probeFootage(rt, project, dir)).info.take).toHaveProperty('error');
    await rt.fs.rm(dir + '/replication.json'); await rt.fs.rm(dir + '/' + file + '.speech.json');
    const facts = (await probeFootage(rt, project, dir)).info.take;
    expect(facts).toMatchObject({ fps: 24, frames: 48, hasAudio: true }); expect(facts).not.toHaveProperty('speech');
  });
});
