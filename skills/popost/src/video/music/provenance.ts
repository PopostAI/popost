/**
 * Where a video's sound comes from, on record. A fill's "sound" is one of two things: a file the user gave, taken into
 * the project by `popost video music own` (which writes <file>.sound.json: the user's words that gave it, and the
 * file's hash), or the music `popost video music make` wrote (<file>.music.json, music/hosted.ts). Anything else has no
 * record and is refused where a sound enters a project: a narration put together with other tools, a track mixed by
 * hand, the sound cut out of the reference. The music plan agreed with the user (music-plan.json in the project) says
 * before any clip is made whether the video gets a music track of its own.
 */
import { sha256 } from '../../core/util';
import type { Runtime } from '../../runtime';
import { error } from '../project/check-common';
import type { Problem } from '../types';
import { replicationSoundSource, REFERENCE_SOUND_RECEIPT } from '../replication/audio-provenance';
import { isClipMusicBasis, type ClipMusicBasis } from '../sound/modes';

export const MUSIC_PLAN_FILE = 'music-plan.json';
/**
 * A recorded exception to "clips carry no music" (video-sound.md, R4): which exception, and what it rests on, in the
 * words of the reference reading or of the user. It is shown to the user with the plan and its price.
 */
export interface ClipMusicException { basis: ClipMusicBasis; why: string }
/**
 * generated: one track made for the whole video; own: the user's file; none: no music. basis: what the choice rests
 * on (the reference reading, or the user's words). clipMusic: the recorded exceptions under which clips carry music.
 */
export interface MusicPlan { version: 1; music: 'generated' | 'own' | 'none'; style?: string; basis?: string; clipMusic?: ClipMusicException[] }

export const readMusicPlan = async (rt: Runtime, project: string): Promise<MusicPlan | undefined> => {
  const raw = await rt.fs.readText(rt.path.join(project, MUSIC_PLAN_FILE)).then((t) => JSON.parse(t) as Partial<MusicPlan>, () => undefined);
  if (!raw || !(raw.music === 'generated' || raw.music === 'own' || raw.music === 'none')) return undefined;
  const clipMusic = (Array.isArray(raw.clipMusic) ? raw.clipMusic : []).filter((c): c is ClipMusicException => isClipMusicBasis(c?.basis) && typeof c.why === 'string' && c.why.trim() !== '');
  return { version: 1, music: raw.music, ...(typeof raw.style === 'string' ? { style: raw.style } : {}), ...(typeof raw.basis === 'string' && raw.basis.trim() ? { basis: raw.basis.trim() } : {}), ...(clipMusic.length ? { clipMusic } : {}) };
};

/** The exceptions a project records for music inside its clips. */
export const clipMusicBases = async (rt: Runtime, project: string): Promise<ClipMusicBasis[]> => ((await readMusicPlan(rt, project))?.clipMusic ?? []).map((c) => c.basis);

export const writeMusicPlan = async (rt: Runtime, project: string, plan: MusicPlan): Promise<void> => {
  await rt.fs.mkdir(project);
  await rt.fs.writeFile(rt.path.join(project, MUSIC_PLAN_FILE), JSON.stringify(plan, null, 2) + '\n');
};

const USER_RECEIPT = '.sound.json';
const MUSIC_RECEIPT = '.music.json';
/** A video is not a sound file: the sound of a reference or of another video is never taken as a video's music. */
const VIDEO_FILES = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];

export interface UserSound { version: 1; source: 'user'; given: string; from: string; audioSha256: string }

/** Takes a sound file the user gave into the project, with the record that says so. given: the user's words that gave it. */
export const ownSound = async (rt: Runtime, o: { file: string; out: string; given: string }): Promise<UserSound> => {
  if (!o.given.trim()) throw new Error('--given quotes the user\'s words that gave this file (their message, or what they called it).');
  if (VIDEO_FILES.includes(rt.path.extname(o.file).toLowerCase())) throw new Error(rt.path.basename(o.file) + ' is a video, not a sound file. The sound of a reference or of another video is never taken as this video\'s sound: use a sound file the user gave, generated music (popost video music make), or none.');
  if (await rt.fs.stat(o.file + '.voice.json')) throw new Error(rt.path.basename(o.file) + ' is speech made by a voice tool, not a sound file of the user\'s. A voice-over is the fill\'s "voice", spoken by template fill --speak.');
  const bytes = await rt.fs.readFile(o.file);
  const receipt: UserSound = { version: 1, source: 'user', given: o.given.trim(), from: rt.path.basename(o.file), audioSha256: sha256(bytes) };
  await rt.fs.mkdir(rt.path.dirname(o.out));
  if (rt.path.resolve(o.file) !== rt.path.resolve(o.out)) await rt.fs.writeFile(o.out, bytes);
  await rt.fs.writeFile(o.out + USER_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
};

/** Where a sound file of a project comes from by its record, or undefined when it has none (or the file changed since). */
export const soundSource = async (rt: Runtime, file: string, project?: string): Promise<'user' | 'generated' | 'reference' | undefined> => {
  const hash = await rt.fs.readFile(file).then(sha256, () => undefined);
  if (hash === undefined) return undefined;
  const read = (ext: string): Promise<{ audioSha256?: unknown } | undefined> => rt.fs.readText(file + ext).then((t) => JSON.parse(t) as { audioSha256?: unknown }, () => undefined);
  if ((await read(MUSIC_RECEIPT))?.audioSha256 === hash) return 'generated';
  if ((await read(USER_RECEIPT))?.audioSha256 === hash) return 'user';
  if (project && await replicationSoundSource(rt, project, rt.path.relative(project, file)) === 'reference') return 'reference';
  return undefined;
};

export const SOUND_FIX =
  'Remove it. A video\'s sound is a file the user gave (take it in with: popost video music own --file <their file> --out <project>/assets/<name> --given "<their words that gave it>") '
  + 'or generated music the user agreed to (popost video music make). Never put a narration together with other tools, never mix a track by hand, and never take the sound out of the reference: '
  + 'a voice-over is the fill\'s "voice" (template fill --speak), and only when the reference has narration or the user asked for one. '
  + 'An explicitly approved strict reference soundtrack uses video replication sound, which verifies the actual source and decoded audio instead of calling it a user upload.';

/** A sound a fill or a project names that has no record of where it came from. at: the place to report; file: its path in dir. */
export const soundProblems = async (rt: Runtime, dir: string, file: string, at: string): Promise<Problem[]> => {
  const full = rt.path.resolve(dir, file);
  // A missing file is the file check's to report.
  if (!(await rt.fs.stat(full)) || (await soundSource(rt, full, dir))) return [];
  return [error(at, '"' + file + '" has no record of where it came from (no ' + rt.path.basename(file) + USER_RECEIPT + ' of a file the user gave, no ' + rt.path.basename(file) + MUSIC_RECEIPT + ' of generated music, or the file changed after its record was written).', SOUND_FIX)];
};

/** Whether the video gets a music track of its own: the plan says generated or own, or a recorded sound is already in assets/. */
export const hasMusicTrack = async (rt: Runtime, project: string): Promise<boolean> => {
  const assets = rt.path.join(project, 'assets');
  const names = (await rt.fs.stat(assets))?.isDirectory ? await rt.fs.readdir(assets) : [];
  for (const name of names.filter(n => n.endsWith(REFERENCE_SOUND_RECEIPT))) {
    const file = rt.path.join(assets, name.slice(0, -REFERENCE_SOUND_RECEIPT.length));
    if (await soundSource(rt, file, project) === 'reference') return true;
  }
  const plan = await readMusicPlan(rt, project);
  if (plan) return plan.music !== 'none';
  return names.some((n) => n.endsWith(MUSIC_RECEIPT) || n.endsWith(USER_RECEIPT));
};
