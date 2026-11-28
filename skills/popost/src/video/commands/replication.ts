/** Reference fidelity commands are local and free. Measurements are not aesthetic acceptance. */
import type { Runtime } from '../../runtime';
import { printJson, sha256File } from '../../core/util';
import { probe } from '../media/ffmpeg';
import { buildPage } from '../compile/index';
import { REPLICATION_FILE, REPLICATION_FORMAT, parseReplicationReview, type ReplicationContract, type ReplicationEvidence } from '../replication/contract';
import { assessReplication, checkReplicationReadiness, checkReplicationSource } from '../replication/check';
import { readReplication, evidenceProblems } from '../replication/io';
import { artifactFacts, outputAudioProblems, outputPlanProblems } from '../replication/production';
import { checkPairs, PAIRS_FILE, type PairUse } from '../replication/pairs';
import { MOTION_BUNDLE } from '../replication/motion-bundle';
import { preserveReferenceSound } from '../replication/audio-provenance';
import { sourceRevision } from '../replication/revision';
import { observeNativeSpeech } from '../replication/speech-observed';
import { inspectSourceClock } from '../replication/source-clock';
import type { Problem, Resolved } from '../types';
import { error } from '../project/check-common';
import { command, userPath, VideoCommandError, type Commands } from './shared';

const DIR = { name: 'dir', help: 'reference, template or project directory' } as const;
const writeJson = (rt: Runtime, file: string, data: unknown) => rt.fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
const report = (rt: Runtime, problems: Problem[], more: object = {}) => {
  const errors = problems.filter(p => p.level === 'error').length;
  printJson(rt, { ok: errors === 0, ...more, errors, problems });
  return errors ? 2 : 0;
};
const init = command('bind a reference SHA-256 and its own frame clock; write an internal draft to complete by watching and listening', {
  positionals: [DIR], options: [{ flag: '--reference', required: true, help: 'the actual source video file' }],
}, async (args, rt) => {
  const dir = userPath(rt, args.req('dir')), file = rt.path.join(dir, REPLICATION_FILE);
  if (await rt.fs.stat(file)) throw new VideoCommandError('Keep the existing contract. Edit observed facts with new evidence instead of overwriting the source inventory.');
  const source = userPath(rt, args.req('reference')), measured = await probe(rt, source), fingerprint = await sha256File(rt, source);
  const relative = 'replication-evidence/source-' + fingerprint + rt.path.extname(source);
  const target = rt.path.join(dir, relative);
  if (rt.fs.copyFile) { await rt.fs.mkdir(rt.path.dirname(target)); await rt.fs.copyFile(source, target); }
  else await rt.fs.writeFile(target, await rt.fs.readFile(source));
  const evidence: ReplicationEvidence = { kind: 'measured', detail: measured.hasAudio ? 'An audio stream exists; its speech and audible roles still need listening.' : 'The source has no audio stream.', file: relative, sha256: fingerprint, media: 'video' };
  const c: ReplicationContract = {
    format: REPLICATION_FORMAT, version: 1, source: { fingerprint, fps: measured.fps, frames: measured.frames },
    audio: { sourceSpeech: measured.hasAudio ? 'unknown' : 'absent', sourceRoles: [], narration: 'preserve', evidence: [evidence] },
    visual: { medium: 'unknown', style: [], evidence: [] }, inventory: { status: 'unknown', evidence: [] }, events: [],
  };
  await writeJson(rt, file, c);
  printJson(rt, { ok: true, file, source: c.source, ready: false, next: 'Watch the reference and complete its audio, visual and temporal-event inventory, then run video replication check.' });
});

const helpers = command('write the shipped deterministic typing, digit-roll, viewport and motion helpers into a project', {
  options: [{ flag: '--out', required: true, help: 'local JavaScript file; include it in scenes as window.popostMotion' }],
}, async (args, rt) => {
  const file = userPath(rt, args.req('out')); await rt.fs.writeFile(file, MOTION_BUNDLE);
  printJson(rt, { ok: true, file, sha256: await sha256File(rt, file), global: 'window.popostMotion' });
});

const clock = command('map actual decoded reference-frame indices through presentation timestamps into the contract clock; necessary for VFR or held-tail sources', {
  positionals: [DIR], options: [
    { flag: '--reference', required: true, help: 'actual bound original video' },
    { flag: '--out', required: true, help: 'JSON mapping of decoded index, actual PTS seconds and normalized contract frame' },
  ],
}, async (args, rt) => {
  const dir = userPath(rt, args.req('dir')), read = await readReplication(rt, dir);
  if (!read.contract || read.problems.some(p => p.level === 'error')) return report(rt, read.problems.length ? read.problems : [error(REPLICATION_FILE, 'No valid bound source contract.', 'Initialize and inspect the source first.')]);
  const data = await inspectSourceClock(rt, userPath(rt, args.req('reference')), read.contract.source);
  const out = userPath(rt, args.req('out')); await writeJson(rt, out, data);
  printJson(rt, { ok: true, file: out, frames: data.frames.length, contractFPS: data.contractFPS, nonUniform: data.nonUniform, method: data.method });
});

const sound = command('preserve explicitly approved music/effects from the bound reference as a verified lossless soundtrack; never copy source narration/dialogue', {
  positionals: [DIR], options: [
    { flag: '--reference', required: true, help: 'actual bound original video' },
    { flag: '--out', required: true, help: 'lossless WAV inside the project' },
    { flag: '--given', required: true, help: 'actual user approval for preserving the reference soundtrack' },
  ],
}, async (args, rt) => {
  try {
    const receipt = await preserveReferenceSound(rt, { dir: userPath(rt, args.req('dir')), reference: userPath(rt, args.req('reference')), out: userPath(rt, args.req('out')), given: args.req('given') });
    printJson(rt, { ok: true, file: args.req('out'), source: 'reference', receipt });
  } catch (e) { throw new VideoCommandError(e instanceof Error ? e.message : String(e)); }
});

const timeline = command('show actual compiled target frames, scene offsets, source footage clocks and word times after all retiming', {
  positionals: [DIR], options: [{ flag: '--out', help: 'optional JSON file for the implementation map' }],
}, async (args, rt) => {
  const built = await buildPage(rt, userPath(rt, args.req('dir')));
  if (!built.resolved) return report(rt, built.problems);
  const r = built.resolved;
  const data = { canvas: r.canvas, frames: r.frames, segments: r.segments, items: r.items, audio: r.audio, speech: r.speech, footage: r.footage, words: r.words ?? [] };
  if (args.string('out')) await writeJson(rt, userPath(rt, args.req('out')), data);
  return report(rt, built.problems, { timeline: data });
});

const observe = command('import actual native-clip ASR and optional inspected words/articulation evidence, independently of requested line slots', {
  positionals: [DIR], options: [
    { flag: '--media', required: true, help: 'actual native video inside the project' },
    { flag: '--transcript', required: true, help: 'real video transcript JSON; its FPS is the ASR clock' },
    { flag: '--review', help: 'words/articulation review JSON with actual media/hash/frame/audio evidence' },
  ],
}, async (args, rt) => {
  try {
    const observation = await observeNativeSpeech(rt, { dir: userPath(rt, args.req('dir')), media: userPath(rt, args.req('media')), transcript: userPath(rt, args.req('transcript')), ...(args.string('review') ? { review: userPath(rt, args.req('review')) } : {}) });
    printJson(rt, { ok: true, observation, next: 'Rebuild the timeline to use actual source speech seconds; inspect audible words and visible articulation before strict final acceptance.' });
  } catch (e) { throw new VideoCommandError(e instanceof Error ? e.message : String(e)); }
});

/** Native base/items are mapped using each file's source rate, never the target rate. */
const pairUses = (r: Resolved, pairs: Awaited<ReturnType<typeof checkPairs>>['pairs']): PairUse[] => {
  const plays = [...r.segments.flatMap(s => s.base.kind === 'video' ? [{ play: s.base.play, end: s.end }] : []),
    ...r.items.flatMap(i => i.play ? [{ play: i.play, end: i.end }] : [])];
  return plays.flatMap(({ play, end }) => {
    const f = r.footage?.[play.material]; if (!f) return [];
    return pairs.flatMap(p => (['reference', 'remake'] as const).flatMap(side => p[side].file === f.src ? [{
      pairId: p.id, side, file: f.src, sourceFps: f.fps,
      trim: { in: play.in / f.fps, out: play.in / f.fps + (end - play.start) / r.canvas.fps * play.speed, unit: 'seconds' as const },
    }] : []));
  });
};
const boundFindings = (c: ReplicationContract, review: NonNullable<ReturnType<typeof parseReplicationReview>['review']>, actual: { fingerprint: string; fps: number; frames: number }): Problem[] => {
  const fingerprint = actual.fingerprint;
  const problems: Problem[] = [];
  for (const [name, finding] of [['audio', review.audio], ['visual', review.visual], ...(review.events ?? []).map(e => [e.id, e] as const)] as const) {
    if (finding?.status !== 'passed') continue;
    for (const e of finding.evidence.filter(e => e.sha256 === fingerprint)) {
      if (e.frame !== undefined && (e.frame < 0 || e.frame >= actual.frames) || e.at && (e.at[0] < 0 || e.at[1] > actual.frames / actual.fps))
        problems.push(error('replication.review.' + name, 'Evidence refers to frames or audio outside the actual final file.', 'Inspect a real in-range sample of this exact artifact.'));
    }
    if (!finding.evidence.some(e => e.kind !== 'unknown' && e.media === 'video' && e.sha256 === fingerprint && (name === 'audio' || e.frame !== undefined)))
      problems.push(error('replication.review.' + name, 'A passed finding is not bound to an inspected frame/audio of the exact final video.', 'Include the final video SHA-256 and actual sampled frame indices, after the last repair.'));
  }
  for (const event of c.events) {
    const item = review.events?.find(e => e.id === event.id);
    if (item?.status === 'passed' && event.kind !== 'comparison' && new Set(item.evidence.filter(e => e.sha256 === fingerprint && e.media === 'video' && e.frame !== undefined).map(e => e.frame)).size < 2)
      problems.push(error('replication.review.' + event.id, 'The motion verdict needs two distinct inspected frames of this exact final file.', 'Review the lead-in, active move and resolved state; do not reuse a source frame or a hero image as motion evidence.'));
  }
  return problems;
};

const check = command('check source readiness, or an exact final artifact and its implementation, audio and event review', {
  positionals: [DIR], options: [
    { flag: '--reference', help: 're-probe and bind-check the actual original reference' },
    { flag: '--artifact', help: 'the final rendered MP4; requires the project and final review' },
    { flag: '--review', help: 'review JSON (default replication.review.json in the project)' },
  ],
}, async (args, rt) => {
  const dir = userPath(rt, args.req('dir')), read = await readReplication(rt, dir);
  const problems = [...read.problems];
  if (!read.contract) return report(rt, [...problems, error(REPLICATION_FILE, 'There is no valid reference contract.', 'Run replication init and record the actual reference analysis.')]);
  const c = read.contract;
  problems.push(...checkReplicationReadiness(c));
  if (args.string('reference')) {
    const file = userPath(rt, args.req('reference'));
    problems.push(...checkReplicationSource(c, await artifactFacts(rt, file, await probe(rt, file))));
  }
  if (!args.string('artifact')) return report(rt, problems, { ready: !problems.some(p => p.level === 'error'), source: c.source, sourceRevision: sourceRevision(c) });
  const artifact = userPath(rt, args.req('artifact')), actual = await artifactFacts(rt, artifact, await probe(rt, artifact));
  const built = await buildPage(rt, dir); problems.push(...built.problems);
  if (built.resolved) {
    problems.push(...await outputPlanProblems(rt, dir, c, built.resolved), ...await outputAudioProblems(rt, dir, c, built.resolved));
    if (c.events.some(e => e.kind === 'comparison')) {
      try {
        const value: unknown = JSON.parse(await rt.fs.readText(rt.path.join(dir, PAIRS_FILE)));
        const first = await checkPairs(rt, dir, value), uses = pairUses(built.resolved, first.pairs);
        const pairs = await checkPairs(rt, dir, value, { uses }); problems.push(...pairs.problems);
        for (const pair of pairs.pairs) if (!uses.some(u => u.pairId === pair.id && u.side === 'reference') || !uses.some(u => u.pairId === pair.id && u.side === 'remake'))
          problems.push(error(PAIRS_FILE, 'A declared comparison is missing one of its actual timeline sides: ' + pair.id, 'Place the verified sides at matching stages using their own source FPS.'));
        if (pairs.status !== 'verified') problems.push(error(PAIRS_FILE, 'The actual comparison pairing is not verified.', 'Resolve source identity, relationship, trim and source-clock evidence.'));
      } catch (e) { problems.push(error(PAIRS_FILE, String(e), 'Keep a verified actual source-pair manifest with comparison scenes.')); }
    }
  }
  let input: unknown;
  try { input = JSON.parse(await rt.fs.readText(userPath(rt, args.string('review') ?? rt.path.join(dir, 'replication.review.json')))); }
  catch (e) { problems.push(error('replication.review', String(e), 'Review the final file and bind the findings to its exact bytes.')); }
  const parsed = parseReplicationReview(input);
  problems.push(...parsed.problems, ...await evidenceProblems(rt, dir, parsed.review));
  if (parsed.review) problems.push(...boundFindings(c, parsed.review, actual));
  const assessment = assessReplication(c, input, actual); problems.push(...assessment.problems);
  const failed = problems.some(p => p.level === 'error'), accepted = !failed && assessment.requirementsMet === true;
  const result = { ...assessment, requirementsMet: failed ? false : assessment.requirementsMet, qualityStatus: accepted ? 'accepted' : failed ? 'needs_iteration' : assessment.qualityStatus, artifact: actual, problems };
  await writeJson(rt, rt.path.join(dir, 'replication.quality.json'), result);
  printJson(rt, { ok: accepted, ...result });
  return accepted ? 0 : 2;
});

export const replicationCommands: Commands = { init, check, helpers, timeline, sound, observe, clock };
