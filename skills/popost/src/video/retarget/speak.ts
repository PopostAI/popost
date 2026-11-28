/**
 * A plan with a voice: the lines of every beat are spoken (a beat the reference only said is spoken and not drawn),
 * time is re-flowed to the spoken lines, the clips are laid on one track, and the words of that track are written token
 * by token: from the speaker's own word times when it gives them, else from a transcript of the mixed voice when a
 * transcriber is available, else spread evenly over each line. With fitTempo, a line that would run over its beat is
 * first sped up a little (tempo.ts). Notes say which lines ran long and what the voice did to the length. The one implementation behind
 * "retarget --speak" and a spoken template fill.
 */
import type { Runtime } from '../../runtime';
import { withTempDir } from '../host';
import { runFfmpegOk } from '../media/ffmpeg';
import { toFrames } from '../speech/index';
import type { Transcriber, Transcript } from '../speech/types';
import { speechPrice } from '../voice/hosted';
import { mixLines, speakLines, speaksHosted, type Speaker, type VoiceLine } from '../voice/index';
import type { PriceItem } from '../wallet';
import { projectFps } from './fps';
import { retarget, spokenForm, type RetargetInput, type RetargetOutput, type RetargetPlan } from './index';
import { overrunNotes } from './pace';
import { unmark } from './marks';
import { fitTempo } from './tempo';
import { voiceWords, type VoiceWords } from './words';
import { writeVoiceReceipt } from '../project/check-sound';

export const VOICE_FILE = 'assets/voice.m4a';
export const WORDS_FILE = 'assets/voice.words.json';

export interface SpokenRetarget { result: RetargetOutput; lines: VoiceLine[]; words?: VoiceWords; notes: string[] }

/** What a transcriber hears in the mixed voice, in project frames. undefined (with a note) when it fails: words are then estimated. */
const hear = (rt: Runtime, voice: string, fps: number, transcriber: Transcriber, language: string | undefined, notes: string[]): Promise<Transcript | undefined> =>
  withTempDir(rt, 'popost-video-voice-', async (dir) => {
    try {
      const wav = rt.path.join(dir, 'voice.wav');
      await runFfmpegOk(rt, ['-y', '-i', voice, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      return toFrames(await transcriber.transcribe(wav, language), fps);
    } catch (e) {
      notes.push('The voice could not be transcribed (' + (e instanceof Error ? e.message.split('\n')[0] : String(e)) + '); word times are spread evenly over each line.');
      return undefined;
    }
  });

/** The speaker's own word times as a transcript on the project's clock, when every spoken line has them. */
const spokenTranscript = (lines: VoiceLine[], starts: number[], fps: number): Transcript | undefined => {
  const spoken = lines.map((l, i) => ({ l, start: starts[i] ?? 0 })).filter((x) => x.l.file);
  if (!spoken.length || spoken.some((x) => !x.l.words?.length)) return undefined;
  return {
    language: '', fps,
    words: spoken.flatMap(({ l, start }) => (l.words ?? []).map((w) => ({ text: w.text, start: start + Math.round(w.start * fps), end: start + Math.max(Math.round(w.start * fps) + 1, Math.round(w.end * fps)), confidence: 1 }))),
  };
};

export interface SpeakOptions {
  input: Omit<RetargetInput, 'spoken' | 'wordsFile'>;
  outDir: string;
  speaker: Speaker;
  transcriber?: Transcriber;
  language?: string;
  /** A beat keeps its reference length when its line is shorter (RetargetInput.spoken.hold). */
  hold?: boolean;
  /** A line that would run over its beat is sped up by at most this much (1.12: hardly heard); undefined: never. */
  fitTempo?: number;
}

/**
 * The lines a plan has spoken, as the voice says them: without their marks (marks.ts; retarget draws them), in their
 * spoken form. dialogue: the beats the person of a clip says, which the voice leaves out ("": not spoken).
 */
export const spokenLinesOf = (plan: RetargetPlan, dialogue: readonly number[] = []): string[] => (plan.captions ?? []).map((l, i) => (dialogue.includes(i) ? '' : spokenForm(unmark(l).text, plan.say)));

/** What speaking a plan costs with popost.ai (free quotes): nothing when a speaker of the user's own speaks its voice. */
export const spokenPrice = (rt: Runtime, plan: RetargetPlan, dialogue: readonly number[] = []): Promise<PriceItem[]> =>
  speaksHosted(rt, plan.voice) ? speechPrice(rt, spokenLinesOf(plan, dialogue), plan.voice) : Promise.resolve([]);

export const speakRetarget = async (rt: Runtime, o: SpeakOptions): Promise<SpokenRetarget> => {
  const { measure, plan } = o.input;
  const notes: string[] = [];
  const fps = projectFps(measure.source.fps);
  // What is said and timed is the line without its marks (marks.ts); retarget draws the marks.
  const captions = (plan.captions ?? []).map((l) => unmark(l).text);
  const said = await speakLines(rt, {
    lines: spokenLinesOf(plan, o.input.dialogue), dir: rt.path.join(o.outDir, 'assets', 'voice'), speaker: o.speaker, fps,
    ...(plan.voice ? { voice: plan.voice } : {}), ...(plan.speed ? { speed: plan.speed } : {}),
  });
  const flow = (ls: VoiceLine[]): RetargetOutput => retarget({ ...o.input, plan: { ...plan, sound: VOICE_FILE }, ...(plan.sound ? { music: plan.sound } : {}), spoken: { frames: ls.map((l) => l.frames), ...(o.hold ? { hold: true } : {}) }, wordsFile: WORDS_FILE });
  const first = flow(said);
  // The beats' lengths do not depend on the voice: the first re-flow gives them, and a line sped up re-flows again.
  const fit = o.fitTempo && first.timing ? await fitTempo(rt, { lines: said, captions, slots: first.timing.slots, max: o.fitTempo, fps }) : undefined;
  const lines = fit?.lines ?? said;
  const result = fit?.tempos.some((t) => t > 1) ? flow(lines) : first;
  if (!result.project || !result.timing) return { result, lines, notes };
  notes.push(...(fit?.notes ?? []));
  const t = result.timing;
  notes.push(...overrunNotes({ lines: captions, slots: t.slots, spoken: lines.map((l) => l.frames), reference: t.reference, total: t.total, fps, ...(plan.speed ? { speed: plan.speed } : {}) }));
  await mixLines(rt, { lines, starts: result.timing.starts, fps, totalFrames: result.timing.total, out: rt.path.join(o.outDir, VOICE_FILE) });
  // The record that this voice is the one the engine spoke and mixed (project/check-sound.ts).
  await writeVoiceReceipt(rt, rt.path.join(o.outDir, VOICE_FILE), lines.filter((l) => l.file).length);
  const own = spokenTranscript(lines, result.timing.starts, fps);
  const transcript = own ?? (o.transcriber ? await hear(rt, rt.path.join(o.outDir, VOICE_FILE), fps, o.transcriber, o.language, notes) : undefined);
  const words = voiceWords({ lines: captions, starts: result.timing.starts, frames: lines.map((l) => l.frames), fps, ...(plan.say ? { say: plan.say } : {}), ...(transcript ? { transcript } : {}) });
  await rt.fs.writeFile(rt.path.join(o.outDir, WORDS_FILE), JSON.stringify({ fps: words.fps, tokens: words.tokens }, null, 1) + '\n');
  notes.push(words.tokens.length + ' word times written to ' + WORDS_FILE + (words.estimated ? ' (estimated: no transcriber, so each line\'s time is shared evenly among its words).' : (own ? ' (the speaker\'s own word times).' : ' (from a transcript of the voice).')));
  return { result, lines, words, notes };
};
