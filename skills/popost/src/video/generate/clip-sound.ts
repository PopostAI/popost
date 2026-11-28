/**
 * The sound of the clips of one materials run (references/video-sound.md): each clip's mode (sound/modes.ts), the
 * recorded exception under which it may carry music, the end of its prompt, the voice samples of its speakers, and
 * what the run says about all of it. makeMaterials asks; this module decides.
 */
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from '../media/ffmpeg';
import { readMusicPlan, type ClipMusicException } from '../music/provenance';
import { BASIS_MEANS, inferMode, musicBasisOf, soundTail, type ClipMusicBasis, type ModeContext, type SoundMode } from '../sound/modes';
import { SAMPLE_FLOOR, sampleSecondsFor, voiceSample } from '../voice/sample';
import type { VoiceProfile } from '../voice/profile';

/** What a request needs here: its file, its prompt's sound fields and its speech. */
interface Asked { file: string; sound?: SoundMode; clipMusic?: ClipMusicBasis; speech?: unknown }

/** A clip of the run that carries music under a recorded exception: shown to the user with the price. */
export interface ClipMusicUse { file: string; basis: ClipMusicBasis; means: string; why: string }

export interface ClipSound {
  /** The exceptions the project's music plan records. */
  exceptions: readonly ClipMusicException[];
  /** The mode of a request, or undefined for a picture, or for a strict re-make whose request names none. */
  modeOf: (r: Asked & { file: string }) => SoundMode | undefined;
  /** The exception under which a clip may carry music (its request's, else the plan's for it or for all). */
  basisOf: (r: Asked) => ClipMusicBasis | undefined;
  /** The end of a clip's prompt for its mode. */
  tailOf: (r: Asked, mode: SoundMode) => string;
  /** The clips of these requests that carry music under an exception. */
  uses: (requests: readonly Asked[]) => ClipMusicUse[];
  /** What the run says about the sound of its clips (notes of materials). */
  notes: string[];
}

const isVideo = (file: string): boolean => /\.(mp4|mov|webm)$/i.test(file);

/**
 * The sound of a run. strict: a strict re-make of a reference keeps the sound its contract plans, so the modes apply
 * only where a request names one. clips: the run makes or has clips. modes: what the reading says (narrated, ambience).
 */
export const clipSoundOf = async (rt: Runtime, dir: string, o: { strict: boolean; clips: boolean; modes?: ModeContext }): Promise<ClipSound> => {
  const plan = await readMusicPlan(rt, dir);
  const exceptions = plan?.clipMusic ?? [];
  const basisOf = (r: Asked): ClipMusicBasis | undefined => musicBasisOf(r, exceptions);
  const why = (r: Asked, basis: ClipMusicBasis): string => (exceptions.find((c) => c.basis === basis && (c.clip === r.file || c.clip === 'all'))?.why ?? '');
  const notes: string[] = [];
  if (o.clips && !o.strict) notes.push('Every clip is asked for by the role of its sound (video-sound.md): a clip with lines for its speaker\'s voice, any other for the sound of its place or without sound, and none with music: the video\'s music is one track'
    + (exceptions.length ? ', except the clips under the exceptions the music plan records (' + exceptions.map((c) => c.clip + ': ' + c.basis).join(', ') + ')' : '') + '. An "exhibit" is left free. A clip that exists already was not made again.');
  if (o.clips && plan?.unavailable) notes.push(plan.unavailable);
  return {
    exceptions,
    modeOf: (r) => (!isVideo(r.file) || (o.strict && r.sound === undefined) ? undefined : inferMode(r, o.modes)),
    basisOf,
    tailOf: (r, mode) => { const basis = basisOf(r); return soundTail(mode, basis ? { music: basis } : {}); },
    uses: (requests) => requests.flatMap((r) => { const basis = isVideo(r.file) && r.sound !== 'silent' ? basisOf(r) : undefined; return basis ? [{ file: r.file, basis, means: BASIS_MEANS[basis], why: why(r, basis) }] : []; }),
    notes,
  };
};

/** Takes the sound track out of a clip, in place (the pictures are copied as they are). */
export const stripSound = async (rt: Runtime, clip: string): Promise<true> => {
  const out = clip + '.mute' + rt.path.extname(clip);
  await runFfmpegOk(rt, ['-y', '-loglevel', 'error', '-i', clip, '-map', '0:v', '-c', 'copy', '-an', '-movflags', '+faststart', out]);
  await rt.fs.rename(out, clip);
  return true;
};

/**
 * The voice samples of a clip's speakers (voice/sample.ts), as paths in the project, with the speakers that have one.
 * A speaker whose registered voice is too short for a sample speaks with the model's own voice, which is said in
 * `notes`, never refused.
 */
export const speakerSamples = async (rt: Runtime, dir: string, file: string, refs: readonly { id: string; profile: VoiceProfile }[], notes: string[]): Promise<{ ids: string[]; samples: string[] }> => {
  const ids: string[] = [], samples: string[] = [];
  for (const v of refs) {
    try {
      samples.push(await voiceSample(rt, dir, v.profile, sampleSecondsFor(refs.length)));
      ids.push(v.id);
    } catch (e) {
      notes.push(file + ': ' + v.id + ' speaks with the video model\'s own voice: no voice sample of ' + SAMPLE_FLOOR + ' s or more could be cut from the registered voice (' + (e instanceof Error ? e.message : String(e)) + ') Cut one with popost video voice sample <project> --speaker ' + v.id + ' --from <a longer recording, or a clip of theirs>.');
    }
  }
  return { ids, samples };
};
