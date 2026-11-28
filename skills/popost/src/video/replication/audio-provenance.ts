/** Strict-only sound origins: authorized reference music or actual registered-voice speech. */
import { z } from 'zod';
import type { Runtime } from '../../runtime';
import { sha256, sha256File } from '../../core/util';
import { runFfmpegOk } from '../media/ffmpeg';
import { isOutside } from '../project/check';
import { error } from '../project/check-common';
import type { Problem } from '../types';
import { checkReplicationAudio, checkReplicationReadiness } from './check';
import { evidenceSchema, REPLICATION_FILE, type ReplicationAudioUse, type ReplicationContract } from './contract';
import { evidenceProblems, readReplication } from './io';

export const REFERENCE_SOUND_RECEIPT = '.replication-sound.json';
const METHOD = 'ffmpeg-pcm-s16le-stereo-48000-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const receiptSchema = z.strictObject({ version: z.literal(1), origin: z.literal('reference'), method: z.literal(METHOD),
  referenceFile: z.string().min(1), sourceFingerprint: hash, audioSha256: hash, pcmSha256: hash,
  given: z.string().trim().min(1), authorizationSha256: hash,
});
export type ReferenceSoundReceipt = z.infer<typeof receiptSchema>;
export type StrictSoundSource = 'reference' | 'registered-voice';
const authorizationHash = (c: ReplicationContract): string => sha256(JSON.stringify((c.audio.musicEvidence ?? []).map(e => {
  const { file: _portablePath, ...bound } = e; return bound;
})));
const issue = (message: string): Problem => error('replication.audio.provenance', message,
  'Keep the actual source, approval and audio hashes, or regenerate speech through its registered voice. Do not relabel extracted sound as a user upload.');
const json = async (rt: Runtime, file: string): Promise<unknown> => JSON.parse(await rt.fs.readText(file));
const localFile = async (rt: Runtime, dir: string, relative: string): Promise<string> => {
  if (isOutside(relative)) throw new Error('The sound origin must be inside the project.');
  const file = rt.path.resolve(dir, relative);
  if (!(await rt.fs.stat(file))?.isFile) throw new Error('The sound origin file is missing: ' + relative);
  if (rt.fs.realpath && isOutside(rt.path.relative(await rt.fs.realpath(dir), await rt.fs.realpath(file))))
    throw new Error('The sound origin resolves outside the project.');
  return file;
};
const preservedMusicProblems = (c: ReplicationContract): Problem[] => {
  const out = checkReplicationReadiness(c);
  if (c.audio.music !== 'preserve' || !c.audio.musicEvidence?.some(e => e.kind === 'user')) out.push(issue('Reference music requires explicit user approval and music=preserve.'));
  if (!c.audio.sourceRoles.includes('music') || c.audio.sourceRoles.some(r => ['dialogue', 'narration', 'unknown'].includes(r)))
    out.push(issue('Only a confirmed music/effects/ambient source soundtrack may be preserved; never copy source dialogue or narration.'));
  return out;
};

/** Hash actual decoded samples, not container metadata or an unverified extraction receipt. */
export const referenceSoundPcmHash = async (rt: Runtime, file: string): Promise<string> => {
  const r = await runFfmpegOk(rt, ['-loglevel', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-']);
  const found = new TextDecoder().decode(r.stdout).trim().match(/^SHA256=([a-f0-9]{64})$/i)?.[1];
  if (!found) throw new Error('The source audio could not be verified as decoded PCM.');
  return found.toLowerCase();
};
// Cache only comparisons performed by this process; a disk receipt never establishes a PCM comparison itself.
const verifiedPcm = new WeakMap<Runtime, Set<string>>();
const comparePcm = async (rt: Runtime, source: string, audio: string, sourceHash: string, audioHash: string, expected: string): Promise<boolean> => {
  const key = [METHOD, sourceHash, audioHash, expected].join(':'), cache = verifiedPcm.get(rt) ?? new Set<string>();
  if (cache.has(key)) return true;
  const a = await referenceSoundPcmHash(rt, source);
  const b = await referenceSoundPcmHash(rt, audio);
  if (a !== b || a !== expected) return false;
  cache.add(key); verifiedPcm.set(rt, cache); return true;
};

/** Create one full-length lossless source soundtrack, with its real authorization and verified source binding. */
export const preserveReferenceSound = async (rt: Runtime, o: { dir: string; reference: string; out: string; given: string }): Promise<ReferenceSoundReceipt> => {
  const read = await readReplication(rt, o.dir);
  if (!o.given.trim()) throw new Error('Quote the actual user approval for preserving the source soundtrack.');
  // This explicit command is the music request. Commit its policy only after the actual extraction is verified.
  const c = read.contract ? { ...read.contract, audio: { ...read.contract.audio, music: 'preserve' as const,
    musicEvidence: [...(read.contract.audio.musicEvidence ?? []), { kind: 'user' as const, detail: o.given.trim() }] } } : undefined;
  const problems = [...read.problems, ...(c ? preservedMusicProblems(c) : [issue('A valid strict replication contract is required.')])];
  if (problems.some(p => p.level === 'error')) throw new Error(problems.map(p => p.message).join(' '));
  if (!c) throw new Error('A valid strict replication contract is required.');
  const output = rt.path.resolve(o.dir, o.out), relative = rt.path.relative(rt.path.resolve(o.dir), output);
  if (!relative || isOutside(relative) || rt.path.extname(output).toLowerCase() !== '.wav') throw new Error('Write a lossless .wav file inside the project.');
  if (output === rt.path.resolve(o.reference)) throw new Error('Do not overwrite the original reference.');
  const sourceHash = await sha256File(rt, o.reference);
  if (sourceHash !== c.source.fingerprint) throw new Error('The actual reference SHA-256 differs from the strict contract.');
  const referenceFile = 'replication-source/' + sourceHash + (rt.path.extname(o.reference).replace(/[^.a-z0-9]/gi, '') || '.bin');
  const source = rt.path.join(o.dir, referenceFile);
  await rt.fs.mkdir(rt.path.dirname(source));
  if (rt.fs.realpath && isOutside(rt.path.relative(await rt.fs.realpath(o.dir), await rt.fs.realpath(rt.path.dirname(source))))) throw new Error('The reference copy resolves outside the project.');
  if (await rt.fs.stat(source)) await localFile(rt, o.dir, referenceFile);
  if (rt.path.resolve(o.reference) !== rt.path.resolve(source)) await rt.fs.writeFile(source, await rt.fs.readFile(o.reference));
  await rt.fs.mkdir(rt.path.dirname(output));
  // Check existing parents before ffmpeg follows a symlink to an output outside the project.
  if (rt.fs.realpath && isOutside(rt.path.relative(await rt.fs.realpath(o.dir), await rt.fs.realpath(rt.path.dirname(output))))) throw new Error('The soundtrack output resolves outside the project.');
  if (await rt.fs.stat(output)) await localFile(rt, o.dir, relative);
  if (rt.path.resolve(source) === output) throw new Error('Do not overwrite the reference.');
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', source, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', output]);
  const audioHash = await sha256File(rt, output), pcmHash = await referenceSoundPcmHash(rt, source);
  if (!await comparePcm(rt, source, output, sourceHash, audioHash, pcmHash)) throw new Error('The extracted soundtrack differs from the actual reference PCM.');
  const receipt: ReferenceSoundReceipt = { version: 1, origin: 'reference', method: METHOD, referenceFile,
    sourceFingerprint: sourceHash, audioSha256: audioHash, pcmSha256: pcmHash, given: o.given.trim(), authorizationSha256: authorizationHash(c) };
  await rt.fs.writeFile(rt.path.join(o.dir, REPLICATION_FILE), JSON.stringify(c, null, 2) + '\n');
  await rt.fs.writeFile(output + REFERENCE_SOUND_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  const inventoryFile = rt.path.join(o.dir, 'replication.audio.json');
  const prior = await rt.fs.stat(inventoryFile) ? await json(rt, inventoryFile) as { version?: number; items?: unknown[] } : { version: 1, items: [] };
  if (prior.version !== 1 || !Array.isArray(prior.items)) throw new Error('The existing strict audio inventory is invalid; the verified extraction is retained.');
  const item = { file: relative, sha256: audioHash, kind: 'sound', role: 'music', speech: c.audio.sourceSpeech,
    evidence: [{ kind: 'measured', detail: 'Full source soundtrack matches actual decoded PCM; reference dialogue/narration is excluded by the confirmed source-role inventory.', file: relative, sha256: audioHash, media: 'audio' }] };
  const items = prior.items.filter(v => !v || typeof v !== 'object' || !('file' in v) || v.file !== relative);
  await rt.fs.writeFile(inventoryFile, JSON.stringify({ version: 1, items: [...items, item] }, null, 2) + '\n');
  return receipt;
};

const useSchema = z.object({ file: z.string(), sha256: hash, kind: z.enum(['speak', 'sound', 'native', 'bed']),
  role: z.enum(['dialogue', 'narration', 'music', 'effects', 'ambient', 'unknown']), speech: z.enum(['present', 'absent', 'unknown']), evidence: z.array(evidenceSchema) });
const inventoryUse = async (rt: Runtime, dir: string, relative: string, actual: string): Promise<ReplicationAudioUse | undefined> => {
  const v = await json(rt, rt.path.join(dir, 'replication.audio.json')) as { version?: number; items?: unknown[] };
  if (v.version !== 1 || !Array.isArray(v.items)) return undefined;
  const parsed = v.items.map(i => useSchema.safeParse(i)).filter(i => i.success).map(i => i.data!);
  const matches = parsed.filter(i => i.file === relative && i.sha256 === actual);
  if (matches.length !== 1) return undefined;
  if ((await evidenceProblems(rt, dir, matches[0])).some(p => p.level === 'error')) return undefined;
  return matches[0];
};

/** Verify strict origins at fill/build. No sidecar means no new legacy authorization route. */
export const checkReplicationSound = async (rt: Runtime, dir: string, file: string): Promise<{ source?: StrictSoundSource; problems: Problem[] }> => {
  const read = await readReplication(rt, dir);
  if (!read.contract) return { problems: read.problems };
  const c = read.contract, problems = [...read.problems, ...checkReplicationReadiness(c)];
  if (problems.some(p => p.level === 'error')) return { problems };
  try {
    const full = await localFile(rt, dir, file), actual = await sha256File(rt, full), use = await inventoryUse(rt, dir, file, actual);
    if (!use) return { problems: [issue('The actual audio file needs exactly one SHA-bound strict inventory entry.')] };
    const intent = checkReplicationAudio(c, [use]);
    if (intent.length) return { problems: intent };
    if (await rt.fs.stat(full + REFERENCE_SOUND_RECEIPT)) {
      const receipt = receiptSchema.parse(await json(rt, full + REFERENCE_SOUND_RECEIPT));
      problems.push(...preservedMusicProblems(c));
      if (use.role !== 'music' || use.speech !== c.audio.sourceSpeech || receipt.sourceFingerprint !== c.source.fingerprint || receipt.audioSha256 !== actual || receipt.authorizationSha256 !== authorizationHash(c))
        problems.push(issue('The reference soundtrack or its approval/role binding changed.'));
      const reference = await localFile(rt, dir, receipt.referenceFile), sourceHash = await sha256File(rt, reference);
      if (sourceHash !== c.source.fingerprint || !await comparePcm(rt, reference, full, sourceHash, actual, receipt.pcmSha256)) problems.push(issue('The soundtrack does not match the actual reference decoded PCM.'));
      return { ...(problems.length ? {} : { source: 'reference' as const }), problems };
    }
    if (await rt.fs.stat(full + '.voice.json')) {
      if (!['dialogue', 'narration'].includes(use.role) || use.speech !== 'present') return { problems: [issue('Registered speech must retain its actual dialogue/narration role.')] };
      const voice = z.object({ version: z.literal(1), speaker: z.string().min(1), text: z.string().trim().min(1), tool: z.string().trim().min(1), audioSha256: hash, voiceReferenceHash: hash }).parse(await json(rt, full + '.voice.json'));
      const voices = z.object({ version: z.literal(1), speakers: z.array(z.object({ id: z.string(), reference: z.string(), sha256: hash, mode: z.enum(['audio-first', 'native-reference']) })) }).parse(await json(rt, rt.path.join(dir, 'voices.json')));
      const registered = voices.speakers.filter(v => v.id === voice.speaker);
      if (registered.length !== 1 || voice.audioSha256 !== actual || registered[0]!.sha256 !== voice.voiceReferenceHash || await sha256File(rt, await localFile(rt, dir, registered[0]!.reference)) !== voice.voiceReferenceHash)
        return { problems: [issue('Registered speech or its shared voice reference changed after synthesis.')] };
      return { source: 'registered-voice', problems: [] };
    }
    return { problems: [] };
  } catch (e) { return { problems: [issue('Strict audio provenance could not be verified: ' + (e instanceof Error ? e.message : String(e)))] }; }
};
export const replicationSoundSource = async (rt: Runtime, dir: string, file: string): Promise<StrictSoundSource | undefined> => {
  const r = await checkReplicationSound(rt, dir, file); return r.problems.length ? undefined : r.source;
};

/** Copy the strict reference receipt and its independent source when a fill copies its audio asset. */
export const copyReplicationSoundEvidence = async (rt: Runtime, from: string, to: string, file: string): Promise<void> => {
  const full = await localFile(rt, from, file), receiptFile = full + REFERENCE_SOUND_RECEIPT;
  if (!await rt.fs.stat(receiptFile)) return;
  const receipt = receiptSchema.parse(await json(rt, receiptFile));
  const source = await localFile(rt, from, receipt.referenceFile);
  if (await sha256File(rt, source) !== receipt.sourceFingerprint || await sha256File(rt, full) !== receipt.audioSha256) throw new Error('Strict source soundtrack changed during copying.');
  await rt.fs.mkdir(rt.path.dirname(rt.path.join(to, receipt.referenceFile)));
  await rt.fs.writeFile(rt.path.join(to, receipt.referenceFile), await rt.fs.readFile(source));
  await rt.fs.writeFile(rt.path.join(to, file) + REFERENCE_SOUND_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
};
