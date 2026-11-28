/** Portable reference constraints. Reading media and verifying evidence hashes belong to the caller. */
import { z } from 'zod';
import type { Problem } from '../types';

export const REPLICATION_FILE = 'replication.json';
export const REPLICATION_FORMAT = 'popost-video-replication';
export const PRESENCE = ['present', 'absent', 'unknown'] as const;
export const AUDIO_ROLES = ['dialogue', 'narration', 'music', 'effects', 'ambient', 'unknown'] as const;
export const EVENT_KINDS = ['typing', 'digit-reveal', 'mark', 'camera', 'transition', 'visibility', 'prop-causality', 'action', 'text-reveal', 'comparison'] as const;
export const REVIEW_STATUSES = ['pending', 'passed', 'failed', 'unknown'] as const;

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/i, 'Use the actual media file SHA-256 (64 hexadecimal characters).');
const presence = z.enum(PRESENCE);
const interval = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])
  .refine(v => v[1] >= v[0], 'The end must not precede the start.');
const frameSpan = z.tuple([z.number().int().nonnegative(), z.number().int().positive()])
  .refine(v => v[1] > v[0], 'A reference-frame span is [start, end), with end greater than start.');

export const evidenceSchema = z.strictObject({
  kind: z.enum(['observed', 'measured', 'user', 'unknown']),
  detail: text,
  /** A media/evidence reference, not a declaration that an unchecked file exists. */
  file: text.optional(),
  sha256: hash.optional(),
  media: z.enum(['frame', 'audio', 'video', 'data']).optional(),
  /** A frame of the named video; image evidence is distinguished by its own file hash. */
  frame: z.number().int().nonnegative().optional(),
  /** Seconds on the named evidence file's own clock; a frame may name a single instant. */
  at: interval.optional(),
}).superRefine((v, ctx) => {
  if ((v.sha256 || v.media) && !v.file) ctx.addIssue({ code: 'custom', path: ['file'], message: 'A hash or media type needs an actual evidence file reference.' });
});
export type ReplicationEvidence = z.infer<typeof evidenceSchema>;

const findingSchema = z.strictObject({ status: z.enum(REVIEW_STATUSES), evidence: z.array(evidenceSchema) });
export type ReplicationFinding = z.infer<typeof findingSchema>;

const audioUseSchema = z.strictObject({
  kind: z.enum(['speak', 'sound', 'native', 'bed']),
  role: z.enum(AUDIO_ROLES),
  speech: presence,
  evidence: z.array(evidenceSchema).optional(),
});
export type ReplicationAudioUse = z.infer<typeof audioUseSchema>;

const clockSchema = z.strictObject({ fps: z.number().finite().positive(), frames: z.number().int().positive() });
export type ReplicationClock = z.infer<typeof clockSchema>;
const sourceSchema = clockSchema.extend({ fingerprint: hash });
export type ReplicationSource = z.infer<typeof sourceSchema>;

const reviewSchema = z.strictObject({
  sourceFingerprint: hash,
  sourceRevision: hash.optional(),
  production: z.enum(['planned', 'generating', 'rendered', 'failed']),
  artifactFingerprint: hash.optional(),
  target: clockSchema.optional(),
  audio: findingSchema.optional(),
  visual: findingSchema.optional(),
  events: z.array(findingSchema.extend({ id: text })).optional(),
  /** Include every speech command, external sound, native clip sound and audio bed, or [] for silence. */
  audioUses: z.array(audioUseSchema).optional(),
});
export type ReplicationReview = z.infer<typeof reviewSchema>;

const eventSchema = z.strictObject({
  id: text,
  kind: z.enum(EVENT_KINDS),
  /** The half-open interval on the original reference clock, in reference frames. */
  span: frameSpan,
  objects: z.array(text).min(1),
  description: text,
  /** Reference text may describe timing; it is not an instruction to copy that content. */
  text: text.optional(),
  mechanism: z.enum(['characters', 'words', 'at-once', 'digit-roll']).optional(),
  owner: z.enum(['this', 'before', 'unknown']).optional(),
  states: z.strictObject({ before: text, after: text }).optional(),
  evidence: z.array(evidenceSchema),
});
export type ReplicationEvent = z.infer<typeof eventSchema>;

const contractSchema = z.strictObject({
  format: z.literal(REPLICATION_FORMAT),
  version: z.literal(1),
  source: sourceSchema,
  audio: z.strictObject({
    sourceSpeech: presence,
    sourceRoles: z.array(z.enum(AUDIO_ROLES)),
    /** Optional explicit target: source facts stay unchanged when the user removes or adds speech. */
    targetSpeech: presence.optional(),
    /** No separate soundtrack by default; native clips retain their own sound. */
    music: z.enum(['none', 'preserve', 'requested']).optional(),
    /** Actual user approval for preserving source music or adding a separate new soundtrack. */
    musicEvidence: z.array(evidenceSchema).optional(),
    narration: z.enum(['preserve', 'forbid', 'requested']),
    /** This is an explicit request for new speech, not merely a language preference. */
    userOverride: z.strictObject({ instruction: text, evidence: z.array(evidenceSchema).min(1) }).optional(),
    evidence: z.array(evidenceSchema),
  }),
  visual: z.strictObject({ medium: text, style: z.array(text), evidence: z.array(evidenceSchema) }),
  /** A complete inventory may genuinely contain no temporal events; an unreviewed empty list is not a pass. */
  inventory: z.strictObject({ status: z.enum(['complete', 'unknown']), evidence: z.array(evidenceSchema) }).optional(),
  events: z.array(eventSchema),
  /** No scope means the entire reference; omissions need an explicit reason and evidence. */
  scope: z.strictObject({ span: frameSpan, reason: text, evidence: z.array(evidenceSchema).min(1) }).optional(),
  review: reviewSchema.optional(),
}).superRefine((v, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const ids = new Set<string>();
  const span = v.scope?.span ?? [0, v.source.frames];
  if (span[1] > v.source.frames) issue(['scope', 'span'], 'The retained interval extends beyond the reference.');
  if (v.scope && !knownEvidence(v.scope.evidence)) issue(['scope', 'evidence'], 'A retained interval needs observed, measured or explicit user evidence.');
  v.events.forEach((e, i) => {
    if (ids.has(e.id)) issue(['events', i, 'id'], 'Every required event needs a unique id.');
    ids.add(e.id);
    if (e.span[0] < span[0] || e.span[1] > span[1]) issue(['events', i, 'span'], 'A required event must lie within the explicitly retained reference interval.');
  });
  if (v.audio.targetSpeech === 'absent' && v.audio.narration === 'requested')
    issue(['audio', 'targetSpeech'], 'Speech-absent output cannot request narration.');
  const omittedSong = v.audio.targetSpeech === 'absent' && v.audio.music !== 'preserve' && v.audio.sourceRoles.includes('music') &&
    !v.audio.sourceRoles.some(r => r === 'dialogue' || r === 'narration');
  if (v.audio.targetSpeech && v.audio.targetSpeech !== 'unknown' && v.audio.sourceSpeech !== 'unknown' && v.audio.targetSpeech !== v.audio.sourceSpeech && !omittedSong && !explicitSpeechOverride(v.audio.userOverride))
    issue(['audio', 'userOverride'], 'Changing speech presence needs the explicit user instruction and user evidence.');
  if (v.audio.narration === 'requested' && !explicitSpeechOverride(v.audio.userOverride))
    issue(['audio', 'userOverride'], 'Requested narration needs the explicit speech instruction and user evidence.');
  if (v.audio.music && v.audio.music !== 'none' && !v.audio.musicEvidence?.some(e => e.kind === 'user'))
    issue(['audio', 'musicEvidence'], 'A separate soundtrack needs explicit user music approval evidence.');
  if (v.audio.music === 'preserve' && !v.audio.sourceRoles.includes('music'))
    issue(['audio', 'music'], 'Preserved music must be an observed source audio role.');
});
export type ReplicationContract = z.infer<typeof contractSchema>;

/** Unknown evidence never establishes a source fact, even when its prose says "pass". */
export const knownEvidence = (evidence: readonly ReplicationEvidence[]): boolean => evidence.some(e => e.kind !== 'unknown');
export const explicitSpeechOverride = (override: { instruction: string; evidence: ReplicationEvidence[] } | undefined): boolean =>
  !!override?.instruction.trim() && override.evidence.some(e => e.kind === 'user');

/** Lyrics do not require new spoken lines when no source soundtrack is preserved. */
export const effectiveTargetSpeech = (c: ReplicationContract): typeof PRESENCE[number] => {
  if (c.audio.targetSpeech) return c.audio.targetSpeech;
  if (c.audio.narration === 'requested') return 'present';
  const songOnly = c.audio.sourceSpeech === 'present' && c.audio.sourceRoles.includes('music') &&
    !c.audio.sourceRoles.some(r => r === 'dialogue' || r === 'narration');
  return songOnly && c.audio.music !== 'preserve' ? 'absent' : c.audio.sourceSpeech;
};

const problemsOf = (issues: readonly z.core.$ZodIssue[]): Problem[] => issues.map(i => ({
  level: 'error', at: ['replication', ...i.path].map(String).join('.'), message: i.message,
  fix: 'Correct replication.json using actual reference facts, media evidence and explicit user instructions.',
}));

/** Absence of a sidecar is handled by the caller; malformed or unsupported sidecars are never silently ignored. */
export const parseReplicationContract = (value: unknown): { contract?: ReplicationContract; problems: Problem[] } => {
  const r = contractSchema.safeParse(value);
  return r.success ? { contract: r.data, problems: [] } : { problems: problemsOf(r.error.issues) };
};
export const parseReplicationReview = (value: unknown): { review?: ReplicationReview; problems: Problem[] } => {
  const r = reviewSchema.safeParse(value);
  return r.success ? { review: r.data, problems: [] } : { problems: problemsOf(r.error.issues) };
};
