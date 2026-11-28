/** Reference fidelity gates, separate from successful compilation, rendering and numeric similarity. */
import type { Problem } from '../types';
import { sourceRevision } from './revision';
import {
  effectiveTargetSpeech, explicitSpeechOverride, knownEvidence, parseReplicationReview,
  type ReplicationAudioUse, type ReplicationContract, type ReplicationEvidence,
  type ReplicationFinding, type ReplicationReview, type ReplicationSource,
} from './contract';

const problem = (at: string, message: string, level: Problem['level'] = 'error'): Problem => ({
  level, at: 'replication.' + at, message,
  fix: 'Preserve the reference requirement, or record the explicit user change and actual media evidence. Unknown is not a pass.',
});
const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const validSource = (s: ReplicationSource): boolean => /^[a-f0-9]{64}$/i.test(s.fingerprint) && Number.isFinite(s.fps) && s.fps > 0 && Number.isInteger(s.frames) && s.frames > 0;
const hasMedia = (e: ReplicationEvidence, media: readonly NonNullable<ReplicationEvidence['media']>[]): boolean =>
  e.kind !== 'unknown' && e.kind !== 'user' && !!e.file?.trim() && !!e.sha256 && !!e.media && media.includes(e.media);
const mediaEvidence = (e: readonly ReplicationEvidence[], media: readonly NonNullable<ReplicationEvidence['media']>[]): boolean => e.some(v => hasMedia(v, media));
const VISUAL = ['frame', 'video'] as const;
const AUDIBLE = ['audio', 'video'] as const;
const DYNAMIC = new Set(['typing', 'digit-reveal', 'mark', 'camera', 'transition', 'visibility', 'prop-causality', 'action', 'text-reveal']);

/** Caller probes and hashes the reference file itself, not its measurement JSON. */
export const checkReplicationSource = (contract: ReplicationContract, actual: ReplicationSource): Problem[] => {
  const out: Problem[] = [];
  if (!validSource(actual)) return [problem('source', 'Probe a real source with a file SHA-256, positive fps and positive integer frame count.')];
  if (!sameHash(contract.source.fingerprint, actual.fingerprint)) out.push(problem('source.fingerprint', 'The reference file SHA-256 differs from the bound source.'));
  // ffmpeg may print the declared average to two decimals for an edited/VFR source; this is not a new clock.
  if (Math.abs(contract.source.fps - actual.fps) > .005 + 1e-9 || contract.source.frames !== actual.frames)
    out.push(problem('source', 'Reference fps/frames differ from the probed source clock.'));
  return out;
};

/** Call before paid generation/fill for new strict sidecars; legacy projects are skipped by the caller. */
export const checkReplicationReadiness = (c: ReplicationContract): Problem[] => {
  const out: Problem[] = [];
  if (c.audio.sourceSpeech === 'unknown' || !mediaEvidence(c.audio.evidence, AUDIBLE))
    out.push(problem('audio.sourceSpeech', 'Reference speech is not confirmed; a failed or skipped transcription is not proof of silence.'));
  if (c.audio.targetSpeech === 'unknown') out.push(problem('audio.targetSpeech', 'Resolve an explicitly uncertain target speech intent before generation.'));
  if (c.audio.music && c.audio.music !== 'none' && !c.audio.musicEvidence?.some(e => e.kind === 'user'))
    out.push(problem('audio.musicEvidence', 'Separate music needs actual user approval evidence.'));
  if (c.audio.music === 'preserve' && !c.audio.sourceRoles.includes('music'))
    out.push(problem('audio.music', 'The source has no confirmed music role to preserve.'));
  if (c.audio.sourceRoles.includes('unknown') || (c.audio.sourceSpeech === 'present' && !c.audio.sourceRoles.some(r => r === 'dialogue' || r === 'narration' || r === 'music')) ||
      (c.audio.sourceSpeech === 'absent' && c.audio.sourceRoles.some(r => r === 'dialogue' || r === 'narration')))
    out.push(problem('audio.sourceRoles', 'Classify the actual source audio roles consistently with its observed speech presence.'));
  if (!c.visual.medium.trim() || c.visual.medium.toLowerCase() === 'unknown' || !c.visual.style.length || c.visual.style.some(s => s.toLowerCase() === 'unknown') || !mediaEvidence(c.visual.evidence, VISUAL))
    out.push(problem('visual', 'The reference medium/style has not been confirmed.'));
  if (c.inventory?.status !== 'complete' || !mediaEvidence(c.inventory.evidence, VISUAL))
    out.push(problem('inventory', 'Confirm the required-event inventory with actual reference frames/video, even when it is empty.'));
  for (const e of c.events) {
    const at = 'events.' + e.id;
    if (!knownEvidence(e.evidence) || !mediaEvidence(e.evidence, VISUAL)) out.push(problem(at + '.evidence', 'The required event needs actual reference-frame/video evidence.'));
    if (['typing', 'digit-reveal', 'text-reveal'].includes(e.kind) && !e.mechanism)
      out.push(problem(at + '.mechanism', 'Record whether the text appears by characters, words, at once or digit roll.'));
    if (e.kind === 'transition' && (!e.owner || e.owner === 'unknown')) out.push(problem(at + '.owner', 'Confirm which scene owns the complete transition.'));
    if (['visibility', 'prop-causality'].includes(e.kind) && !e.states) out.push(problem(at + '.states', 'Record the before/after states of the required reveal or physical interaction.'));
  }
  return out;
};

/** Check all audio entry routes. Merely choosing English, having TTS, or importing a WAV is not narration permission. */
export const checkReplicationAudio = (c: ReplicationContract, uses: readonly ReplicationAudioUse[], options: { complete?: boolean } = {}): Problem[] => {
  const out: Problem[] = [];
  const override = explicitSpeechOverride(c.audio.userOverride);
  const targetSpeech = effectiveTargetSpeech(c);
  if (c.audio.targetSpeech === 'unknown') out.push(problem('audio.targetSpeech', 'The target speech intent is unresolved.', 'warning'));
  const isNarrator = (u: ReplicationAudioUse): boolean => u.role === 'narration' || u.kind === 'speak' && u.role !== 'dialogue';
  const spokenUse = (u: ReplicationAudioUse): boolean => u.kind === 'speak' || u.role === 'narration' || u.role === 'dialogue' || u.speech === 'present';
  const preserved = c.audio.sourceRoles.filter(r => r !== 'unknown' && (r !== 'music' || c.audio.music === 'preserve'));
  if (options.complete && preserved.length && !uses.length && !override)
    out.push(problem('audioUses', 'The final inventory drops all audible source roles without an explicit user audio-change instruction.'));
  if (options.complete && c.audio.music === 'preserve' && !uses.some(u => u.role === 'music'))
    out.push(problem('audioUses', 'The explicitly preserved source music is missing.'));
  if (options.complete && targetSpeech === 'present' && !uses.some(spokenUse)) out.push(problem('audioUses', 'Required or preserved speech is missing from the output audio inventory.'));
  if (options.complete && c.audio.narration === 'requested' && !uses.some(isNarrator)) out.push(problem('audioUses', 'The explicitly requested narration is missing.'));
  const narrationAllowed = c.audio.narration === 'requested' && override ||
    c.audio.narration === 'preserve' && c.audio.sourceSpeech === 'present' && c.audio.sourceRoles.includes('narration');
  uses.forEach((u, i) => {
    const at = 'audioUses[' + i + ']';
    const narrator = isNarrator(u);
    const spoken = narrator || u.role === 'dialogue' || u.speech === 'present';
    if (u.role === 'music' && u.kind !== 'native' && (c.audio.music ?? 'none') === 'none')
      out.push(problem(at, 'No separate soundtrack was requested; native clip sound remains allowed.'));
    if (spoken && targetSpeech === 'absent' && !(override && c.audio.targetSpeech === undefined)) out.push(problem(at, 'Output speech is forbidden by the target speech intent.'));
    if (narrator && !narrationAllowed) out.push(problem(at, 'New narration is not permitted by the reference/user speech intent.'));
    else if (spoken && c.audio.sourceSpeech !== 'present' && !override)
      out.push(problem(at, 'This native or external audio adds speech without an explicit user request.'));
    if (u.role === 'dialogue' && !c.audio.sourceRoles.includes('dialogue') && !override)
      out.push(problem(at + '.role', 'Sung words or a source narrator do not authorize adding a dialogue performance.'));
    if (u.role === 'unknown' || u.speech === 'unknown')
      out.push(problem(at, 'Classify imported/native audio as dialogue, narration, music, effects or ambience; unknown audio is not cleared.', 'warning'));
    if ((narrator || u.kind === 'speak' || u.role === 'dialogue') && u.speech === 'absent') out.push(problem(at + '.speech', 'An active speech route cannot be declared speech-absent.'));
  });
  return out;
};

export interface ReplicationAssessment {
  artifactReady: boolean;
  requirementsMet: boolean | null;
  qualityStatus: 'not_rendered' | 'needs_review' | 'needs_iteration' | 'accepted' | 'failed';
  problems: Problem[];
}

/** Different actual frame files, or explicitly sampled different frames of a video, are temporal evidence. */
const frameKeys = (evidence: readonly ReplicationEvidence[]): Set<string> => new Set(evidence.flatMap(e => {
  if (!hasMedia(e, VISUAL)) return [];
  if (e.media === 'frame') return [e.sha256!.toLowerCase()];
  return e.frame === undefined ? [] : [e.sha256!.toLowerCase() + ':' + e.frame];
}));

/** No numeric similarity score can turn missing/failed requirements into acceptance. */
export const assessReplication = (c: ReplicationContract, input: unknown, actualArtifact?: ReplicationSource): ReplicationAssessment => {
  const parsed = parseReplicationReview(input);
  if (!parsed.review) return { artifactReady: false, requirementsMet: null, qualityStatus: 'needs_review', problems: parsed.problems };
  const r = parsed.review;
  const artifactReady = r.production === 'rendered';
  const out: Problem[] = [];
  let failed = r.production === 'failed', unknown = false;
  const fail = (at: string, message: string) => { failed = true; out.push(problem(at, message)); };
  const pending = (at: string, message: string) => { unknown = true; out.push(problem(at, message, 'warning')); };
  const readiness = checkReplicationReadiness(c);
  if (readiness.length) { unknown = true; out.push(...readiness); }
  if (!sameHash(r.sourceFingerprint, c.source.fingerprint)) fail('review.sourceFingerprint', 'Review belongs to a different reference file.');
  if (!r.sourceRevision) pending('review.sourceRevision', 'Bind this review to the current reference-reading revision.');
  else if (!sameHash(r.sourceRevision, sourceRevision(c))) fail('review.sourceRevision', 'The source requirements changed after this review; inspect the current source reading again.');
  if (!artifactReady) pending('review.production', 'A planned/generated clip or failed request is not a rendered final artifact.');
  if (!r.artifactFingerprint || !r.target || !actualArtifact) pending('review.artifactFingerprint', 'Bind the review to the actual final file SHA-256 and probed target fps/frames.');
  else if (!validSource(actualArtifact)) fail('review.target', 'The actual artifact must have a real SHA-256, positive fps and positive integer frame count.');
  else {
    if (!sameHash(r.artifactFingerprint, actualArtifact.fingerprint)) fail('review.artifactFingerprint', 'The final artifact changed after this review.');
    if (r.target.frames !== actualArtifact.frames || Math.abs(r.target.fps - actualArtifact.fps) > 1e-6)
      fail('review.target', 'The reviewed target clock differs from the final artifact.');
    const span = c.scope?.span ?? [0, c.source.frames];
    const expected = (span[1] - span[0]) / c.source.fps;
    const duration = actualArtifact.frames / actualArtifact.fps;
    const tolerance = Math.max(1 / c.source.fps, 1 / actualArtifact.fps) + 1e-6;
    if (Math.abs(duration - expected) > tolerance) fail('review.target', 'Final duration does not match the retained reference interval; equal frame counts are not enough.');
  }
  const inspect = (name: string, f: ReplicationFinding | undefined, media: readonly NonNullable<ReplicationEvidence['media']>[]) => {
    if (f?.status === 'failed') { fail(name, 'A required fidelity check failed.'); return; }
    if (f?.status !== 'passed') { pending(name, 'This required check is not passed.'); return; }
    if (!mediaEvidence(f.evidence, media)) pending(name + '.evidence', 'Passed checks need actual hashed frame/audio/video evidence, not only a textual assertion.');
  };
  inspect('review.audio', r.audio, AUDIBLE);
  inspect('review.visual', r.visual, VISUAL);
  if (r.audioUses === undefined) pending('review.audioUses', 'Inventory every output audio route, including imported sound and native clip audio.');
  else {
    const audio = checkReplicationAudio(c, r.audioUses, { complete: true });
    out.push(...audio);
    if (audio.some(p => p.level === 'error')) failed = true;
    if (audio.some(p => p.level === 'warning')) unknown = true;
  }
  const seen = new Set<string>();
  const entries = new Map<string, NonNullable<ReplicationReview['events']>[number]>();
  for (const e of r.events ?? []) {
    if (seen.has(e.id)) fail('review.events.' + e.id, 'An event was reviewed more than once.');
    if (!c.events.some(required => required.id === e.id)) fail('review.events.' + e.id, 'A review names an event outside this contract.');
    seen.add(e.id); entries.set(e.id, e);
  }
  for (const e of c.events) {
    const item = entries.get(e.id), at = 'review.events.' + e.id;
    inspect(at, item, VISUAL);
    if (item?.status === 'passed' && DYNAMIC.has(e.kind) && frameKeys(item.evidence).size < 2)
      pending(at + '.evidence', 'A dynamic event requires at least two different actual frames; one hero image cannot prove motion.');
  }
  return {
    artifactReady, requirementsMet: failed ? false : unknown || !artifactReady ? null : true,
    qualityStatus: r.production === 'failed' ? 'failed' : !artifactReady ? 'not_rendered' : failed ? 'needs_iteration' : unknown ? 'needs_review' : 'accepted',
    problems: out,
  };
};
