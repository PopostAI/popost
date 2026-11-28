/**
 * What a fill may do with a voice, held to the kind of the reference's speech (describe/speech-kind.ts). A voice-over
 * belongs to a re-make only when the reference has narration, or the user asked for one in words that are kept
 * (voice-asked.json in the project). A beat the reference said on camera is said by the person of a generated clip:
 * the voice-over never reads it, and a fill whose clips do not say it is refused. Each refusal is an error with its fix.
 */
import type { Runtime } from '../../runtime';
import { hasNarration, type SpeechFacts } from '../describe/speech-kind';
import type { BeatTimes } from '../generate/dialogue';
import { beatsSaid } from '../generate/index';
import { error } from '../project/check-common';
import { itemFile } from '../retarget/items';
import type { RetargetPlan } from '../retarget/index';
import type { Problem } from '../types';
import { fillStarts } from './structure';
import type { TemplatePackage } from './types';

export const VOICE_ASKED_FILE = 'voice-asked.json';

/** The user's words that asked for a narration, as the project keeps them; undefined when it keeps none. */
export const readVoiceAsked = async (rt: Runtime, project: string): Promise<string | undefined> => {
  const raw = await rt.fs.readText(rt.path.join(project, VOICE_ASKED_FILE)).then((t) => JSON.parse(t) as { asked?: unknown }, () => undefined);
  return typeof raw?.asked === 'string' && raw.asked.trim() ? raw.asked.trim() : undefined;
};

export const recordVoiceAsked = async (rt: Runtime, project: string, asked: string): Promise<void> => {
  await rt.fs.mkdir(project);
  await rt.fs.writeFile(rt.path.join(project, VOICE_ASKED_FILE), JSON.stringify({ version: 1, asked: asked.trim() }, null, 2) + '\n');
};

/** The words given with --voice-asked, else the project's record. An empty quote is no quote. */
export const voiceAskedOf = async (rt: Runtime, given: string | undefined, project: string | undefined): Promise<string | undefined> =>
  given?.trim() ? given.trim() : project === undefined ? undefined : readVoiceAsked(rt, project);

const WHY: Readonly<Record<string, string>> = {
  none: 'nothing is said in it',
  fragments: 'what is said in it are a few exclamations, not a script',
  sung: 'its words are sung, not spoken',
  'on-camera': 'its words are said by people on camera, who speak in the re-make\'s clips',
  unknown: 'its speech was not transcribed, so its kind is unknown, and an unknown kind is treated as no narration',
};

export const VOICE_FIX =
  'Leave the voice out: remove "voice", "speed" and "say" from the fill and run without --voice, --speak, --keep-length, --fit-tempo and --pace; the caption lines are still drawn. '
  + 'Only when the user asked for a narration, add --voice-asked "<the user\'s words that asked for it>".';

/**
 * A voice the reference gives no reason for. speech: the kinds the template (or the described reference) keeps;
 * absent (saved before the kinds existed): nothing is held. wants: where a voice enters, in the caller's words.
 */
export const voiceProblems = (speech: SpeechFacts | undefined, wants: readonly string[], asked: string | undefined): Problem[] => {
  if (!speech || !wants.length || hasNarration(speech) || asked) return [];
  const why = speech.kinds.map((k) => WHY[k] ?? k).join('; ');
  return [error(wants[0] ?? 'voice', 'The reference has no narration (' + why + '), so its re-make has no voice-over; ' + wants.join(' and ') + ' ask' + (wants.length === 1 ? 's' : '') + ' for one.', VOICE_FIX)];
};

/** Where a fill and a command's options ask for a voice. */
export const voiceWanted = (fill: Pick<RetargetPlan, 'voice' | 'say'>, o: { speak?: boolean; voice?: boolean } = {}): string[] => [
  ...(typeof fill.voice === 'string' && fill.voice.trim() ? ['"voice"'] : []),
  ...(Array.isArray(fill.say) && fill.say.length ? ['"say"'] : []),
  ...(o.speak ? ['--speak'] : []),
  ...(o.voice ? ['--voice'] : []),
];

/** The times a clip's lines are read from (generate/dialogue.ts): the template's shots as a fill cuts them, and its beats. */
export const beatTimesOf = (pkg: TemplatePackage): BeatTimes => ({
  fps: pkg.template.canvas.fps,
  shots: fillStarts(pkg.template),
  beats: (pkg.template.captions?.beats ?? []).map((b) => ({ start: b.start, end: b.end, ...(b.speech ? { speech: b.speech } : {}) })),
  kinds: pkg.template.speech !== undefined,
  ...(pkg.slots.voice.pace ? { pace: pkg.slots.voice.pace } : {}),
});

/** The clips a fill shows or sounds: the footage of its shots, their clip items, its beds. */
export const clipsOf = (fill: RetargetPlan): string[] => [...new Set([
  ...fill.shots.flatMap((s) => [...('footage' in s && typeof s.footage === 'string' ? [s.footage] : []), ...(s.items ?? []).flatMap((i) => { const f = itemFile(i); return f.kind === 'video' ? [f.file] : []; })]),
  ...(fill.beds ?? []).flatMap((b) => (typeof b?.footage === 'string' ? [b.footage] : [])),
])];

/** The on-camera beats of the template that have a line in the fill. */
const dialogueBeats = (pkg: TemplatePackage, fill: RetargetPlan): number[] =>
  (pkg.template.captions?.beats ?? []).flatMap((b, i) => (b.speech === 'on-camera' && (fill.captions?.[i] ?? '').trim() ? [i] : []));

/** Whether a clip was made with speech over its whole length: a receipt of the first form of speech, which names no lines. */
const speaksThroughout = async (rt: Runtime, dir: string, file: string): Promise<boolean> => {
  const receipt = await rt.fs.readText(rt.path.resolve(dir, file) + '.speech.json').then((t) => JSON.parse(t) as { mode?: unknown; lines?: unknown[] } | null, () => undefined);
  return !!receipt && typeof receipt.mode === 'string' && !(Array.isArray(receipt.lines) && receipt.lines.length);
};

/**
 * The beats of the fill that a clip of it says, among the template's on-camera beats: those its speech receipt names,
 * and for a clip made with the first form of speech (one speaker's words over the whole clip, no beat named) the
 * on-camera beats that begin in a shot the clip fills.
 */
export const saidByClips = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string): Promise<Map<number, string[]>> => {
  const beats = pkg.template.captions?.beats ?? [];
  const said = new Map([...(await beatsSaid(rt, dir, clipsOf(fill))).entries()].filter(([i]) => beats[i]?.speech === 'on-camera'));
  const starts = fillStarts(pkg.template);
  for (const [k, shot] of fill.shots.entries()) {
    const file = 'footage' in shot && typeof shot.footage === 'string' ? shot.footage : undefined;
    if (file === undefined || !(await speaksThroughout(rt, dir, file))) continue;
    const from = starts[k] ?? 0, to = starts[k + 1] ?? pkg.template.frames;
    beats.forEach((b, i) => { if (b.speech === 'on-camera' && b.start >= from && b.start < to && !said.get(i)?.includes(file)) said.set(i, [...(said.get(i) ?? []), file]); });
  }
  return said;
};

/**
 * The beats the voice-over leaves alone: every on-camera beat, unless the user asked for a narration, which then also
 * reads the on-camera lines no clip says.
 */
export const beatsNotSpoken = (pkg: TemplatePackage, said: ReadonlyMap<number, string[]>, asked: string | undefined): number[] =>
  (pkg.template.captions?.beats ?? []).flatMap((b, i) => (b.speech === 'on-camera' && (!asked || said.has(i)) ? [i] : []));

/** beatsNotSpoken of a fill whose files are in dir. */
export const dialogueOf = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string, asked: string | undefined): Promise<number[]> =>
  beatsNotSpoken(pkg, await saidByClips(rt, pkg, fill, dir), asked);

/**
 * The fill against the on-camera beats, with its files at hand: each such line is said by exactly one clip of the
 * fill. Without a narration the user asked for, a line no clip says is refused: a person who speaks on camera in the
 * reference is never re-made as silent footage with a voice over it.
 */
export const dialogueFillProblems = async (rt: Runtime, pkg: TemplatePackage, fill: RetargetPlan, dir: string, asked: string | undefined): Promise<Problem[]> => {
  const beats = dialogueBeats(pkg, fill);
  if (!beats.length) return [];
  const said = await saidByClips(rt, pkg, fill, dir);
  const twice = beats.filter((i) => (said.get(i)?.length ?? 0) > 1);
  const open = asked ? [] : beats.filter((i) => !said.has(i));
  return [
    ...twice.map((i) => error('captions[' + i + ']', 'Beat ' + i + ' is said by more than one clip of the fill (' + (said.get(i) ?? []).join(', ') + ').', 'Use one clip for the beat; its speech would be heard twice.')),
    ...(open.length ? [error('captions[' + open[0] + ']', 'The reference says beat' + (open.length === 1 ? ' ' : 's ') + open.join(', ') + ' on camera, and no clip of the fill says ' + (open.length === 1 ? 'its line' : 'their lines') + ' (a clip that does has a speech receipt naming the beat).',
      'Make the clip of that shot with the line in its request: "speech": {"mode": "native", "language": "...", "lines": [{"speaker": "...", "text": "...", "beat": ' + open[0] + '}]} (popost video materials --template; video-performers.md), and fill the shot with it. '
      + 'Never replace a person who speaks with silent footage and a voice-over. When the clips cost more than is left of the budget, stop and tell the user the price. Only when the user asked for a narration instead, add --voice-asked "<their words>".')] : []),
  ];
};
