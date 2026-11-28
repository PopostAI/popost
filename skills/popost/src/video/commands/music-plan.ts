/**
 * `popost video music plan`: the music of a video as agreed with the user (music-plan.json; references/video-sound.md,
 * R2, R4, R5). Without --music it prints the plan on record, or what the reading of the reference proposes. With
 * --music it records the plan, held to the reading: a plan that departs from it needs the user's words (--asked).
 * --clip-music records an exception under which a clip carries music of its own, with its basis and what it rests on.
 * Every answer has `show`: the lines to put in front of the user with the price.
 */
import type { ParsedArgs } from '../../args';
import { printJson } from '../../core/util';
import type { Runtime } from '../../runtime';
import { musicSeconds } from '../music/hosted';
import {
  basisOf, departure, exceptionLines, exceptionProblem, musicOffer, noBedByException, proposal, readingFor, withException, withoutException, WHOLE_VIDEO, type MusicOffer, type Reading,
} from '../music/plan';
import { MUSIC_PLAN_FILE, readMusicPlan, writeMusicPlan, type MusicPlan } from '../music/provenance';
import { parseProject } from '../project/schema';
import { timelineOf } from '../timeline/spans';
import { command, PROJECT_OPTION, userPath, VideoCommandError } from './shared';

/** The length the music would have: the project's video.json, else the reference's, else half a minute (only to price it). */
const lengthOf = async (rt: Runtime, project: string, reading: Reading | undefined): Promise<number> => {
  const raw = await rt.fs.readText(rt.path.join(project, 'video.json')).then((t) => JSON.parse(t) as unknown, () => undefined);
  const parsed = raw === undefined ? undefined : parseProject(raw).project;
  if (parsed) return timelineOf(parsed).total / parsed.canvas.fps;
  return reading?.seconds ?? 30;
};

/** Whether the user gave a sound file of their own (music own wrote its record in assets/). */
const ownFile = async (rt: Runtime, project: string): Promise<boolean> => {
  const assets = rt.path.join(project, 'assets');
  return (await rt.fs.stat(assets))?.isDirectory === true && (await rt.fs.readdir(assets)).some((n) => n.endsWith('.sound.json'));
};

/** The lines for the user: the bed, the exceptions, and why there is no generated bed when there is none. */
const showOf = (plan: MusicPlan, offer?: MusicOffer): string[] => [
  plan.music === 'generated' ? 'Music: one generated bed under the whole video' + (plan.style ? ' (' + plan.style + ')' : '') + (offer?.available ? ', about ' + offer.quote.credits + ' credits' : '') + '; every clip is asked for without music.'
    : plan.music === 'own' ? 'Music: the user\'s own file, as the one bed of the video.' : 'Music: none.',
  ...(plan.unavailable ? [plan.unavailable] : []),
  ...exceptionLines(plan.clipMusic).map((l) => 'Music made by a clip: ' + l + '.'),
];

const answer = (rt: Runtime, project: string, plan: MusicPlan, extra: Record<string, unknown> = {}, offer?: MusicOffer): void =>
  printJson(rt, { ok: true, project, file: rt.path.join(project, MUSIC_PLAN_FILE), plan, show: showOf(plan, offer), ...extra });

/** --clip-music and --drop-clip-music: the exceptions of R4, recorded with their words. */
const exceptions = async (rt: Runtime, args: ParsedArgs, project: string, kept: MusicPlan | undefined): Promise<void> => {
  const drop = args.string('drop-clip-music');
  if (drop !== undefined) {
    if (!kept) throw new VideoCommandError('No music plan is recorded in ' + project + ': there is no exception to drop.');
    const plan = withoutException(kept, drop.trim());
    await writeMusicPlan(rt, project, plan);
    return answer(rt, project, plan);
  }
  const clip = (args.string('clip-music') ?? '').trim();
  const basis = basisOf(args.string('basis') ?? '');
  const why = (args.string('why') ?? '').trim();
  if (!basis) throw new VideoCommandError('--basis names the exception: a letter a to g or its name (a single-clip, b per-segment, c in-scene, d sung, e brand-sting, f own-footage, g user-wish); video-sound.md, R4.');
  if (!why) throw new VideoCommandError('--why quotes what the exception rests on: the words of the reference reading, or the user\'s own words. It is shown to the user with the plan.');
  const wrong = exceptionProblem(basis, clip);
  if (wrong) throw new VideoCommandError(wrong);
  const whole = clip === WHOLE_VIDEO && (basis === 'single-clip' || basis === 'per-segment');
  if (!kept && !whole) throw new VideoCommandError('Record the music plan first (popost video music plan --project ' + args.req('project') + ' --music generated|own|none), then its exceptions.');
  const plan = withException(kept ?? { version: 1, music: 'none' }, { basis, clip, why });
  await writeMusicPlan(rt, project, plan);
  answer(rt, project, plan, noBedByException(plan.clipMusic) ? { note: 'The video has no bed: ' + (basis === 'single-clip' ? 'one continuous clip keeps its own soundtrack.' : 'its clips bring their music segment by segment.') } : {});
};

/** --music: the plan as agreed, held to the reading (R5) and to what can be generated now. */
const record = async (rt: Runtime, args: ParsedArgs, project: string, kept: MusicPlan | undefined, reading: Reading | undefined): Promise<void> => {
  const music = args.string('music') as MusicPlan['music'];
  const asked = args.string('asked')?.trim();
  const noBed = noBedByException(kept?.clipMusic);
  if (music !== 'none' && noBed) throw new VideoCommandError('The plan records "' + noBed.basis + '" for the whole video, which has no bed. Drop it first (--drop-clip-music all) when the plan changed.');
  // Generated music where the reference has none rests on the user's words, before anything is asked of the platform.
  const generatedOff = music === 'generated' ? departure(music, reading, asked) : undefined;
  if (generatedOff) throw new VideoCommandError(generatedOff);
  // Whether a bed can be generated now matters to generated, and to none where the reading has music (none is then no departure).
  const needsOffer = music === 'generated' || (music === 'none' && reading?.facts.music === 'yes' && !asked);
  const offer = needsOffer ? await musicOffer(rt, musicSeconds(await lengthOf(rt, project, reading))) : undefined;
  const unavailable = offer && !offer.available ? offer.why : undefined;
  const off = unavailable ? undefined : departure(music, reading, asked);
  if (off) throw new VideoCommandError(off);
  const style = music === 'generated' && !unavailable ? args.string('style')?.trim() : undefined;
  // Generated music that cannot be made now: no generated bed, said in one line; nothing waits for the generator.
  const plan: MusicPlan = {
    version: 1, music: unavailable ? 'none' : music, ...(style ? { style } : {}), ...(asked ? { asked } : {}),
    ...(reading ? { basis: 'reading: ' + reading.from + ', music ' + reading.facts.music } : {}), ...(kept?.clipMusic ? { clipMusic: kept.clipMusic } : {}), ...(unavailable ? { unavailable } : {}),
  };
  await writeMusicPlan(rt, project, plan);
  answer(rt, project, plan, { note: plan.music === 'none' ? 'The video has no music track: every clip is asked for without music (except under a recorded exception).' : 'The video has one music track over its whole length: popost video materials asks for every clip without music.' }, offer);
};

export const musicPlan = command(
  'the music plan of a video (music-plan.json), from the reading of its reference: one bed (the user\'s file, else generated when the reference has music) or none (video-sound.md, R2 and R5). Without --music it prints the plan, or what the reading proposes; --music records it; --clip-music records an exception under which a clip carries music of its own (R4). Prints "show": the lines for the user with the price',
  {
    options: [
      { ...PROJECT_OPTION, required: true, help: 'the video project the plan is for' },
      { flag: '--reading', metavar: 'DIR', help: 'what describe wrote (its sound.json) or the template; default the template the project was filled from' },
      { flag: '--music', choices: ['generated', 'own', 'none'], help: 'generated: one track made for the whole video (popost video music make); own: the user\'s file (popost video music own); none: no music' },
      { flag: '--style', metavar: 'TEXT', help: 'with generated: the agreed style in plain words (genre, mood, tempo, instruments)' },
      { flag: '--asked', metavar: 'WORDS', help: 'the user\'s own words, when the plan departs from the reading (music where the reference has none, or none where it has some)' },
      { flag: '--clip-music', metavar: 'CLIP', help: 'record an exception: the clip (a path in the project) that carries music of its own, or "all" for the whole video' },
      { flag: '--basis', metavar: 'A..G', help: 'with --clip-music: a single-clip, b per-segment, c in-scene, d sung, e brand-sting, f own-footage, g user-wish' },
      { flag: '--why', metavar: 'WORDS', help: 'with --clip-music: what it rests on, in the words of the reading or of the user' },
      { flag: '--drop-clip-music', metavar: 'CLIP', help: 'remove the exception recorded for this clip (or "all")' },
    ],
  },
  async (args, rt) => {
    const project = userPath(rt, args.req('project'));
    const kept = await readMusicPlan(rt, project);
    const given = args.string('reading');
    const reading = await readingFor(rt, project, given === undefined ? undefined : userPath(rt, given));
    if (given !== undefined && !reading) throw new VideoCommandError('No reading of the sound is in ' + given + ': give what describe wrote (with its sound.json) or a template saved after describe read the sound.');
    if (args.string('clip-music') !== undefined || args.string('drop-clip-music') !== undefined) return exceptions(rt, args, project, kept);
    if (args.string('music') !== undefined) return record(rt, args, project, kept, reading);
    if (kept) return answer(rt, project, kept);
    const own = await ownFile(rt, project);
    const offer = !own && reading?.facts.music === 'yes' ? await musicOffer(rt, musicSeconds(await lengthOf(rt, project, reading))) : undefined;
    const proposed = proposal({ ...(reading ? { reading } : {}), ownFile: own, ...(offer ? { offer } : {}) });
    printJson(rt, {
      ok: true, project, plan: null, proposed, show: [proposed.says], ...(reading ? { reading: reading.from } : { note: 'No reading of the reference\'s sound was found: give --reading <what describe wrote, or the template>.' }),
      next: proposed.music === 'ask' ? 'Ask the user whether the video has music, then record it with --music.' : 'Show the user this plan with the other items and the price; once they agree, record it: popost video music plan --project <dir> --music ' + proposed.music + (proposed.music === 'generated' && 'style' in proposed && proposed.style ? ' --style "' + proposed.style + '"' : '') + '.',
    });
  },
);
