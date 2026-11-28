/**
 * fillTemplate: a template and a fill (a RetargetPlan) become a project. The template is turned back into the inputs
 * a retarget takes and retarget builds the project, so a filled template and a retarget share one implementation of
 * the timing. With speech, the steps of "retarget --speak" run here too (speakRetarget).
 */
import type { Runtime } from '../../runtime';
import { retarget, type RetargetPlan, type RetargetTiming } from '../retarget/index';
import { itemFile } from '../retarget/items';
import { speakRetarget } from '../retarget/speak';
import { commandTranscriber } from '../speech/index';
import type { Problem, Project } from '../types';
import { error } from '../project/check-common';
import { hasErrors, isOutside } from '../project/check';
import { commandSpeaker, type Speaker } from '../voice/index';
import type { Wallet } from '../wallet';
import { checkFill, slotPictures } from './check';
import { clipsOf, dialogueOf, heardShifts } from './speech-rules';
import { writeFacts } from './facts';
import { jsonText, loadTemplate } from './save';
import { retargetInputs, structureMeasure } from './structure';
import type { TemplatePackage } from './types';
import { copyReplication } from '../replication/io';
import { AUDIO_FILE, fillReplicationProblems, readAudio } from '../replication/production';
import { copyReplicationSoundEvidence, REFERENCE_SOUND_RECEIPT } from '../replication/audio-provenance';
import { copyObservedSpeech } from '../replication/speech-observed';

/** The voice track of a spoken fill, relative to the project directory. */
export const VOICE_FILE = 'assets/voice.m4a';
/** The template's structure on the fill's clock, under the name the preview and "compare" look for. */
export const STRUCTURE_FILE = 'reference.measure.json';

/**
 * The steps of "retarget --speak" in one place: every caption line is spoken (with its "say" forms) into its own clip
 * under assets/voice/, time is re-flowed to the clips' lengths, and the clips are laid on one track (VOICE_FILE).
 * The plan's own "sound" (music) stays, under the voice (RetargetInput.music).
 */
export { speakRetarget };

export interface FillOptions {
  templateDir: string;
  fill: RetargetPlan;
  outDir: string;
  /** Speak the captions and re-flow the time to them (needs a speaker: o.speaker, or POPOST_TTS_CMD). */
  speak?: boolean;
  speaker?: Speaker;
  /** With speech: a beat keeps its reference length when its line is shorter, so the video is as long as the template unless a line runs over. */
  hold?: boolean;
  /** With speech: a line that would run over its beat is sped up by at most this much (retarget/tempo.ts). */
  fitTempo?: number;
  /** Where the fill's files are (paths relative to it); they are copied into the project. Default: the project itself. */
  assetsDir?: string;
  /** What popost.ai speech and transcription may spend (wallet.ts); nothing without one. */
  wallet?: Wallet;
  /** The user's words that asked for a narration the reference does not have (speech-rules.ts): it then also reads on-camera lines no clip says. */
  voiceAsked?: string;
}

export interface FillResult {
  project?: Project;
  problems: Problem[];
  notes: string[];
  /** With speech: frames of each spoken line (0 for an empty one), and the re-flow. */
  spoken?: number[];
  timing?: RetargetTiming;
}

const filesOf = (fill: RetargetPlan): string[] =>
  [...new Set([
    ...fill.shots.flatMap((s) => [...('footage' in s ? [s.footage] : 'picture' in s ? [s.picture] : 'scene' in s ? [s.scene] : []), ...(s.items ?? []).map((i) => itemFile(i).file)]),
    ...(fill.sound ? [fill.sound] : []),
  ])];

const copyAssets = async (rt: Runtime, fill: RetargetPlan, from: string, to: string): Promise<void> => {
  if (rt.path.resolve(from) === rt.path.resolve(to)) return;
  // The pictures the fill gives the scenes' picture places are files it names too (checkFill has found them).
  const pictures = (await slotPictures(rt, fill, from)).map((p) => p.file);
  // writeFile creates the parent directories.
  const media = [...new Set([...filesOf(fill), ...clipsOf(fill)])];
  for (const f of new Set([...media, ...pictures])) await rt.fs.writeFile(rt.path.join(to, f), await rt.fs.readFile(rt.path.join(from, f)));
  for (const f of media) {
    for (const ext of ['.sound.json', '.music.json', '.speech.json', '.voice.json', '.words.json']) {
      const receipt = await rt.fs.readFile(rt.path.join(from, f) + ext).catch(() => undefined);
      if (receipt) await rt.fs.writeFile(rt.path.join(to, f) + ext, receipt);
    }
    if (await rt.fs.stat(rt.path.join(from, f) + REFERENCE_SOUND_RECEIPT)) await copyReplicationSoundEvidence(rt, from, to, f);
    await copyObservedSpeech(rt, from, to, f);
  }
  const voices = await rt.fs.stat(rt.path.join(from, 'replication.json')) ? await rt.fs.readText(rt.path.join(from, 'voices.json')).catch(() => undefined) : undefined;
  if (voices) {
    const data = JSON.parse(voices) as { speakers?: { reference?: string }[] };
    for (const speaker of data.speakers ?? []) if (speaker.reference && !isOutside(speaker.reference))
      await rt.fs.writeFile(rt.path.join(to, speaker.reference), await rt.fs.readFile(rt.path.join(from, speaker.reference)));
    await rt.fs.writeFile(rt.path.join(to, 'voices.json'), voices);
  }
};

const merge = (a: Problem[], b: Problem[]): Problem[] => {
  const seen = new Set(a.map((p) => p.level + p.at + p.message));
  return [...a, ...b.filter((p) => !seen.has(p.level + p.at + p.message))];
};

const preflight = async (rt: Runtime, pkg: TemplatePackage, o: Omit<FillOptions, 'templateDir'>): Promise<{ problems: Problem[]; speaker?: Speaker }> => {
  const problems = [...await checkFill(rt, pkg, o.fill, { dir: o.assetsDir ?? o.outDir }),
    ...await fillReplicationProblems(rt, pkg.dir, o.assetsDir ?? o.outDir, { speak: o.speak, sound: o.fill.sound, beds: o.fill.beds, projectDir: o.outDir })];
  if (!o.speak || hasErrors(problems)) return { problems };
  const speaker = o.speaker ?? commandSpeaker(rt, o.wallet);
  if (!speaker) return { problems: [...problems, error('speak', 'Speaking the captions needs a speaker, and none is configured.', 'Connect a popost.ai account with popost auth login (popost: voices need no local tool), or set POPOST_TTS_CMD to a speaker of your own, or fill without --speak.')] };
  if (!(o.fill.captions ?? []).some((l, i) => l.trim() && pkg.template.captions?.beats[i]?.speech !== 'on-camera')) return { problems: [...problems, error('captions', 'There is nothing to speak: the fill has no caption line with words that a voice-over reads.', 'Write the caption lines, or fill without --speak.')] };
  return { problems, speaker };
};

/** A clip item that runs out before its shot ends (template check): measured again after a re-flow, which changes the shot. */
const itemShort = (p: Problem): boolean => /\.items\[\d+\]\.video$/.test(p.at) && p.message.includes('frames of clip');

/** After a re-flow the shots have new lengths: footage is checked again against them. */
const reflowedFootage = async (rt: Runtime, pkg: TemplatePackage, o: Omit<FillOptions, 'templateDir'>, project: Project): Promise<Problem[]> => {
  const lengths = project.segments.map((s) => s.frames ?? 1);
  const again = await checkFill(rt, pkg, o.fill, { dir: o.outDir, lengths });
  // Only the footage that runs out: what the shot's size makes of the material does not change with its length.
  const short = (p: Problem): boolean => (p.level === 'error' && p.at.endsWith('.footage')) || itemShort(p);
  return again.filter(short).map((p) => ({ ...p, level: 'warning' as const, message: 'After the re-flow to the spoken lines: ' + p.message }));
};

/** fillTemplate on a template already loaded. */
export const fillPackage = async (rt: Runtime, pkg: TemplatePackage, o: Omit<FillOptions, 'templateDir'>): Promise<FillResult> => {
  const pre = await preflight(rt, pkg, o);
  if (hasErrors(pre.problems)) return { problems: pre.problems, notes: [] };
  await rt.fs.mkdir(o.outDir);
  if (pkg.dir) {
    const copied = await copyReplication(rt, pkg.dir, o.outDir, { preserveIntent: true, ...(o.assetsDir ? { intentFrom: o.assetsDir } : {}) });
    if (hasErrors(copied)) return { problems: merge(pre.problems, copied), notes: [] };
  }
  if (o.assetsDir) await copyAssets(rt, o.fill, o.assetsDir, o.outDir);
  if (o.assetsDir && rt.path.resolve(o.assetsDir) !== rt.path.resolve(o.outDir)) {
    const audio = await readAudio(rt, o.assetsDir);
    if (audio.audio && !hasErrors(audio.problems)) await rt.fs.writeFile(rt.path.join(o.outDir, AUDIO_FILE), jsonText(audio.audio));
  }
  const inputs = retargetInputs(pkg.template);
  const pace = pkg.slots.voice.pace;
  // The beats a person of a clip says: the voice never reads them (speech-rules.ts).
  const dialogue = await dialogueOf(rt, pkg, o.fill, o.outDir, o.voiceAsked);
  // What the clips really said, when speech-check measured it: their lines' captions follow it.
  const heard = dialogue.length ? await heardShifts(rt, o.fill, o.outDir) : {};
  const input = { measure: inputs.measure, ...(inputs.text ? { text: inputs.text } : {}), ...(inputs.beats ? { beats: inputs.beats } : {}), ...(pace ? { pace } : {}), plan: o.fill, ...(dialogue.length ? { dialogue } : {}), ...(Object.keys(heard).length ? { heard } : {}) };
  const transcriber = commandTranscriber(rt, o.wallet);
  const spoken = pre.speaker ? await speakRetarget(rt, { input, outDir: o.outDir, speaker: pre.speaker, ...(transcriber ? { transcriber } : {}), ...(o.hold ? { hold: true } : {}), ...(o.fitTempo ? { fitTempo: o.fitTempo } : {}) }) : undefined;
  const r = spoken ? spoken.result : retarget(input);
  if (!r.project) return { problems: merge(pre.problems, r.problems), notes: r.notes };
  const later = spoken ? await reflowedFootage(rt, pkg, o, r.project) : [];
  await rt.fs.writeFile(rt.path.join(o.outDir, 'video.json'), jsonText(r.project));
  await rt.fs.writeFile(rt.path.join(o.outDir, STRUCTURE_FILE), jsonText(structureMeasure(pkg.template, r.timing ? { map: r.timing.map, total: r.timing.total } : undefined)));
  // What the checks of the project compare it with, kept in the project (facts.ts).
  await writeFacts(rt, pkg, r.project, o.outDir);
  const notes = [...r.notes, ...(spoken ? ['spoken: ' + spoken.lines.filter((l) => l.file).length + ' lines, ' + (spoken.lines.reduce((n, l) => n + l.frames, 0) / r.project.canvas.fps).toFixed(1) + ' s of speech in ' + VOICE_FILE, ...spoken.notes] : [])];
  return {
    // After a re-flow, a clip item is measured against the shot as it is now, not as the template had it.
    project: r.project, problems: merge(merge(spoken ? pre.problems.filter((p) => !itemShort(p)) : pre.problems, r.problems), later), notes,
    ...(spoken ? { spoken: spoken.lines.map((l) => l.frames) } : {}), ...(r.timing ? { timing: r.timing } : {}),
  };
};

export const fillTemplate = async (rt: Runtime, o: FillOptions): Promise<FillResult> => fillPackage(rt, await loadTemplate(rt, o.templateDir), o);
