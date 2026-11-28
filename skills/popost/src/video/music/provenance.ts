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

export const MUSIC_PLAN_FILE = 'music-plan.json';
/** generated: one track made for the whole video; own: the user's file; none: no music. */
export interface MusicPlan { version: 1; music: 'generated' | 'own' | 'none'; style?: string }

export const readMusicPlan = async (rt: Runtime, project: string): Promise<MusicPlan | undefined> => {
  const raw = await rt.fs.readText(rt.path.join(project, MUSIC_PLAN_FILE)).then((t) => JSON.parse(t) as Partial<MusicPlan>, () => undefined);
  return raw && (raw.music === 'generated' || raw.music === 'own' || raw.music === 'none') ? { version: 1, music: raw.music, ...(typeof raw.style === 'string' ? { style: raw.style } : {}) } : undefined;
};

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
export const soundSource = async (rt: Runtime, file: string): Promise<'user' | 'generated' | undefined> => {
  const hash = await rt.fs.readFile(file).then(sha256, () => undefined);
  if (hash === undefined) return undefined;
  const read = (ext: string): Promise<{ audioSha256?: unknown } | undefined> => rt.fs.readText(file + ext).then((t) => JSON.parse(t) as { audioSha256?: unknown }, () => undefined);
  if ((await read(MUSIC_RECEIPT))?.audioSha256 === hash) return 'generated';
  return (await read(USER_RECEIPT))?.audioSha256 === hash ? 'user' : undefined;
};

export const SOUND_FIX =
  'Remove it. A video\'s sound is a file the user gave (take it in with: popost video music own --file <their file> --out <project>/assets/<name> --given "<their words that gave it>") '
  + 'or generated music the user agreed to (popost video music make). Never put a narration together with other tools, never mix a track by hand, and never take the sound out of the reference: '
  + 'a voice-over is the fill\'s "voice" (template fill --speak), and only when the reference has narration or the user asked for one.';

/** A sound a fill or a project names that has no record of where it came from. at: the place to report; file: its path in dir. */
export const soundProblems = async (rt: Runtime, dir: string, file: string, at: string): Promise<Problem[]> => {
  const full = rt.path.resolve(dir, file);
  // A missing file is the file check's to report.
  if (!(await rt.fs.stat(full)) || (await soundSource(rt, full))) return [];
  return [error(at, '"' + file + '" has no record of where it came from (no ' + rt.path.basename(file) + USER_RECEIPT + ' of a file the user gave, no ' + rt.path.basename(file) + MUSIC_RECEIPT + ' of generated music, or the file changed after its record was written).', SOUND_FIX)];
};

/** Whether the video gets a music track of its own: the plan says generated or own, or a recorded sound is already in assets/. */
export const hasMusicTrack = async (rt: Runtime, project: string): Promise<boolean> => {
  const plan = await readMusicPlan(rt, project);
  if (plan) return plan.music !== 'none';
  const assets = rt.path.join(project, 'assets');
  const names = (await rt.fs.stat(assets))?.isDirectory ? await rt.fs.readdir(assets) : [];
  return names.some((n) => n.endsWith(MUSIC_RECEIPT) || n.endsWith(USER_RECEIPT));
};
