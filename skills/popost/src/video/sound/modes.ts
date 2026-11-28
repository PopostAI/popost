/**
 * The sound of a generated clip, by its role in the video (references/video-sound.md, rules R2 to R4). Every clip
 * request has one of four modes, written ("sound") or inferred: speech (its person is the video's speaker), exhibit
 * (the clip is the thing shown: its whole sound, music included), ambience (the sound of the place, nobody speaks, no
 * music) or silent (made without a sound track where the model can, else stripped). The mode decides the end of the
 * prompt, and it is kept beside the clip (<file>.mode.json) for the mix. Music made inside a clip is the exception:
 * only an exhibit has it by its mode; any other clip has it only on a basis recorded in the project's music plan.
 */
import type { Runtime } from '../../runtime';
import { error } from '../project/check-common';
import { SOUND_MODES, type Problem, type SoundMode } from '../types';

export { SOUND_MODES, type SoundMode };

/**
 * Why a clip may carry music of its own (R4): each a stated exception, recorded in the project with the reading or
 * the user's words it rests on, and shown to the user with the plan.
 */
export const CLIP_MUSIC_BASES = ['single-clip', 'per-segment', 'in-scene', 'sung', 'brand-sting', 'own-footage', 'user-wish'] as const;
export type ClipMusicBasis = (typeof CLIP_MUSIC_BASES)[number];

export const BASIS_MEANS: Readonly<Record<ClipMusicBasis, string>> = {
  'single-clip': 'the video is one continuous clip with no cut: its own continuous soundtrack stays',
  'per-segment': 'the reference changes its music from segment to segment on purpose (a compilation, chapters; segments of several seconds): each clip brings its own, and the video has no bed',
  'in-scene': 'the music is in the scene: someone plays, a concert, a party, people dancing to a beat',
  sung: 'a person sings, or lip-syncs a song',
  'brand-sting': 'a short brand sting of a second or two',
  'own-footage': 'the user\'s own filmed footage keeps the sound it was filmed with',
  'user-wish': 'the user asked for it in so many words',
};

export const isSoundMode = (v: unknown): v is SoundMode => SOUND_MODES.includes(v as SoundMode);
export const isClipMusicBasis = (v: unknown): v is ClipMusicBasis => CLIP_MUSIC_BASES.includes(v as ClipMusicBasis);

/** What the reading of the reference says about the clips of a re-make: whether a narrator speaks over them, and whether the places are heard. */
export interface ModeContext { narrated?: boolean; ambience?: 'yes' | 'no' | 'unknown' }

/** The context of a template: narrated when its confirmed speech kinds include narration; the ambience its sound reading heard. */
export const modeContextOf = (t: { speech?: { kinds: readonly string[] }; sound?: { ambience: 'yes' | 'no' | 'unknown' } }): ModeContext => ({
  ...(t.speech ? { narrated: t.speech.kinds.includes('narration') } : {}),
  ...(t.sound ? { ambience: t.sound.ambience } : {}),
});

/**
 * The mode of a request: the one it names; else speech for a clip with lines; else, in a re-make of a narrated
 * reference whose places are not heard (B-roll under a narrator), silent; else ambience.
 */
export const inferMode = (r: { sound?: unknown; speech?: unknown }, ctx: ModeContext = {}): SoundMode => {
  if (isSoundMode(r.sound)) return r.sound;
  if (r.speech !== undefined && r.speech !== null) return 'speech';
  return ctx.narrated && ctx.ambience !== 'yes' ? 'silent' : 'ambience';
};

const NO_MUSIC_SENTENCE = 'No background music and no score in this clip: the music of the video is a separate track.';

/**
 * The end of a clip's prompt for its mode. music: the clip may carry music on a recorded basis (R4), which takes the
 * sentence about music out. An exhibit is left free: it is the thing shown, with whatever sound it has.
 */
export const soundTail = (mode: SoundMode, o: { music?: ClipMusicBasis } = {}): string => {
  const music = o.music ? '' : ' ' + NO_MUSIC_SENTENCE;
  if (mode === 'speech') return ' Sound: the speaker\'s voice is the lead of this clip, clear and close, over the quiet ambient sound of the scene.' + music;
  if (mode === 'ambience') return ' Sound: only the ambient sound of the scene and the sounds of what happens in it. Nobody speaks: no dialogue, no narrator, no voice.' + music;
  if (mode === 'silent') return ' The clip is used without its sound: nobody speaks to the camera, and mouths stay closed or turned away.';
  return '';
};

/** An exception recorded in the project's music plan (music/provenance.ts): its basis and the clip it is for ("all": every clip). */
export interface RecordedException { basis: ClipMusicBasis; clip: string }

/** The basis under which a clip may carry music: the one its request names, else the one the plan records for it or for all. */
export const musicBasisOf = (r: { clipMusic?: unknown; file?: unknown }, recorded: readonly RecordedException[]): ClipMusicBasis | undefined => {
  if (isClipMusicBasis(r.clipMusic)) return r.clipMusic;
  return (recorded.find((c) => c.clip === r.file) ?? recorded.find((c) => c.clip === 'all'))?.basis;
};

const speechProblems = (r: { sound?: unknown; speech?: unknown }, at: string): Problem[] => {
  const lines = r.speech !== undefined && r.speech !== null;
  if (r.sound === 'speech' && !lines)
    return [error(at + '.sound', 'A clip whose sound is "speech" says lines, and this request has none.', 'Add "speech" with the lines the person says (video-performers.md), or choose "ambience", "exhibit" or "silent".')];
  if ((r.sound === 'silent' || r.sound === 'ambience') && lines)
    return [error(at + '.sound', 'This clip has lines to say ("speech") and a sound that has no voice ("' + String(r.sound) + '").', 'Remove "sound" (a clip with lines is "speech"), or remove "speech".')];
  return [];
};

/** What is wrong with the sound fields of one request ("sound", "clipMusic"), before anything is paid. recorded: the exceptions of the project's music plan. */
export const modeProblems = (r: { sound?: unknown; clipMusic?: unknown; speech?: unknown; file?: unknown }, at: string, recorded: readonly RecordedException[], isVideo: boolean): Problem[] => {
  const out: Problem[] = [];
  if (r.sound !== undefined && !isSoundMode(r.sound))
    out.push(error(at + '.sound', '"sound" is the role of the clip\'s own sound; it is ' + JSON.stringify(r.sound) + '.', 'Write "speech" (its person is the video\'s speaker), "exhibit" (the clip is the thing shown, with all its sound), "ambience" (the sound of the place, no voice, no music) or "silent" (never heard); or leave it out: a clip with lines is speech, any other ambience.', [...SOUND_MODES]));
  if (!isVideo && (r.sound !== undefined || r.clipMusic !== undefined)) out.push(error(at + '.sound', 'Only a clip has a sound; this request makes a picture.', 'Remove "sound" and "clipMusic".'));
  out.push(...speechProblems(r, at));
  if (r.clipMusic === undefined) return out;
  if (!isClipMusicBasis(r.clipMusic))
    return [...out, error(at + '.clipMusic', '"clipMusic" names why this clip carries music of its own; it is ' + JSON.stringify(r.clipMusic) + '.', 'Write one of the stated exceptions, or remove it: by default a clip has no music and the video has one music track.', [...CLIP_MUSIC_BASES])];
  if (r.sound === 'silent') out.push(error(at + '.clipMusic', 'A silent clip carries no music.', 'Remove "clipMusic", or change "sound".'));
  if (!recorded.some((c) => c.basis === r.clipMusic && (c.clip === r.file || c.clip === 'all')))
    out.push(error(at + '.clipMusic', 'Music inside a clip is an exception that needs its basis on record, and the project records no "' + r.clipMusic + '" (' + BASIS_MEANS[r.clipMusic] + ') for ' + String(r.file) + '.',
      'When the reference reading or the user\'s own words say so, record it and show it to the user with the plan: popost video music plan --project <dir> --clip-music ' + String(r.file) + ' --basis ' + r.clipMusic + ' --why "<what the reading says, or the user\'s words>". Otherwise remove "clipMusic": the clip is made without music and the video\'s music is one track.'));
  return out;
};

const RECEIPT = '.mode.json';

/** What is kept beside a clip about its sound. stripped: its sound track was taken out here (a model that always makes one). */
export interface ModeReceipt { version: 1; sound: SoundMode; clipMusic?: ClipMusicBasis; stripped?: true }

export const writeModeReceipt = (rt: Runtime, clip: string, r: Omit<ModeReceipt, 'version'>): Promise<void> =>
  rt.fs.writeFile(clip + RECEIPT, JSON.stringify({ version: 1, ...r }, null, 2) + '\n');

export const readModeReceipt = async (rt: Runtime, clip: string): Promise<ModeReceipt | undefined> => {
  const raw = await rt.fs.readText(clip + RECEIPT).then((t) => JSON.parse(t) as Partial<ModeReceipt> | null, () => undefined);
  if (!raw || !isSoundMode(raw.sound)) return undefined;
  return { version: 1, sound: raw.sound, ...(isClipMusicBasis(raw.clipMusic) ? { clipMusic: raw.clipMusic } : {}), ...(raw.stripped === true ? { stripped: true } : {}) };
};
