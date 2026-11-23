/**
 * A spoken line fitted to its beat by a small change of tempo (--fit-tempo <max>). A line that would run over its beat
 * is sped up, its pitch kept (ffmpeg atempo), only as far as it needs and never past the cap; what is still over
 * re-flows as before. The word times the speaker gave are scaled with it, and a note says what was done to each line.
 */
import type { Runtime } from '../../runtime';
import { runFfmpegOk } from '../media/ffmpeg';
import { audioSeconds, type VoiceLine } from '../voice/index';
import { LINE_TAIL } from './index';
import { clip } from './pace';

/** The cap to suggest: a line up to 12% faster is hardly heard as faster. */
export const SUGGESTED_TEMPO = 1.12;
/** The highest cap accepted: past it a voice sounds hurried. */
export const MAX_TEMPO = 1.5;

/** Why a cap is refused, or undefined when it is a number from 1 (never faster) to MAX_TEMPO. */
export const tempoCapProblem = (max: number): string | undefined =>
  max >= 1 && max <= MAX_TEMPO ? undefined : '--fit-tempo is the most a line may be sped up: a number from 1 (never) to ' + MAX_TEMPO + '; ' + SUGGESTED_TEMPO + ' is hardly heard.';

/** The tempo that brings a line of `spoken` frames (and its tail) into a beat of `slot` frames, at most `max`; 1 when it fits. */
export const tempoFor = (spoken: number, slot: number, max: number): number => {
  const room = slot - LINE_TAIL;
  if (!spoken || !slot || max <= 1 || spoken <= room) return 1;
  return room > 0 ? Math.min(max, Math.ceil((spoken / room) * 1000) / 1000) : max;
};

/** The clip of a line at a tempo, written over the clip and measured again; the speaker's word times are scaled with it. */
const speedUp = async (rt: Runtime, line: VoiceLine, tempo: number, fps: number): Promise<VoiceLine> => {
  if (!line.file || tempo === 1) return line;
  const faster = line.file.replace(/\.wav$/, '') + '.tempo.wav';
  await runFfmpegOk(rt, ['-y', '-i', line.file, '-af', 'atempo=' + tempo, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', faster]);
  await rt.fs.rename(faster, line.file);
  const frames = Math.max(1, Math.ceil((await audioSeconds(rt, line.file)) * fps));
  return { ...line, frames, ...(line.words ? { words: line.words.map((w) => ({ ...w, start: w.start / tempo, end: w.end / tempo })) } : {}) };
};

const seconds = (frames: number, fps: number): string => {
  const s = frames / fps;
  return (s > 0 && s < 0.1 ? s.toFixed(2) : s.toFixed(1)) + ' s';
};

export interface TempoNotes {
  /** The lines as written, their beats' frames, the frames each was spoken in before and after, and the tempos. */
  captions: string[];
  slots: number[];
  before: number[];
  after: number[];
  tempos: number[];
  max: number;
  fps: number;
}

/** One note per line sped up (how long it was, its beat, the tempo, whether it fits now) and one summary. */
export const tempoNotes = (o: TempoNotes): string[] => {
  const sped = o.tempos.flatMap((t, i) => (t > 1 ? [i] : []));
  const over = (i: number): number => Math.max(0, (o.after[i] ?? 0) + LINE_TAIL - (o.slots[i] ?? 0));
  const lines = sped.map((i) =>
    'captions[' + i + '] "' + clip(o.captions[i] ?? '') + '": spoken ' + seconds(o.before[i] ?? 0, o.fps) + ' in a ' + seconds(o.slots[i] ?? 0, o.fps) + ' beat, sped up ' +
    (o.tempos[i] ?? 1).toFixed(2) + ', ' + (over(i) ? seconds(over(i), o.fps) + ' over.' : 'fits.'));
  const still = sped.filter((i) => over(i) > 0).length;
  const summary = 'fit-tempo ' + o.max + ': ' + (sped.length
    ? sped.length + ' line(s) sped up' + (still ? ', ' + still + ' still over its beat (time re-flows there; move words to a neighbouring beat to keep the length)' : '') + '.'
    : 'every line fits its beat at its own tempo; none was sped up.');
  return [...lines, summary];
};

export interface TempoFit { lines: VoiceLine[]; tempos: number[]; notes: string[] }

/** Speeds up every line that would run over its beat (slots[i]: frames of beat i), by at most `max`. */
export const fitTempo = async (rt: Runtime, o: { lines: VoiceLine[]; captions: string[]; slots: number[]; max: number; fps: number }): Promise<TempoFit> => {
  const tempos = o.lines.map((l, i) => tempoFor(l.frames, o.slots[i] ?? 0, o.max));
  const lines: VoiceLine[] = [];
  for (const [i, line] of o.lines.entries()) lines.push(await speedUp(rt, line, tempos[i] ?? 1, o.fps));
  const notes = tempoNotes({ captions: o.captions, slots: o.slots, before: o.lines.map((l) => l.frames), after: lines.map((l) => l.frames), tempos, max: o.max, fps: o.fps });
  return { lines, tempos, notes };
};
