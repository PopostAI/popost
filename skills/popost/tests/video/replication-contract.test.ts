import { describe, expect, it } from 'vitest';
import {
  effectiveTargetSpeech, parseReplicationContract, parseReplicationReview, REPLICATION_FORMAT,
  type ReplicationContract, type ReplicationEvidence, type ReplicationReview,
} from '../../src/video/replication/contract';
import { assessReplication, checkReplicationAudio, checkReplicationReadiness, checkReplicationSource } from '../../src/video/replication/check';
import { sourceRevision } from '../../src/video/replication/revision';

const sha = (letter: string) => letter.repeat(64);
const reference = sha('a'), artifact = sha('b');
const evidence = (file: string, hash: string, media: ReplicationEvidence['media'] = 'frame'): ReplicationEvidence => ({
  kind: 'observed', detail: 'Inspected the actual media at the event boundary.', file, sha256: hash, media,
});
const sourceEvidence = () => evidence('reference.mp4', reference, 'video');
const before = () => evidence('evidence/start.png', sha('c'));
const after = () => evidence('evidence/end.png', sha('d'));
const target = () => ({ fingerprint: artifact, fps: 30, frames: 300 });
const contract = (): ReplicationContract => ({
  format: REPLICATION_FORMAT, version: 1, source: { fingerprint: reference, fps: 24, frames: 240 },
  audio: { sourceSpeech: 'absent', sourceRoles: ['music'], narration: 'preserve', music: 'preserve', musicEvidence: [{ kind: 'user', detail: 'Preserve the original soundtrack.' }], evidence: [sourceEvidence()] },
  visual: { medium: 'hand-drawn', style: ['Paper texture and pencil outlines'], evidence: [sourceEvidence()] },
  inventory: { status: 'complete', evidence: [sourceEvidence()] },
  events: [{ id: 'heading', kind: 'typing', mechanism: 'characters', objects: ['heading'], description: 'Letters appear individually.', span: [24, 48], evidence: [sourceEvidence()] }],
});
const review = (c: ReplicationContract = contract()): ReplicationReview => ({
  production: 'rendered', sourceFingerprint: reference, sourceRevision: sourceRevision(c), artifactFingerprint: artifact, target: { fps: 30, frames: 300 },
  audio: { status: 'passed', evidence: [evidence('evidence/final.wav', sha('e'), 'audio')] },
  visual: { status: 'passed', evidence: [before()] },
  events: [{ id: 'heading', status: 'passed', evidence: [before(), after()] }],
  audioUses: [{ kind: 'sound', role: 'music', speech: 'absent' }],
});
const userOverride = () => ({ instruction: 'Add a narrated explanation.', evidence: [{ kind: 'user' as const, detail: 'The user explicitly asked for a voice-over.' }] });

describe('versioned replication sidecar', () => {
  it('invalidates an old review when source events change, while portable paths and target-only choices retain the reading', () => {
    const c = contract(), r = review(c), original = sourceRevision(c);
    const copied = JSON.parse(JSON.stringify(c)) as ReplicationContract;
    copied.visual.evidence[0]!.file = 'portable/source.mp4';
    copied.audio.music = 'none';
    expect(sourceRevision(copied)).toBe(original);
    c.events[0]!.span = [25, 49];
    expect(sourceRevision(c)).not.toBe(original);
    expect(assessReplication(c, r, target()).requirementsMet).toBe(false);
  });
  it('parses a portable media-bound contract and a review', () => {
    expect(parseReplicationContract(contract()).problems).toEqual([]);
    expect(parseReplicationReview(review()).problems).toEqual([]);
  });
  it('rejects unsupported versions, measurement hashes, invalid clocks and unknown fields', () => {
    expect(parseReplicationContract({ ...contract(), version: 2 }).contract).toBeUndefined();
    expect(parseReplicationContract({ ...contract(), source: { fingerprint: 'sha256:measurement', fps: 24, frames: 240 } }).contract).toBeUndefined();
    for (const source of [{ fingerprint: reference, fps: 0, frames: 240 }, { fingerprint: reference, fps: NaN, frames: 240 }, { fingerprint: reference, fps: 24, frames: 0 }])
      expect(parseReplicationContract({ ...contract(), source }).contract).toBeUndefined();
    expect(parseReplicationContract({ ...contract(), requiremntsMet: true }).contract).toBeUndefined();
  });
  it('keeps uncertain drafts representable but not ready for paid work', () => {
    const c = contract(); c.audio.sourceSpeech = 'unknown'; c.visual.medium = 'unknown'; c.inventory = { status: 'unknown', evidence: [] }; c.events = [];
    expect(parseReplicationContract(c).contract).toBeDefined();
    expect(checkReplicationReadiness(c).length).toBeGreaterThan(0);
    expect(assessReplication(c, { ...review(c), events: [] }, target()).requirementsMet).toBeNull();
  });
  it('requires event ids and retained source-frame intervals to be unambiguous', () => {
    const c = contract(); c.events.push({ ...c.events[0]! });
    expect(parseReplicationContract(c).contract).toBeUndefined();
    c.events = [{ ...c.events[0]!, span: [230, 250] }];
    expect(parseReplicationContract(c).contract).toBeUndefined();
    c.events = [{ ...c.events[0]!, span: [24, 24] }];
    expect(parseReplicationContract(c).contract).toBeUndefined();
  });
  it('permits a genuine zero-event inventory only after an actual source review', () => {
    const c = contract(); c.events = [];
    expect(assessReplication(c, { ...review(c), events: [] }, target()).qualityStatus).toBe('accepted');
    delete c.inventory;
    expect(assessReplication(c, { ...review(c), events: [] }, target()).qualityStatus).toBe('needs_review');
  });
  it('checks unresolved mechanisms, causality states and transition ownership', () => {
    const c = contract(); delete c.events[0]!.mechanism;
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.mechanism'))).toBe(true);
    c.events = [{ id: 'wipe', kind: 'transition', objects: ['panel'], span: [24, 48], description: 'The prior scene carries the cover.', owner: 'unknown', evidence: [sourceEvidence()] }];
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.owner'))).toBe(true);
    c.events[0]!.owner = 'before';
    expect(checkReplicationReadiness(c)).toEqual([]);
    c.events[0]!.kind = 'prop-causality';
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.states'))).toBe(true);
  });
  it('requires media-backed speech/style facts and a consistent source audio role inventory', () => {
    const c = contract(); c.audio.evidence = [{ kind: 'observed', detail: 'I assume no speech.' }];
    c.visual.evidence = [{ kind: 'observed', detail: 'I assume a drawn medium.' }];
    expect(checkReplicationReadiness(c).map(p => p.at)).toEqual(expect.arrayContaining(['replication.audio.sourceSpeech', 'replication.visual']));
    c.audio.evidence = [sourceEvidence()]; c.visual.evidence = [sourceEvidence()];
    c.audio.sourceRoles = ['unknown'];
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.sourceRoles'))).toBe(true);
    c.audio.sourceRoles = ['dialogue'];
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.sourceRoles'))).toBe(true);
    c.audio.sourceSpeech = 'present'; c.audio.music = 'none';
    expect(checkReplicationReadiness(c)).toEqual([]);
    c.audio.targetSpeech = 'unknown';
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('.targetSpeech'))).toBe(true);
  });
});

describe('speech intent across all audio routes', () => {
  it('preserves instrumental audio and does not equate no speech with no sound', () => {
    expect(checkReplicationAudio(contract(), [{ kind: 'sound', role: 'music', speech: 'absent' }, { kind: 'native', role: 'effects', speech: 'absent' }])).toEqual([]);
    expect(checkReplicationAudio(contract(), [])).toEqual([]);
    expect(checkReplicationAudio(contract(), [], { complete: true }).some(p => p.level === 'error')).toBe(true);
    expect(assessReplication(contract(), { ...review(), audioUses: [] }, target()).requirementsMet).toBe(false);
    const c = contract(); c.audio.music = 'none'; c.audio.userOverride = { instruction: 'Remove the music and make the video silent.', evidence: [{ kind: 'user', detail: 'The user explicitly requested no audio.' }] };
    expect(checkReplicationAudio(c, [], { complete: true })).toEqual([]);
  });
  it('preserves vocal music without treating its sung words as permission for narration', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['music']; c.audio.narration = 'forbid';
    c.audio.evidence = [{ ...sourceEvidence(), detail: 'Listened to intelligible sung words over the music; no lecture or spoken narrator.' }];
    expect(checkReplicationReadiness(c)).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'music', speech: 'present' }], { complete: true })).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'narration', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
    c.audio.narration = 'preserve';
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
  });
  it.each(['speak', 'sound', 'native', 'bed'] as const)('blocks unauthorized narration through %s', kind => {
    expect(checkReplicationAudio(contract(), [{ kind, role: 'narration', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
  });
  it('also catches speech in a sound file labelled as music', () => {
    expect(checkReplicationAudio(contract(), [{ kind: 'sound', role: 'music', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
  });
  it('does not turn a language preference or an unknown role into voice permission', () => {
    const c = contract(); c.audio.evidence.push({ kind: 'user', detail: 'Use English for any words.' });
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'present' }])[0]?.level).toBe('error');
    c.audio.music = 'none'; const r = review(c); r.audioUses = [{ kind: 'sound', role: 'unknown', speech: 'unknown' }];
    expect(assessReplication(c, r, target()).requirementsMet).toBeNull();
  });
  it('requires an explicit user instruction for requested new narration', () => {
    const c = contract(); c.audio.narration = 'requested';
    expect(parseReplicationContract(c).contract).toBeUndefined();
    c.audio.userOverride = userOverride();
    expect(parseReplicationContract(c).contract).toBeDefined();
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'present' }])).toEqual([]);
    c.audio.narration = 'forbid';
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'narration', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
  });
  it('preserves source dialogue without automatically adding a separate narrator', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['dialogue', 'music'];
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }])).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'dialogue', speech: 'present' }])).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'dialogue', speech: 'absent' }]).some(p => p.level === 'error')).toBe(true);
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'present' }]).length).toBeGreaterThan(0);
    c.audio.sourceRoles.push('narration');
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'present' }])).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'narration', speech: 'unknown' }]).some(p => p.level === 'warning')).toBe(true);
  });
  it('preserves an on-screen narrated monologue without reclassifying a song as dialogue', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['narration'];
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'narration', speech: 'present' }])).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
    c.audio.userOverride = { instruction: 'Change the monologue into a conversation.', evidence: [{ kind: 'user', detail: 'The user explicitly requested a dialogue performance.' }] };
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }])).toEqual([]);
  });
  it('allows partial silent B-roll plans but catches missing preserved speech in a final inventory', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['dialogue'];
    const silent = [{ kind: 'native' as const, role: 'ambient' as const, speech: 'absent' as const }];
    expect(checkReplicationAudio(c, silent)).toEqual([]);
    expect(checkReplicationAudio(c, silent, { complete: true }).some(p => p.level === 'error')).toBe(true);
    expect(assessReplication(c, { ...review(c), audioUses: silent }, target()).requirementsMet).toBe(false);
    c.audio.narration = 'requested'; c.audio.userOverride = userOverride();
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }], { complete: true }).some(p => p.level === 'error')).toBe(true);
    expect(checkReplicationAudio(c, [{ kind: 'speak', role: 'dialogue', speech: 'present' }], { complete: true }).some(p => p.level === 'error')).toBe(true);
  });
  it('records an explicit speech-presence change without falsifying the source facts', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['dialogue']; c.audio.music = 'none'; c.audio.targetSpeech = 'absent';
    expect(parseReplicationContract(c).contract).toBeUndefined();
    c.audio.userOverride = { instruction: 'Remove all dialogue.', evidence: [{ kind: 'user', detail: 'The user requested silence instead of the original dialogue.' }] };
    expect(parseReplicationContract(c).contract).toBeDefined();
    expect(checkReplicationAudio(c, [], { complete: true })).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
    c.audio.narration = 'requested';
    expect(parseReplicationContract(c).contract).toBeUndefined();
  });
});

describe('artifact completion and fidelity are separate', () => {
  it('accepts changed fps when source and final durations agree', () => {
    const r = assessReplication(contract(), review(), target());
    expect(r).toMatchObject({ artifactReady: true, requirementsMet: true, qualityStatus: 'accepted', problems: [] });
  });
  it('binds source, reviewed artifact and actual probed clock', () => {
    expect(checkReplicationSource(contract(), contract().source)).toEqual([]);
    expect(checkReplicationSource(contract(), { ...contract().source, fingerprint: sha('f') }).length).toBeGreaterThan(0);
    expect(assessReplication(contract(), { ...review(), sourceFingerprint: sha('f') }, target()).requirementsMet).toBe(false);
    expect(assessReplication(contract(), review(), { ...target(), fingerprint: sha('f') }).requirementsMet).toBe(false);
    expect(assessReplication(contract(), review()).requirementsMet).toBeNull();
    expect(assessReplication(contract(), { ...review(), target: { fps: 24, frames: 240 } }, target()).requirementsMet).toBe(false);
    expect(checkReplicationSource(contract(), { ...contract().source, fps: NaN }).length).toBeGreaterThan(0);
    expect(assessReplication(contract(), review(), { ...target(), fps: NaN }).requirementsMet).toBe(false);
  });
  it('allows rounded source-rate metadata while rejecting a different nominal source clock', () => {
    const c = contract(); c.source.fps = 58.287963;
    expect(checkReplicationSource(c, { ...c.source, fps: 58.29 })).toEqual([]);
    expect(checkReplicationSource(c, { ...c.source, fps: 60 }).some(p => p.level === 'error')).toBe(true);
  });
  it('does not compare bare frame counts or omit a tail without scope', () => {
    const r = review(); r.target = { fps: 30, frames: 240 };
    expect(assessReplication(contract(), r, { ...target(), frames: 240 }).requirementsMet).toBe(false);
    const c = contract(); c.scope = { span: [0, 192], reason: 'Retain only the explicitly selected interval.', evidence: [sourceEvidence()] };
    r.sourceRevision = sourceRevision(c);
    expect(assessReplication(c, r, { ...target(), frames: 240 }).requirementsMet).toBe(true);
    c.scope.evidence = [{ kind: 'unknown', detail: 'The original ending was not reviewed.' }];
    expect(parseReplicationContract(c).contract).toBeUndefined();
  });
  it('does not promote planned, failed or partially reviewed work', () => {
    expect(assessReplication(contract(), { ...review(), production: 'planned' }, target())).toMatchObject({ artifactReady: false, requirementsMet: null, qualityStatus: 'not_rendered' });
    expect(assessReplication(contract(), { ...review(), production: 'failed' }, target())).toMatchObject({ artifactReady: false, requirementsMet: false, qualityStatus: 'failed' });
    const r = review(); r.events = [];
    expect(assessReplication(contract(), r, target()).qualityStatus).toBe('needs_review');
    r.events = [{ id: 'heading', status: 'failed', evidence: [before(), after()] }];
    expect(assessReplication(contract(), r, target()).qualityStatus).toBe('needs_iteration');
  });
  it('requires actual evidence instead of text-only or unknown pass declarations', () => {
    const r = review(); r.audio = { status: 'passed', evidence: [{ kind: 'observed', detail: 'pass' }] };
    expect(assessReplication(contract(), r, target()).requirementsMet).toBeNull();
    r.audio = review().audio; r.visual = { status: 'passed', evidence: [{ ...before(), kind: 'unknown' }] };
    expect(assessReplication(contract(), r, target()).requirementsMet).toBeNull();
    r.visual = review().visual; delete r.audioUses;
    expect(assessReplication(contract(), r, target()).requirementsMet).toBeNull();
  });
  it('requires distinct temporal evidence and rejects re-labelled duplicate hero frames', () => {
    const r = review(); r.events![0]!.evidence = [before(), { ...before(), frame: 10 }];
    expect(assessReplication(contract(), r, target()).requirementsMet).toBeNull();
    r.events![0]!.evidence = [{ ...evidence('final.mp4', artifact, 'video'), frame: 30 }, { ...evidence('final.mp4', artifact, 'video'), frame: 45 }];
    expect(assessReplication(contract(), r, target()).requirementsMet).toBe(true);
    r.events![0]!.evidence = [{ ...evidence('final.mp4', artifact, 'video'), at: [1, 2] }];
    expect(assessReplication(contract(), r, target()).requirementsMet).toBeNull();
  });
  it('rejects unknown/duplicate event reviews and ignores numeric score shortcuts', () => {
    const r = review(); r.events!.push({ ...r.events![0]! });
    expect(assessReplication(contract(), r, target()).requirementsMet).toBe(false);
    r.events = [{ id: 'different', status: 'passed', evidence: [before(), after()] }];
    expect(assessReplication(contract(), r, target()).requirementsMet).toBe(false);
    expect(assessReplication(contract(), { ...review(), score: 1 }, target()).qualityStatus).not.toBe('accepted');
  });
});


describe('separate music intent follows the upstream default', () => {
  it('does not demand omitted instrumental or vocal music, and does not invent new vocals', () => {
    const c = contract(); delete c.audio.music; delete c.audio.musicEvidence;
    expect(checkReplicationAudio(c, [], { complete: true })).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'music', speech: 'absent' }])).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'music', speech: 'absent' }]).some(p => p.level === 'error')).toBe(true);
    c.audio.sourceSpeech = 'present';
    expect(effectiveTargetSpeech(c)).toBe('absent');
    c.audio.targetSpeech = 'absent';
    expect(parseReplicationContract(c).contract).toBeDefined();
    expect(checkReplicationAudio(c, [], { complete: true })).toEqual([]);
    c.audio.music = 'requested'; c.audio.musicEvidence = [{ kind: 'user', detail: 'Add instrumental music.' }];
    expect(effectiveTargetSpeech(c)).toBe('absent');
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'music', speech: 'absent' }], { complete: true })).toEqual([]);
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'music', speech: 'present' }]).some(p => p.level === 'error')).toBe(true);
  });
  it('requires approval to preserve music and preserves source song facts without authorizing VO', () => {
    const c = contract(); c.audio.sourceSpeech = 'present'; c.audio.narration = 'forbid';
    expect(effectiveTargetSpeech(c)).toBe('present');
    expect(checkReplicationAudio(c, [], { complete: true }).some(p => p.level === 'error')).toBe(true);
    expect(checkReplicationAudio(c, [{ kind: 'sound', role: 'music', speech: 'present' }], { complete: true })).toEqual([]);
    delete c.audio.musicEvidence;
    expect(parseReplicationContract(c).contract).toBeUndefined();
    expect(checkReplicationReadiness(c).some(p => p.at.endsWith('musicEvidence'))).toBe(true);
  });
  it('does not drop source dialogue or effects when music was never requested', () => {
    const c = contract(); c.audio.music = 'none'; c.audio.sourceSpeech = 'present'; c.audio.sourceRoles = ['dialogue', 'music'];
    expect(effectiveTargetSpeech(c)).toBe('present');
    expect(checkReplicationAudio(c, [], { complete: true }).some(p => p.level === 'error')).toBe(true);
    expect(checkReplicationAudio(c, [{ kind: 'native', role: 'dialogue', speech: 'present' }], { complete: true })).toEqual([]);
    c.audio.sourceSpeech = 'absent'; c.audio.sourceRoles = ['effects', 'music'];
    expect(checkReplicationAudio(c, [], { complete: true }).some(p => p.level === 'error')).toBe(true);
  });
});
