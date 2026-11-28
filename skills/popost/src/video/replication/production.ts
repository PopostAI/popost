/** Strict replication preflights. No sidecar means the existing authoring API is unchanged. */
import { z } from 'zod';
import type { Runtime } from '../../runtime';
import { sha256File } from '../../core/util';
import type { Problem, Resolved } from '../types';
import { error } from '../project/check-common';
import { isOutside } from '../project/check';
import type { MaterialRequest } from '../generate/index';
import { evidenceSchema, effectiveTargetSpeech, explicitSpeechOverride, type ReplicationContract, type ReplicationAudioUse } from './contract';
import { checkReplicationAudio, checkReplicationReadiness } from './check';
import { evidenceProblems, readReplication, replicationWithIntent } from './io';

export const AUDIO_FILE = 'replication.audio.json';
export const PLAN_FILE = 'replication.plan.json';
const plannedSpeechRole = (c: ReplicationContract): 'narration' | 'dialogue' =>
  c.audio.narration === 'requested' ? 'narration' : c.audio.sourceRoles.includes('dialogue') ? 'dialogue' :
    c.audio.sourceRoles.includes('narration') ? 'narration' : explicitSpeechOverride(c.audio.userOverride) ? 'dialogue' : 'narration';
const evidence = z.array(evidenceSchema);
const audioSchema = z.object({ version: z.literal(1), items: z.array(z.object({
  file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  kind: z.enum(['speak', 'sound', 'native', 'bed']),
  role: z.enum(['dialogue', 'narration', 'music', 'effects', 'ambient', 'unknown']),
  speech: z.enum(['present', 'absent', 'unknown']), evidence,
})) });
export type ReplicationAudio = z.infer<typeof audioSchema>;

const json = async (rt: Runtime, root: string, file: string): Promise<unknown> => JSON.parse(await rt.fs.readText(rt.path.join(root, file)));
export const readAudio = async (rt: Runtime, root: string): Promise<{ audio?: ReplicationAudio; problems: Problem[] }> => {
  if (!await rt.fs.stat(rt.path.join(root, AUDIO_FILE))) return { problems: [] };
  try {
    const result = audioSchema.safeParse(await json(rt, root, AUDIO_FILE));
    if (!result.success) return { problems: [error(AUDIO_FILE, 'The audio inventory is invalid: ' + result.error.message, 'Declare every real output audio file, role and speech intent.')] };
    const problems = await evidenceProblems(rt, root, result.data);
    for (const item of result.data.items) {
      if (isOutside(item.file)) problems.push(error(AUDIO_FILE, 'An audio file is outside the project.', 'Copy it inside and bind its actual SHA-256.'));
      if (item.role === 'unknown' || item.speech === 'unknown') problems.push(error(AUDIO_FILE, 'An output audio file is still unclassified: ' + item.file, 'Listen to the actual file; ASR text alone is not a voice-role decision.'));
    }
    return { audio: result.data, problems };
  } catch (e) { return { problems: [error(AUDIO_FILE, String(e), 'Correct the inventory and keep its bound files inside the project.')] }; }
};

/** Paid TTS and imported full-length sound use the same source speech intent. */
export const fillReplicationProblems = async (rt: Runtime, referenceDir: string | undefined, assetsDir: string, o: { speak?: boolean; sound?: string; beds?: readonly { footage: string }[]; projectDir?: string }): Promise<Problem[]> => {
  if (!referenceDir) return [];
  const read = await readReplication(rt, referenceDir);
  const problems = [...read.problems];
  if (!read.contract) return problems;
  const project = await readReplication(rt, o.projectDir ?? assetsDir);
  problems.push(...project.problems);
  const assets = o.projectDir && rt.path.resolve(o.projectDir) !== rt.path.resolve(assetsDir) ? await readReplication(rt, assetsDir) : undefined;
  problems.push(...assets?.problems ?? []);
  const matching = project.contract?.source.fingerprint === read.contract.source.fingerprint ? project.contract : assets?.contract;
  const contract = replicationWithIntent(read.contract, matching);
  problems.push(...checkReplicationReadiness(contract));
  const uses: ReplicationAudioUse[] = o.speak ? [{ kind: 'speak', role: 'narration', speech: 'present' }] : [];
  const imported = [...(o.sound ? [o.sound] : []), ...(o.beds ?? []).map(b => b.footage)];
  if (imported.length) {
    const audio = await readAudio(rt, assetsDir);
    problems.push(...audio.problems);
    for (const file of imported) {
      const item = audio.audio?.items.find(a => a.file === file);
      if (!item) problems.push(error(AUDIO_FILE, 'Imported audio has no bound role/speech review: ' + file, 'Record the actual file SHA-256 and audible role before filling; external sound cannot bypass the narration rule.'));
      else uses.push(item);
    }
  }
  return [...problems, ...checkReplicationAudio(contract, uses)];
};

/** Native visible speech cannot bypass the same preflight. Silence remains different from instrumental sound. */
export const materialReplicationProblems = async (rt: Runtime, dir: string, requests: readonly MaterialRequest[]): Promise<{ problems: Problem[]; forbidNewSpeech: boolean; forbidNewNarration: boolean }> => {
  const read = await readReplication(rt, dir);
  if (!read.contract) return { problems: read.problems, forbidNewSpeech: false, forbidNewNarration: false };
  const role = plannedSpeechRole(read.contract);
  const uses: ReplicationAudioUse[] = requests.flatMap(r => r.speech ? [{ kind: 'native' as const, role, speech: 'present' as const }] : []);
  return {
    problems: [...read.problems, ...checkReplicationReadiness(read.contract), ...checkReplicationAudio(read.contract, uses)],
    forbidNewSpeech: read.contract.audio.targetSpeech === 'absent' || (effectiveTargetSpeech(read.contract) === 'absent' && !explicitSpeechOverride(read.contract.audio.userOverride)),
    forbidNewNarration: read.contract.audio.narration === 'forbid' || (read.contract.audio.narration === 'preserve' && !read.contract.audio.sourceRoles.includes('narration')),
  };
};

/** A shared voice may supply visible dialogue or narration; its transport does not choose the audible role. */
export const speechReplicationProblems = async (rt: Runtime, dir: string): Promise<Problem[]> => {
  const read = await readReplication(rt, dir);
  if (!read.contract) return read.problems;
  const role = plannedSpeechRole(read.contract);
  return [...read.problems, ...checkReplicationReadiness(read.contract), ...checkReplicationAudio(read.contract, [{ kind: 'speak', role, speech: 'present' }])];
};

/** Check the resolved audio routes, including implicit native footage sound, against actual files. */
export const outputAudioProblems = async (rt: Runtime, dir: string, c: ReplicationContract, resolved: Resolved): Promise<Problem[]> => {
  const read = await readAudio(rt, dir);
  const problems = [...read.problems];
  const used = [...new Set(resolved.audio.map(a => a.src))];
  for (const file of used) {
    if (!read.audio?.items.some(a => a.file === file)) problems.push(error(AUDIO_FILE, 'An actual resolved audio route is missing from the inventory: ' + file, 'Review this sound/native clip and bind its exact file and role.'));
  }
  const uses = read.audio?.items.filter(a => used.includes(a.file)) ?? [];
  problems.push(...checkReplicationAudio(c, uses, { complete: true }));
  return problems;
};

const planSchema = z.object({ version: z.literal(1), visual: z.object({
  medium: z.string().min(1), style: z.array(z.string().min(1)).min(1), evidence,
  userOverride: z.object({ instruction: z.string().min(1), evidence }).optional(),
}), events: z.array(z.object({
  id: z.string().min(1), segment: z.string().optional(), scene: z.string().optional(),
  span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  method: z.string().min(1), mechanism: z.string().optional(), evidence,
})) });
export type ReplicationPlan = z.infer<typeof planSchema>;

/** Actual compiled starts/offsets own the clock; an old author's cumulative offsets are not authoritative. */
export const outputPlanProblems = async (rt: Runtime, dir: string, c: ReplicationContract, r: Resolved): Promise<Problem[]> => {
  try {
    const parsed = planSchema.safeParse(await json(rt, dir, PLAN_FILE));
    if (!parsed.success) return [error(PLAN_FILE, 'The implementation map is invalid: ' + parsed.error.message, 'Map each required event to its real target frames, scene/segment and drawing method.')];
    const plan = parsed.data, problems = await evidenceProblems(rt, dir, plan);
    const override = plan.visual.userOverride?.evidence.some(e => e.kind === 'user');
    if (plan.visual.medium !== c.visual.medium && !override) problems.push(error(PLAN_FILE + '.visual', 'The target changes the reference visual medium without a user instruction.', 'Preserve the observed medium and finish; failed generation is not permission to substitute a simpler rendering.'));
    if (!override && c.visual.style.some(s => !plan.visual.style.includes(s))) problems.push(error(PLAN_FILE + '.visual.style', 'The implementation drops a required reference style/finish descriptor.', 'Keep the source style constraints distinct from the new content, then verify their real output frames.'));
    for (const event of c.events) {
      const bindings = plan.events.filter(e => e.id === event.id);
      if (bindings.length !== 1) { problems.push(error(PLAN_FILE, 'Required event needs exactly one implementation binding: ' + event.id, 'Map it to the compiled target clock.')); continue; }
      const b = bindings[0]!;
      const segment = b.segment ? r.segments.find(s => s.id === b.segment) : undefined;
      if ((!b.segment && !b.scene) || (b.segment && !segment) || (b.scene && !r.segments.some(s => s.base.kind === 'scene' && s.base.src === b.scene))) problems.push(error(PLAN_FILE, 'The bound scene/segment does not exist: ' + event.id, 'Use timeline output from this exact filled project.'));
      if (b.span[1] <= b.span[0] || b.span[1] > r.frames || (segment && (b.span[0] < segment.start || b.span[1] > segment.end))) problems.push(error(PLAN_FILE, 'Event span is outside its compiled target segment: ' + event.id, 'Recompute target frames after fill, speech retiming or transition edits.'));
      const start = c.scope?.span[0] ?? 0, tolerance = Math.max(2, Math.ceil(r.canvas.fps / c.source.fps));
      if (b.span.some((frame, i) => Math.abs(frame - Math.round((event.span[i]! - start) / c.source.fps * r.canvas.fps)) > tolerance))
        problems.push(error(PLAN_FILE, 'Event timing drifts from the retained reference clock: ' + event.id, 'Use the measured source seconds and actual target FPS; update the whole mapped event after a timeline change.'));
      if (event.mechanism && event.mechanism !== b.mechanism) problems.push(error(PLAN_FILE, 'The text reveal mechanism changes for ' + event.id, 'Keep character/word/digit-roll behavior unless the user explicitly changes it.'));
    }
    return problems;
  } catch (e) { return [error(PLAN_FILE, 'No valid implementation map: ' + String(e), 'Write a mapping from the reference inventory to the actual resolved project before delivery.')]; }
};

export const artifactFacts = async (rt: Runtime, file: string, clock: { fps: number; frames: number }) => ({ fingerprint: await sha256File(rt, file), fps: clock.fps, frames: clock.frames });
