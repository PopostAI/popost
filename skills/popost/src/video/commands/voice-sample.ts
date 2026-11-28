/**
 * `popost video voice sample`: the one voice reference of a character (voice/sample.ts), cut from a recording the user
 * gave or from an approved clip in which the character speaks, instead of from the registered voice. Every speaking
 * clip of that character then gets this sample as its reference sound, and the voice-over speaks with the same
 * registered voice. Free: it only cuts a file.
 */
import { isFile, printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { voiceProfile } from '../voice/profile';
import { cutSample, SAMPLE_FLOOR, SAMPLE_SECONDS, sampleFile, type VoiceSample } from '../voice/sample';
import { command, userPath, VideoCommandError } from './shared';

const VIDEOS = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];

/** --start and --end as the stretch to cut, or undefined for the cleanest run of speech (sampleStart). */
const stretchOf = (start: number | undefined, end: number | undefined): { at?: number; seconds?: number } => {
  if (start === undefined && end === undefined) return {};
  const at = start ?? 0;
  if (!(at >= 0)) throw new VideoCommandError('--start is the second the sample starts at, 0 or more.');
  if (end === undefined) return { at };
  const seconds = end - at;
  if (!(seconds >= SAMPLE_FLOOR && seconds <= SAMPLE_SECONDS.most))
    throw new VideoCommandError('A voice sample is ' + SAMPLE_FLOOR + ' to ' + SAMPLE_SECONDS.most + ' s of one person speaking (' + SAMPLE_SECONDS.least + ' s or more is best); --start ' + at + ' --end ' + end + ' is ' + seconds.toFixed(2) + ' s. Choose another stretch.');
  return { at, seconds };
};

const sourceKind = (rt: Runtime, file: string): VoiceSample['from'] => (VIDEOS.includes(rt.path.extname(file).toLowerCase()) ? 'clip' : 'file');

export const voiceSampleCommand = command(
  'cut the voice sample of a registered speaker (assets/voices/<id>.sample.wav) from a recording of the user\'s or a clip in which that person speaks; every speaking clip of the speaker gets it as its reference sound. Without --from it is cut from the registered voice; without --start/--end from the cleanest run of speech. Free',
  {
    positionals: [{ name: 'project', help: 'the project directory (voices.json names its speakers)' }],
    options: [
      { flag: '--speaker', required: true, metavar: 'ID', help: 'a speaker registered with popost video voice add or use' },
      { flag: '--from', metavar: 'FILE', help: 'a recording the user gave (audio), or a clip of the project in which this speaker speaks (video)' },
      { flag: '--start', kind: 'number', metavar: 'S', help: 'where the sample starts, in seconds of --from' },
      { flag: '--end', kind: 'number', metavar: 'S', help: 'where it ends; ' + SAMPLE_FLOOR + ' to ' + SAMPLE_SECONDS.most + ' s after --start' },
    ],
  },
  async (args, rt) => {
    const project = userPath(rt, args.req('project')), speaker = args.req('speaker');
    const profile = await voiceProfile(rt, project, speaker).catch((e: unknown) => { throw new VideoCommandError(e instanceof Error ? e.message : String(e)); });
    if (!profile) throw new VideoCommandError('No voice is registered for "' + speaker + '" in ' + project + '. Register it first: popost video voice add ' + args.req('project') + ' --speaker ' + speaker + ' --file <a recording of the user\'s>, or popost video voice use.');
    const given = args.string('from');
    const file = given !== undefined ? userPath(rt, given) : rt.path.resolve(project, profile.reference);
    if (!(await isFile(rt, file))) throw new VideoCommandError('There is no file at ' + file + '. Give a recording of the user\'s or a clip of the project.');
    const stretch = stretchOf(args.number('start'), args.number('end'));
    const from = given === undefined ? 'reference' : sourceKind(rt, file);
    const record = await cutSample(rt, project, profile, { file, from, ...stretch }).catch((e: unknown) => { throw new VideoCommandError(e instanceof Error ? e.message : String(e)); });
    printJson(rt, {
      ok: true, speaker, sample: sampleFile(speaker), record: sampleFile(speaker) + '.json', from: record.from, source: record.source, at: record.at, seconds: record.seconds,
      next: 'Listen to it: one person, clean speech, nothing else. Every clip in which ' + speaker + ' speaks now gets it as the reference of the voice (popost video materials); clips made before keep theirs.',
    });
  },
  (args) => args.string('project'),
);
